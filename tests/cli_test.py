#!/usr/bin/env python3
"""The terminal client, end to end: two processes talking to each other."""

import base64, hashlib, json, os, pty, re, select, shutil, signal, socket, subprocess, sys, tempfile, time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "neverstored")
CLI = os.path.join(ROOT, "cli", "neverstored")

failures = []


def check(name, condition, detail=""):
    print(("  ok   " if condition else "  FAIL ") + name + ("" if condition else ": " + detail))
    if not condition:
        failures.append(name)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(port):
    for _ in range(200):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=5)
            return True
        except Exception:
            time.sleep(0.05)
    return False


class Client:
    """One CLI process. Answers on stdin, watched through its stderr."""

    def __init__(self, url, args, answer="y\n", trace=None):
        command = [CLI] + args + ["--no-qr"]
        if trace:
            command = ["strace", "-f", "-s", "200", "-e", "trace=openat,creat", "-o", trace] + command

        self.process = subprocess.Popen(
            command, env=dict(os.environ, NEVERSTORED_URL=url),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        if answer is None:
            self.process.stdin.close()
        else:
            self.process.stdin.write(answer.encode())
            self.process.stdin.flush()

        self.out = b""
        self.err = b""

    def finish(self, timeout=30):
        try:
            self.out, self.err = self.process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.out, self.err = self.process.communicate()
        return self.process.returncode


def link_from(client, timeout=15):
    """Reads the room link off the client's stderr without consuming the rest."""
    deadline = time.time() + timeout
    seen = b""
    os.set_blocking(client.process.stderr.fileno(), False)

    while time.time() < deadline:
        chunk = client.process.stderr.read()
        if chunk:
            seen += chunk
            found = re.search(rb"http://\S+/r/[A-Za-z0-9_-]{22}", seen)
            if found:
                os.set_blocking(client.process.stderr.fileno(), True)
                client.err += seen
                return found.group().decode()
        time.sleep(0.1)

    os.set_blocking(client.process.stderr.fileno(), True)
    client.err += seen
    return None


class Proxy:
    """Stands between one client and the server and loses things on request: a connection
    that drops, a reply that never comes back, an answer the server did not give."""

    def __init__(self, upstream_port):
        import http.client, http.server, threading

        proxy = self
        self.down_until = 0.0
        self.down_after = {}    # op -> seconds the connection stays down once op went through
        self.lose = {}          # op -> how many replies to swallow after forwarding
        self.lose_payload = 0   # polls carrying a ciphertext whose reply is swallowed
        self.fake = {}          # op -> reply given instead of forwarding

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                op = self.path.rsplit("/", 1)[-1]
                body = self.rfile.read(int(self.headers.get("content-length", 0)))

                if time.time() < proxy.down_until:
                    self.close_connection = True
                    return

                if op in proxy.fake:
                    return self.answer(200, json.dumps(proxy.fake[op]).encode())

                upstream = http.client.HTTPConnection("127.0.0.1", upstream_port, timeout=10)
                upstream.request("POST", self.path, body, {"content-type": "application/json"})
                response = upstream.getresponse()
                status, reply = response.status, response.read()
                upstream.close()

                if op in proxy.down_after:
                    proxy.down_until = time.time() + proxy.down_after.pop(op)

                if proxy.lose.get(op, 0) > 0:
                    proxy.lose[op] -= 1
                    self.close_connection = True
                    return

                if op == "poll" and proxy.lose_payload > 0 and b'"ct"' in reply:
                    proxy.lose_payload -= 1
                    self.close_connection = True
                    return

                self.answer(status, reply)

            def answer(self, status, reply):
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(reply)))
                self.send_header("connection", "close")
                self.end_headers()
                self.wfile.write(reply)
                self.close_connection = True

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def on_a_terminal(url, secret_file):
    """The interactive path: a person watching, answering on the terminal."""
    master, slave = pty.openpty()
    asker = subprocess.Popen([CLI, "ask", "--no-qr"], env=dict(os.environ, NEVERSTORED_URL=url),
                             stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)

    seen = b""
    link = None
    deadline = time.time() + 15

    while time.time() < deadline and link is None:
        if select.select([master], [], [], 0.3)[0]:
            seen += os.read(master, 65536)
            found = re.search(rb"http://\S+/r/[A-Za-z0-9_-]{22}", seen)
            link = found.group().decode() if found else None

    if link is None:
        asker.kill()
        os.close(master)
        return seen.decode("utf-8", "replace").replace("\r\n", "\n")

    writer = Client(url, ["open", link, "--file", secret_file])
    deadline = time.time() + 20
    answered = False

    while time.time() < deadline and asker.poll() is None:
        if select.select([master], [], [], 0.3)[0]:
            try:
                seen += os.read(master, 65536)
            except OSError:
                break

        if not answered and b"They match" in seen:
            os.write(master, b"y\n")
            answered = True

    writer.finish()
    if asker.poll() is None:
        asker.kill()
    os.close(master)

    # A pty turns every newline into CRLF; normalise so the checks read naturally.
    return seen.decode("utf-8", "replace").replace("\r\n", "\n")


def main():
    for binary in (SERVER, CLI):
        if not os.path.exists(binary):
            print("build first: dub build && cd cli && dub build")
            return 1

    port = free_port()
    workdir = tempfile.mkdtemp(prefix="neverstored-cli-test-")
    url = "http://127.0.0.1:%d" % port
    env = dict(os.environ, NEVERSTORED_PORT=str(port), NEVERSTORED_NO_PROXY="1",
               NEVERSTORED_SOCKET=os.path.join(workdir, "broker.sock"))
    server = subprocess.Popen([SERVER], env=env, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, start_new_session=True)

    SECRET = "prod-db: Ub3rSecret!2026\nsecond line\tcon àccento ✓"
    secret_file = os.path.join(workdir, "secret.txt")
    with open(secret_file, "w") as handle:
        handle.write(SECRET)

    pizza_file = os.path.join(workdir, "pizza.txt")
    with open(pizza_file, "w") as handle:
        handle.write("pizza")

    try:
        if not wait_for(port):
            print("server did not start")
            return 1

        print("handing a secret over")
        trace = os.path.join(workdir, "strace.txt")
        sender = Client(url, ["send", "--file", secret_file], trace=trace)
        link = link_from(sender)
        check("the sender prints a room link", link is not None, sender.err.decode()[:200])

        receiver = Client(url, ["open", link])
        received = receiver.finish()
        sent = sender.finish()

        check("the recipient exits cleanly", received == 0, str(received))
        check("the sender exits cleanly", sent == 0, str(sent))
        check("and is told it was picked up, not that it was read",
              b"Picked up by their device." in sender.err, sender.err.decode()[-200:])
        check("the secret arrives byte for byte", receiver.out.decode() == SECRET,
              repr(receiver.out.decode()[:80]))
        check("nothing but the secret goes to stdout", sender.out == b"", repr(sender.out[:80]))

        symbols = re.findall(rb"^   \S+  (\w+)$", sender.err, re.M)
        peer_symbols = re.findall(rb"^   \S+  (\w+)$", receiver.err, re.M)
        check("both terminals show the same four symbols",
              len(symbols) == 4 and symbols == peer_symbols,
              str(symbols) + " vs " + str(peer_symbols))

        print("\nasking someone for a secret")
        asker = Client(url, ["ask"])
        link = link_from(asker)
        check("asking also prints a link", link is not None, asker.err.decode()[:200])

        writer = Client(url, ["open", link, "--file", secret_file])
        wrote = writer.finish()
        asked = asker.finish()

        check("the writer exits cleanly", wrote == 0, str(wrote))
        check("the asker exits cleanly", asked == 0, str(asked))
        check("the asker receives what was written", asker.out.decode() == SECRET,
              repr(asker.out.decode()[:80]))

        # With nothing to read the secret from, the writer sits on stdin after confirming,
        # which leaves the asker in the one state where it says what it is waiting for.
        print("\nwaiting to be sent something")
        asker = Client(url, ["ask"])
        link = link_from(asker)
        stuck = Client(url, ["open", link])
        asker.finish(timeout=4)
        stuck.finish(timeout=4)

        told = asker.err.decode("utf-8", "replace")
        check("the one waiting is told in the same words the page uses",
              "Both confirmed. Waiting for them to send it." in told, told[-200:])
        check("and is never asked about handing anything over",
              "hand it over" not in told and "handed over" not in told, told[-200:])

        print("\nsaying no, and other endings")
        sender = Client(url, ["send", "--file", secret_file])
        link = link_from(sender)
        refuser = Client(url, ["open", link], answer="n\n")
        refused = refuser.finish()
        senderEnd = sender.finish()

        check("refusing the symbols exits 1", refused == 1, str(refused))
        check("and nothing is delivered", refuser.out == b"", repr(refuser.out[:80]))
        check("the other side is told the room is gone", senderEnd == 2, str(senderEnd))

        silent = Client(url, ["send", "--file", secret_file])
        link = link_from(silent)
        mute = Client(url, ["open", link], answer=None)
        muted = mute.finish()
        silent.process.send_signal(signal.SIGINT)
        silent.finish()
        check("an unanswered question is a refusal, not a yes", muted == 1, str(muted))

        missing = Client(url, ["open", "AAAAAAAAAAAAAAAAAAAAAA"])
        check("a room that is not there exits 2", missing.finish() == 2)

        bad = Client(url, ["open", "not-a-link"])
        check("a link that is not one exits 4", bad.finish() == 4)

        nothing = Client(url, ["open"])
        check("a missing argument exits 4", nothing.finish() == 4)

        elsewhere = Client("http://127.0.0.1:1", ["send", "--file", secret_file])
        check("an unreachable service exits 3", elsewhere.finish() == 3)

        lonely = Client(url, ["send", "--file", secret_file, "--wait", "1"])
        check("waiting alone gives up with 2", lonely.finish() == 2)

        big_file = os.path.join(workdir, "big.bin")
        with open(big_file, "wb") as handle:
            handle.write(b"x" * (9 * 1024))

        holder = Client(url, ["send", "--file", big_file])
        link = link_from(holder)
        joiner = Client(url, ["open", link])
        refused_size = holder.finish()
        joiner.finish()

        check("a secret past the limit is refused before it leaves", refused_size == 4,
              str(refused_size))
        check("and the refusal says why", b"not for files" in holder.err, holder.err.decode()[-200:])

        print("\na key that cannot exist")

        # Nobody sends a key off the curve by accident, and the page now says so outright.
        # The terminal must not file the same thing under "something went wrong".
        def api(op, body):
            return json.load(urllib.request.urlopen(urllib.request.Request(
                url + "/api/" + op, method="POST", headers={"content-type": "application/json"},
                data=json.dumps(body).encode()), timeout=5))

        bogus = b"A" * 65
        forged = api("create", {"flow": "send",
                                "commit": base64.b64encode(hashlib.sha256(bogus).digest()).decode()})

        tampered = Client(url, ["open", url + "/r/" + forged["id"]])
        for _ in range(100):
            if api("poll", {"id": forged["id"], "token": forged["token"], "v": 0}).get("state") == "paired":
                break
            time.sleep(0.1)
        api("reveal", {"id": forged["id"], "token": forged["token"],
                       "pub": base64.b64encode(bogus).decode()})
        code = tampered.finish()
        told = tampered.err.decode()
        check("the terminal refuses a key that is not on the curve", code != 0, str(code))
        check("and says it is interference, not a glitch",
              re.search(r"tamper|interfer", told, re.I) is not None, told.strip()[-200:])
        check("and says it without jargon",
              re.search(r"curve|point", told, re.I) is None, told.strip()[-200:])
        check("and prints nothing to stdout", tampered.out == b"", repr(tampered.out[:80]))

        print("\na connection that misbehaves")

        # A server that accepts and never answers is what a dead mobile link looks like from
        # this side. Without a deadline of its own the client waits on curl's, which is minutes.
        silent_server = socket.socket()
        silent_server.bind(("127.0.0.1", 0))
        silent_server.listen(16)
        silent_url = "http://127.0.0.1:%d" % silent_server.getsockname()[1]

        started = time.time()
        hung = Client(silent_url, ["open", "AAAAAAAAAAAAAAAAAAAAAA"])
        hung_code = hung.finish(timeout=60)
        hung_for = time.time() - started
        check("a server that never answers is given up on within half a minute",
              hung_code == 3 and hung_for < 30, "exit %s after %.0fs" % (hung_code, hung_for))

        started = time.time()
        stopped = Client(silent_url, ["open", "AAAAAAAAAAAAAAAAAAAAAA"])
        time.sleep(1)
        stopped.process.send_signal(signal.SIGINT)
        stopped_code = stopped.finish(timeout=60)
        stopped_for = time.time() - started
        check("Ctrl-C stops a request that is waiting for an answer",
              stopped_for < 5, "exit %s after %.0fs" % (stopped_code, stopped_for))
        check("and says the exchange is over, not that the service is down", stopped_code == 2,
              str(stopped_code))
        silent_server.close()

        # The question about the symbols is a read on the terminal. Ctrl-C there used to be
        # swallowed, because the read simply started over, until someone pressed enter.
        master, slave = pty.openpty()
        prompted = subprocess.Popen([CLI, "send", "--file", pizza_file, "--no-qr"],
                                    env=dict(os.environ, NEVERSTORED_URL=url),
                                    stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        seen = b""
        other = None
        deadline = time.time() + 20
        while time.time() < deadline and b"They match" not in seen:
            if select.select([master], [], [], 0.3)[0]:
                try:
                    seen += os.read(master, 65536)
                except OSError:
                    break
            found = re.search(rb"http://\S+/r/[A-Za-z0-9_-]{22}", seen)
            if found and other is None:
                other = Client(url, ["open", found.group().decode()], answer="")

        prompted.send_signal(signal.SIGINT)
        try:
            prompted_code = prompted.wait(timeout=5)
        except subprocess.TimeoutExpired:
            prompted.kill()
            prompted_code = None
        os.close(master)
        check("Ctrl-C at the question about the symbols ends the exchange",
              prompted_code is not None, seen.decode("utf-8", "replace")[-200:])
        if other is not None:
            other.finish(timeout=10)

        # A moment without a connection is a moment, not the end of the exchange: the page
        # keeps trying, and so must the terminal.
        blip = Proxy(port)
        blip.down_after["join"] = 4
        sender = Client(url, ["send", "--file", secret_file])
        link = link_from(sender)
        patient = Client(blip.url, ["open", link])
        patient_code = patient.finish(timeout=60)
        sender.finish(timeout=10)
        blip.close()
        check("a few seconds without a connection do not end the exchange",
              patient_code == 0 and patient.out.decode() == SECRET,
              "exit %s: %s" % (patient_code, patient.err.decode()[-200:]))

        # A delivery that landed and whose answer was lost is a secret that will arrive. The
        # sender used to say nothing was delivered, while the other side was reading it.
        lossy = Proxy(port)
        lossy.lose["deliver"] = 1
        sender = Client(lossy.url, ["send", "--file", secret_file])
        link = link_from(sender)
        receiver = Client(url, ["open", link])
        received = receiver.finish(timeout=30)
        sent = sender.finish(timeout=30)
        lossy.close()
        check("the secret still arrives when the sender never hears back",
              received == 0 and receiver.out.decode() == SECRET, str(received))
        check("and the sender does not claim it was not delivered",
              b"Nothing was delivered" not in sender.err, sender.err.decode()[-200:])
        check("but waits to see it picked up", sent == 0, "exit %s: %s" % (sent, sender.err.decode()[-200:]))

        # The poll that carries the ciphertext burns the room. Its answer lost, the secret is
        # gone, and calling that "nothing was sent" would be a lie the sender can disprove.
        robbed = Proxy(port)
        robbed.lose_payload = 1
        sender = Client(url, ["send", "--file", secret_file])
        link = link_from(sender)
        receiver = Client(robbed.url, ["open", link])
        robbed_code = receiver.finish(timeout=30)
        sender.finish(timeout=30)
        robbed.close()
        told = receiver.err.decode()
        check("a secret lost on its way here is not reported as never sent",
              "Nothing was sent" not in told and re.search(r"lost", told) is not None,
              told.strip()[-200:])
        check("and does not exit as if it had arrived", robbed_code not in (0, None), str(robbed_code))

        # The second confirmation is the one that makes the room ready. Its answer lost, the
        # repeat is refused because there is nothing left to confirm, and that refusal must not
        # be taken for a failure: the room is fine, and closing it would throw it away.
        second = Proxy(port)
        second.lose["confirm"] = 1
        sender = Client(url, ["send", "--file", secret_file])
        link = link_from(sender)
        slow = Client(second.url, ["open", link])
        slow_code = slow.finish(timeout=30)
        sender.finish(timeout=30)
        second.close()
        check("a confirmation that made the room ready and lost its answer still goes on",
              slow_code == 0 and slow.out.decode() == SECRET,
              "exit %s: %s" % (slow_code, slow.err.decode()[-200:]))

        # A room that is gone by the time the symbols are confirmed is a room that is gone.
        expired = Proxy(port)
        expired.fake["confirm"] = {"ok": False, "err": "notfound"}
        sender = Client(url, ["send", "--file", secret_file])
        link = link_from(sender)
        late = Client(expired.url, ["open", link])
        late_code = late.finish(timeout=30)
        sender.finish(timeout=30)
        expired.close()
        check("a confirmation that finds no room exits 2, not as a refusal",
              late_code == 2, "exit %s: %s" % (late_code, late.err.decode()[-200:]))

        # Whoever gives up on an exchange says so to the room, so the other side is not left
        # waiting for someone who has gone.
        quitter = Proxy(port)
        quitter.fake["reveal"] = {"ok": False, "err": "badinput"}
        sender = Client(quitter.url, ["send", "--file", secret_file])
        link = link_from(sender)
        abandoned = Client(url, ["open", link])
        quit_code = sender.finish(timeout=30)
        abandoned_code = abandoned.finish(timeout=15)
        quitter.close()
        check("a client that gives up does not leave the other side waiting",
              quit_code != 0 and abandoned_code == 2,
              "exits %s and %s: %s" % (quit_code, abandoned_code, abandoned.err.decode()[-200:]))

        print("\non a real terminal")

        framed = on_a_terminal(url, pizza_file)
        check("the secret is marked off when a person is reading",
              "-----BEGIN SECRET-----" in framed and "-----END SECRET-----" in framed,
              framed[-300:])
        check("and the marks do not swallow it",
              "-----BEGIN SECRET-----\npizza\n-----END SECRET-----" in framed, framed[-300:])
        check("the question is asked on the terminal, not on stdin",
              "They match on both screens?" in framed, framed[-300:])

        print("\nkeeping the secret out of sight")
        with open(trace, "rb") as handle:
            traced = handle.read().decode("utf-8", "replace")

        # strace -f prefixes each line with a pid and interleaves processes, so this has
        # to be read line by line rather than with one regex over the whole file.
        allowed = re.compile(r"^(/dev/(null|tty|urandom)|/proc/|" + re.escape(workdir) + ")")
        stray = set()

        for line in traced.splitlines():
            found = re.match(r'^(?:\d+\s+)?openat\(AT_FDCWD, "([^"]+)", ([^)]*)\)', line)
            if not found:
                continue
            path, flags = found.group(1), found.group(2)
            if ("O_WRONLY" in flags or "O_RDWR" in flags or "O_CREAT" in flags) \
               and not allowed.match(path):
                stray.add(path)

        stray = sorted(stray)
        check("the client writes no files while a secret passes", not stray, str(stray))

        check("the secret never appears in the command line",
              SECRET.split("\n")[0] not in " ".join(sys.argv) and "--text" not in open(CLI, "rb").read().decode("latin-1"))

    finally:
        try:
            os.killpg(os.getpgid(server.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        shutil.rmtree(workdir, ignore_errors=True)

    print("\ncli: " + ("all good" if not failures else "%d failing" % len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

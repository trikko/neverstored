#!/usr/bin/env python3
"""The terminal client, end to end: two processes talking to each other."""

import os, pty, re, select, shutil, signal, socket, subprocess, sys, tempfile, time
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

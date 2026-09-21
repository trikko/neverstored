#!/usr/bin/env python3
"""HTTP surface, state machine and amnesia tests. Starts its own server."""

import base64, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time
import urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BINARY = os.path.join(ROOT, "neverstored")
CANARY = base64.b64encode(b"CANARY-PAYLOAD-MUST-NEVER-BE-WRITTEN").decode()

failures = []


def check(name, condition, detail=""):
    print(("  ok   " if condition else "  FAIL ") + name + ("" if condition else ": " + detail))
    if not condition:
        failures.append(name)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


VISITOR = "198.51.100.7"


def call(port, op, payload, raw=None, method="POST", headers=None, ip=VISITOR):
    """Speaks the way a correctly configured reverse proxy does: ip=None is a broken one."""
    url = "http://127.0.0.1:%d/api/%s" % (port, op)
    data = raw if raw is not None else json.dumps(payload).encode()
    headers = dict(headers or {"content-type": "application/json"})
    if ip is not None:
        headers["x-forwarded-for"] = ip
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            return error.code, json.loads(body or b"{}")
        except ValueError:
            return error.code, {}


def get(port, path, ip=VISITOR):
    headers = {"x-forwarded-for": ip} if ip is not None else {}
    request = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def wait_for(port):
    for _ in range(200):
        try:
            get(port, "/")
            return True
        except Exception:
            time.sleep(0.05)
    return False


def exchange(port, ct=None, flow="send"):
    _, created = call(port, "create", {"flow": flow, "pub": base64.b64encode(b"A" * 65).decode()})
    room, sender_token = created["id"], created["token"]
    _, joined = call(port, "join", {"id": room, "pub": base64.b64encode(b"B" * 65).decode()})
    receiver_token = joined["token"]
    call(port, "confirm", {"id": room, "token": sender_token})
    call(port, "confirm", {"id": room, "token": receiver_token})
    call(port, "deliver", {"id": room, "token": sender_token, "ct": ct or CANARY})
    _, picked = call(port, "poll", {"id": room, "token": receiver_token, "v": 0})
    return room, sender_token, receiver_token, picked


def children_of(pid):
    result = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True)
    return [int(line) for line in result.stdout.split()]


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def check_rooms_die_with_daemon(env, workdir):
    """A daemon killed outright must leave nothing holding rooms in memory."""
    port = free_port()
    socket_path = os.path.join(workdir, "lifecycle.sock")
    env = dict(env, NEVERSTORED_PORT=str(port), NEVERSTORED_SOCKET=socket_path)
    server = subprocess.Popen([BINARY], env=env, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, start_new_session=True)
    if not wait_for(port):
        server.kill()
        return "server did not start"

    call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()})
    survivors = children_of(server.pid)

    os.killpg(os.getpgid(server.pid), signal.SIGKILL)
    server.wait()

    for _ in range(40):
        reachable = False
        try:
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(0.5)
            probe.connect(socket_path)
            probe.close()
            reachable = True
        except OSError:
            pass

        if not reachable and not any(alive(pid) for pid in survivors):
            return None
        time.sleep(0.1)

    return "rooms still reachable after the daemon was killed"


def check_no_proxy_mode():
    """NEVERSTORED_NO_PROXY is how an instance says there is nobody in front of it."""
    port = free_port()
    own = tempfile.mkdtemp(prefix="neverstored-noproxy-")
    env = dict(os.environ, NEVERSTORED_PORT=str(port), NEVERSTORED_NO_PROXY="1",
               NEVERSTORED_SOCKET=os.path.join(own, "noproxy.sock"))
    server = subprocess.Popen([BINARY], env=env, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if not wait_for(port):
            return "server did not start"

        key = base64.b64encode(b"A" * 65).decode()
        _, reply = call(port, "create", {"flow": "send", "pub": key}, ip=None)
        check("with NEVERSTORED_NO_PROXY a bare request opens a room", reply.get("ok") is True,
              str(reply))

        status, _, _ = get(port, "/", ip=None)
        check("and the page is the exchange, not the warning", status == 200, str(status))

        refused = False
        for _ in range(30):
            _, reply = call(port, "create", {"flow": "send", "pub": key}, ip=None)
            if reply.get("err") == "ratelimit":
                refused = True
                break
        check("and the per-visitor limit is gone with it", not refused)
        return None
    finally:
        try:
            os.killpg(os.getpgid(server.pid), signal.SIGKILL)
            server.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired, PermissionError):
            pass
        shutil.rmtree(own, ignore_errors=True)


def main():
    if not os.path.exists(BINARY):
        print("build first: dub build")
        return 1

    port = free_port()
    workdir = tempfile.mkdtemp(prefix="neverstored-test-")
    logfile = os.path.join(workdir, "server.log")
    strace_out = os.path.join(workdir, "strace.txt")

    env = dict(os.environ, NEVERSTORED_PORT=str(port),
               NEVERSTORED_SOCKET=os.path.join(workdir, "broker.sock"))

    command = [BINARY]
    traced = shutil.which("strace") is not None
    if traced:
        command = ["strace", "-f", "-s", "300", "-e", "trace=openat,creat,write",
                   "-o", strace_out] + command

    log = open(logfile, "wb")
    server = subprocess.Popen(command, env=env, stdout=log, stderr=log, cwd=workdir,
                              start_new_session=True)

    try:
        if not wait_for(port):
            print("server did not start")
            return 1

        print("state machine")
        room, sender, receiver, picked = exchange(port)
        check("the recipient receives exactly what was handed over", picked.get("ct") == CANARY)
        check("the room is burned after delivery", picked.get("state") == "burned")

        _, again = call(port, "poll", {"id": room, "token": receiver, "v": 0})
        check("the payload cannot be picked up twice", "ct" not in again)

        status, reply = call(port, "deliver", {"id": room, "token": sender, "ct": CANARY})
        check("a burned room accepts no further delivery", reply.get("ok") is False)

        _, created = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()})
        room2, token2 = created["id"], created["token"]
        _, reply = call(port, "join", {"id": room2, "pub": base64.b64encode(b"B" * 65).decode()})
        joiner2 = reply["token"]
        _, reply = call(port, "join", {"id": room2, "pub": base64.b64encode(b"C" * 65).decode()})
        check("a third participant is refused", reply.get("err") == "occupied")

        _, reply = call(port, "deliver", {"id": room2, "token": token2, "ct": CANARY})
        check("no delivery before both confirmed", reply.get("ok") is False)

        call(port, "confirm", {"id": room2, "token": token2})
        call(port, "confirm", {"id": room2, "token": joiner2})
        _, reply = call(port, "deliver", {"id": room2, "token": joiner2, "ct": CANARY})
        check("the recipient cannot deliver in their own room", reply.get("ok") is False)

        _, reply = call(port, "poll", {"id": room2, "token": "A" * 22, "v": 0})
        check("a room id without its token reveals nothing", reply.get("err") == "notfound")

        print("\nspeculative requests")
        # A browser that prefetches or prerenders a shared link says so. Honouring the join
        # would hand the room to nobody and leave the recipient locked out of their own link.
        speculator = "198.51.100.77"
        for header, value in [("sec-purpose", "prefetch"), ("sec-purpose", "prefetch;prerender"),
                              ("purpose", "prefetch"), ("x-purpose", "preview"), ("x-moz", "prefetch")]:
            _, created = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()},
                              ip=speculator)
            room3 = created["id"]
            _, reply = call(port, "join", {"id": room3, "pub": base64.b64encode(b"B" * 65).decode()},
                            headers={"content-type": "application/json", header: value}, ip=speculator)
            check("a join labelled %s: %s is refused" % (header, value),
                  reply.get("err") == "speculative", str(reply))
            _, reply = call(port, "join", {"id": room3, "pub": base64.b64encode(b"B" * 65).decode()},
                            ip=speculator)
            check("and the room is still there for the person who was sent the link",
                  reply.get("ok") is True, str(reply))

        _, reply = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()},
                        headers={"content-type": "application/json", "sec-purpose": "prefetch"},
                        ip=speculator)
        check("a create is refused the same way", reply.get("err") == "speculative", str(reply))

        status, _, _ = get(port, "/r/" + room3, ip=VISITOR)
        check("the page itself is still served to a prefetch, since it takes no room",
              status == 200, str(status))

        print("\nindistinguishability")
        _, burned = call(port, "poll", {"id": room, "token": "B" * 22, "v": 0})
        _, missing = call(port, "poll", {"id": "Z" * 22, "token": "B" * 22, "v": 0})
        check("a burned room looks exactly like one that never existed", burned == missing,
              "%s vs %s" % (burned, missing))

        print("\ninput handling")
        status, _ = call(port, "poll", {}, method="GET", raw=b"")
        check("GET is refused on the api", status == 405)

        status, _ = call(port, "create", None, raw=b"{not json")
        check("malformed json is refused", status == 400)

        status, _ = call(port, "create", None, raw=b'"a string"')
        check("a non-object body is refused", status == 400)

        status, _ = call(port, "create", None, raw=b"x" * (200 * 1024))
        check("an oversized body is refused", status in (413, 400))

        _, reply = call(port, "create", {"flow": "send", "pub": "not base64 at all!!"})
        check("a junk public key is refused", reply.get("ok") is False)

        _, reply = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 400).decode()})
        check("an oversized public key is refused", reply.get("ok") is False)

        _, reply = call(port, "create", {"flow": "elsewhere", "pub": base64.b64encode(b"A" * 65).decode()})
        check("an unknown flow is refused", reply.get("ok") is False)

        # The cap is what stops the service being used as a file transfer, so check the
        # exact edge rather than something vaguely huge.
        LIMIT = 8 * 1024 + 64

        def ready_room():
            _, created = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()})
            _, joined = call(port, "join", {"id": created["id"], "pub": base64.b64encode(b"B" * 65).decode()})
            call(port, "confirm", {"id": created["id"], "token": created["token"]})
            call(port, "confirm", {"id": created["id"], "token": joined["token"]})
            return created["id"], created["token"]

        room3, token3 = ready_room()
        _, reply = call(port, "deliver",
                        {"id": room3, "token": token3, "ct": base64.b64encode(b"x" * LIMIT).decode()})
        check("a payload right at the limit goes through", reply.get("ok") is True, str(reply))

        room4, token4 = ready_room()
        status, reply = call(port, "deliver",
                             {"id": room4, "token": token4,
                              "ct": base64.b64encode(b"x" * (LIMIT + 1)).decode()})
        check("one byte more is refused", reply.get("ok") is False or status == 413, str(reply))

        print("\nhttp surface")
        status, headers, body = get(port, "/")
        policy = headers.get("content-security-policy", "")
        check("a content security policy is set", "default-src 'none'" in policy)
        check("no inline script is allowed", "unsafe-inline" not in policy)
        check("the referrer never carries the room id", headers.get("referrer-policy") == "no-referrer")
        check("pages are not cached", headers.get("cache-control") == "no-store")
        check("framing is refused", headers.get("x-frame-options") == "DENY")

        _, _, home = get(port, "/")
        check("the home page says the encrypting happens in the browser",
              b"Your browser encrypts it before it leaves the page" in home)
        check("and points at the long explanation", b'href="/how-it-works"' in home)

        _, _, how = get(port, "/how-it-works")
        check("the explanation opens with where the encryption happens",
              b"Where the encryption happens" in how and b"In your browser" in how)
        check("and walks through the exchange step by step",
              b"Step by step" in how and b"Alice opens a room" in how
              and b"Picked up once, then gone" in how)

        for path in ("/", "/how-it-works", "/cli"):
            _, _, page = get(port, path)
            check("the source is linked from " + path,
                  b"https://github.com/trikko/neverstored" in page)

        _, _, home = get(port, "/")
        check("leaving for the source opens a new tab, so an open room survives",
              b'href="https://github.com/trikko/neverstored" target="_blank"' in home)

        status, _, _ = get(port, "/r/" + "A" * 22)
        check("a well formed room id serves the page", status == 200)
        status, _, _ = get(port, "/r/../../etc/passwd")
        check("path traversal finds nothing", status == 404)
        status, _, _ = get(port, "/r/short")
        check("a malformed room id finds nothing", status == 404)

        # Twenty-two characters of the right alphabet are not enough: the encoder can only
        # ever end an id in one of four of them.
        status, _, _ = get(port, "/r/" + "A" * 21 + "B")
        check("an id the encoder could never produce finds nothing either", status == 404, str(status))

        print("\na local client that stalls")

        stalled = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stalled.connect(os.path.join(workdir, "broker.sock"))
        stalled.send(b"\x00\x00\x04\x00")  # says a kilobyte is coming, then says nothing

        _, reply = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()})
        check("the service answers while a client holds a frame open", reply.get("ok") is True,
              str(reply))

        stalled.settimeout(3)
        try:
            check("and that client is dropped rather than waited on", stalled.recv(16) == b"")
        except OSError as error:
            check("and that client is dropped rather than waited on", False, str(error))
        stalled.close()

        quiet = []
        for _ in range(50):
            extra = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            extra.connect(os.path.join(workdir, "broker.sock"))
            quiet.append(extra)

        _, reply = call(port, "create", {"flow": "send", "pub": base64.b64encode(b"A" * 65).decode()})
        check("and fifty idle connections change nothing", reply.get("ok") is True, str(reply))
        for extra in quiet:
            extra.close()

        print("\nicons and the preview card")
        for path, kind in [("/icon.svg", "image/svg+xml"), ("/favicon.ico", "image/png"),
                           ("/favicon.png", "image/png"), ("/apple-touch-icon.png", "image/png"),
                           ("/social.png", "image/png")]:
            status, headers, body = get(port, path)
            check("%s is served as %s" % (path, kind),
                  status == 200 and headers.get("content-type", "").startswith(kind) and body,
                  "%s %s" % (status, headers.get("content-type")))

        status, _, body = get(port, "/social.png")
        check("the card is a real PNG of the declared size",
              body[:8] == b"\x89PNG\r\n\x1a\n"
              and int.from_bytes(body[16:20], "big") == 1200
              and int.from_bytes(body[20:24], "big") == 630, str(body[:24]))

        # A preview is fetched by a machine that will not resolve a relative image.
        page = get(port, "/")[2].decode()
        check("the preview image is an absolute url on the host that was asked",
              ('content="https://127.0.0.1:%d/social.png"' % port) in page,
              page[page.find("og:image") - 40:page.find("og:image") + 80])
        check("and every page declares the icon", "/icon.svg" in page)

        request = urllib.request.Request("http://127.0.0.1:%d/" % port, headers={
            "x-forwarded-for": VISITOR, "x-forwarded-proto": "http"})
        with urllib.request.urlopen(request, timeout=5) as response:
            plain = response.read().decode()
        check("and follows the scheme the proxy reports",
              ('content="http://127.0.0.1:%d/social.png"' % port) in plain)

        # The host travels from the request into a meta tag, so it is attacker-controlled text.
        raw = socket.create_connection(("127.0.0.1", port), timeout=5)
        raw.sendall(b'GET / HTTP/1.1\r\nHost: evil"><script>x</script>\r\n'
                    b"X-Forwarded-For: 198.51.100.7\r\nConnection: close\r\n\r\n")
        crafted = b""
        while True:
            chunk = raw.recv(65536)
            if not chunk:
                break
            crafted += chunk
        raw.close()
        check("a host with markup in it never reaches the page",
              b"evil" not in crafted and b"<script>x</script>" not in crafted,
              crafted[:80].decode(errors="replace"))
        check("and the preview falls back to a relative image rather than a forged one",
              b'property="og:image" content="/social.png"' in crafted)

        room_page = get(port, "/r/" + "A" * 22)[2].decode()
        check("a room page keeps its id out of the preview",
              "A" * 22 not in room_page.split("<body")[0])

        print("\nhow long the room has")
        key = base64.b64encode(b"A" * 65).decode()
        _, made = call(port, "create", {"flow": "send", "pub": key})
        _, first = call(port, "poll", {"id": made["id"], "token": made["token"], "v": 0})
        check("a poll says how long the room has left",
              0 < first.get("expiresIn", 0) <= 600, str(first.get("expiresIn")))

        _, quiet = call(port, "poll",
                        {"id": made["id"], "token": made["token"], "v": first["ver"]})
        check("and says it again when nothing has changed",
              quiet.get("changed") is False and quiet.get("expiresIn", 0) > 0, str(quiet))

        _, entered = call(port, "join", {"id": made["id"], "pub": base64.b64encode(b"B" * 65).decode()})
        _, paired = call(port, "poll", {"id": made["id"], "token": made["token"], "v": 0})
        check("the room shortens once someone is in it",
              paired["expiresIn"] < first["expiresIn"], str(paired.get("expiresIn")))

        call(port, "confirm", {"id": made["id"], "token": made["token"]})
        call(port, "confirm", {"id": made["id"], "token": entered["token"]})
        _, armed = call(port, "poll", {"id": made["id"], "token": made["token"], "v": 0})
        check("and again once both have confirmed",
              armed["expiresIn"] < paired["expiresIn"], str(armed.get("expiresIn")))

        print("\nrate limit")
        refused = False
        for _ in range(30):
            _, reply = call(port, "create", {"flow": "send", "pub": key})
            if reply.get("err") == "ratelimit":
                refused = True
                break
        check("one address cannot open unlimited rooms", refused)

        _, reply = call(port, "create", {"flow": "send", "pub": key}, ip="198.51.100.9")
        check("and cannot spend anybody else's allowance", reply.get("ok") is True, str(reply))

        _, reply = call(port, "create", {"flow": "send", "pub": key},
                        ip="203.0.113.1, " + VISITOR)
        check("a header the client wrote itself buys nothing: the last hop is the one counted",
              reply.get("err") == "ratelimit", str(reply))

        print("\nmisconfigured proxy")
        _, reply = call(port, "create", {"flow": "send", "pub": key}, ip=None)
        check("no x-forwarded-for, no rooms", reply.get("err") == "misconfigured", str(reply))

        status, _, body = get(port, "/", ip=None)
        check("and the page says so rather than offering an exchange",
              status == 503 and b"misconfigured" in body.lower(), str(status))

        status, _, body = get(port, "/style.css", ip=None)
        check("while assets still answer, so the page arrives styled", status == 200)

    finally:
        try:
            os.killpg(os.getpgid(server.pid), signal.SIGINT)
            server.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass
        try:
            os.killpg(os.getpgid(server.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        log.close()

    print("\nno proxy in front")
    failed = check_no_proxy_mode()
    check("the no-proxy instance runs at all", failed is None, str(failed))

    print("\nlifecycle")
    survivor = check_rooms_die_with_daemon(env, workdir)
    check("no room outlives the daemon", survivor is None, str(survivor))

    print("\namnesia")
    with open(logfile, "rb") as handle:
        logged = handle.read()
    check("the payload never reaches the log", CANARY.encode() not in logged)

    leftovers = [name for name in os.listdir(workdir)
                 if name not in ("server.log", "strace.txt", "broker.sock", "lifecycle.sock")]
    check("no file is left behind", not leftovers, str(leftovers))

    if traced and os.path.exists(strace_out):
        with open(strace_out, "rb") as handle:
            trace = handle.read().decode("utf-8", "replace")

        writes = [line for line in trace.splitlines()
                  if CANARY[:40] in line and line.lstrip().startswith(("write(1", "write(2"))]
        check("the payload is never written to stdout or the log", not writes, str(writes[:2]))

        opened = re.findall(r'openat\([^)]*"([^"]+)"[^)]*O_(?:WRONLY|RDWR)[^)]*\)', trace)
        allowed = re.compile(r"^(/dev/(null|urandom|tty)|/proc/|.*/strace\.txt$|.*/server\.log$)")
        bad = sorted({path for path in opened if not allowed.match(path)})
        check("nothing is ever opened for writing on disk", not bad, str(bad))
    else:
        print("  skip strace checks (strace unavailable)")

    shutil.rmtree(workdir, ignore_errors=True)

    print("\napi: " + ("all good" if not failures else "%d failing" % len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

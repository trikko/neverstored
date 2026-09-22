# neverstored

Hand a secret to someone while you are both there. Nothing is ever stored.

Passwords, API keys and personal data get pasted into Slack and email, which keep them
forever, sync them to every device and carry them into backups. The usual alternative —
a one-time secret link — parks the secret, encrypted, on a server until someone reads it.

neverstored does not park anything. You write the secret, it stays in your browser. When
the other person opens your link, the two browsers agree on a key between themselves, you
both check four symbols match, and only then does the encrypted secret cross the server
from one connection to the other. There is nothing to delete afterwards because nothing
was ever written.

## How it works

1. You write the secret. It stays in the page. Nothing has been sent.
2. You get a link and send it however you like. The link carries no secret: it is an address.
3. They open it. The two browsers exchange ECDH public keys and each derives the same key.
4. Both screens show four symbols derived from that key, with a word under each one.
   You check they match — in person, on a call, or in the same chat.
5. You send it. The browser encrypts with AES-GCM, the server passes the bytes from
   one connection to the other and forgets them. The room is destroyed and the link dies.

The four symbols are what makes an intercepted link harmless. Someone in the middle can
only build two separate sessions, so the two screens disagree and you stop.

It works in both directions: you can hand a secret over, or open a room to ask someone to
hand one to you. The steps are the same, only who types changes.

If the other person is next to you, let them scan the QR code of the link and then compare
the symbols by simply looking at each other's screen.

## Up to 8 KB

A password, a key, a PEM, a short config. Larger payloads are refused by the page, by the
client and by the server: carrying files is a different service with different costs, and
the cap is what keeps this one from quietly becoming it.

## A room does not wait forever

Rooms are for an exchange happening now, so they are given only as long as that takes: ten
minutes for a link nobody has opened yet, five from the moment the other side arrives, two
once both have confirmed the symbols. Every deadline is shown as a countdown on the page and
warned about in the terminal, and when it runs out the room is swept, the payload is wiped
and the link stops meaning anything. Nothing is lost by starting again.

## What is guaranteed, and what is not

Guaranteed:

- the readable secret never exists on the server, at any moment;
- nothing is written to disk: no database, no queue, no log of the payload;
- the server does not hold the key and cannot derive it — it only sees public keys;
- the link carries no secret, so it is safe to paste in a chat.

Not guaranteed, and worth knowing:

- a compromised server could serve modified JavaScript that leaks the key. This is true of
  every end-to-end web app. The answer is to run your own;
- the browser is inside the trust boundary, not outside it. An extension with access to the
  page, or a machine somebody else controls, reads the secret exactly as the person reading
  it does, and no amount of cryptography in the page can prevent that. The terminal client
  exists partly for this: it has no extensions, and what it depends on is the two libraries
  it links;
- the recipient can screenshot or paste it elsewhere;
- the readable secret does live in both browsers' memory while the page is open;
- the server sees two IP addresses. It keeps neither: the one that opened the room is counted
  under a keyed hash, with a key made at startup that never leaves memory and dies with the
  process.

## Run your own

We say we store nothing, and you only have our word for it. So the code is open, small
enough to read in an afternoon, and here is how to run it yourself.

```
git clone https://github.com/trikko/neverstored && cd neverstored
dub build --build=release
NEVERSTORED_PORT=8080 NEVERSTORED_NO_PROXY=1 ./neverstored
```

That is the whole deployment: one binary, no database, no external service. The static
files are compiled into the executable.

| Variable | Default | Meaning |
|---|---|---|
| `NEVERSTORED_PORT` | `8080` | port to listen on |
| `NEVERSTORED_BIND` | `127.0.0.1` | address to bind; keep it on loopback and put a TLS reverse proxy in front |
| `NEVERSTORED_NO_PROXY` | unset | say there is no proxy in front, and drop the per-visitor limit with it |
| `NEVERSTORED_SOCKET` | `$XDG_RUNTIME_DIR/neverstored.sock` | internal socket the service uses to keep every room in one place |

A systemd unit is in `deploy/neverstored.service`, with a `Caddyfile` and an `nginx.conf`
next to it. Only the executable is ever deployed: every page, script and stylesheet is
compiled into it.

The proxy must pass the address it accepted the connection from as `X-Forwarded-For`, set
rather than appended: that address is all the server has to keep one visitor from opening
rooms until there is no memory left for anybody else. It is never stored — it is counted
under a keyed hash whose key is made at startup and never leaves memory — but it has to
arrive. Without the header an instance refuses to open rooms and says so on every page,
because the alternative is counting every visitor as the same one.

Running with nothing in front, which is the line above and how the tests run, wants
`NEVERSTORED_NO_PROXY=1`: the per-visitor limit goes away and only the ceiling of 10000
rooms for the whole instance is left. It is meant for a laptop, not for a public address.

### In a container

`Dockerfile` and `compose.yml` are in the repository. The build stage compiles a binary
linked statically against musl; the image that runs it is `scratch` and holds that binary
and nothing else — no shell, no package manager, no libc to keep patched, 1.4 MB in total.

```
$EDITOR static/operator.ini       # who answers for this instance
$EDITOR deploy/Caddyfile.compose  # your hostname
docker compose up -d --build
```

The image is built rather than pulled, and that is deliberate: the operator details are
compiled into the binary, so an image somebody else built names somebody else as the
person to write to about abuse. A clone has no `static/operator.ini` — it is gitignored
for the same reason — and the build falls back to the placeholders in
`static/operator.ini.example`, which is why the first line above is not optional.

TLS is not decoration here. Outside `localhost` a browser denies `crypto.subtle` to a page
served over plain HTTP, so an instance reached at `http://192.168.1.10:8080` does not
merely look insecure: it does not work. That is why `compose.yml` brings its own Caddy,
which gets a certificate for the hostname you put in `deploy/Caddyfile.compose` and terminates
TLS in front of a service that is never published on the host.

For the same reason `NEVERSTORED_NO_PROXY` does not appear in `compose.yml`, and should
not be added to it: Caddy sets `X-Forwarded-For`, and the variable would throw away the
one thing that keeps a single visitor from opening every room on the instance.

The container runs as uid 65534 with a read-only root filesystem, no capabilities and
`no-new-privileges`; the internal socket lands in a tmpfs. If you already terminate TLS
somewhere else, drop the `caddy` service and replace `expose` with a `ports` mapping on
loopback — the proxy in front still has to pass `X-Forwarded-For` and still has to serve
the instance over HTTPS.

## From the terminal

You can download the latest pre-compiled binaries for Linux and macOS from the [latest release](https://github.com/trikko/neverstored/releases/latest).

Alternatively, you can build it from source:

```
cd cli && dub build --build=release
```

Usage:

```
./neverstored send --file api-key.txt     # prints a link and a code to scan
./neverstored open <link>                 # from the other machine
./neverstored ask > key.txt               # the other direction
```

It speaks the same API and the same protocol as the page, so a link made in a terminal
opens in a browser and the other way round, and the four symbols match on both. The secret
is read from a file, from stdin, or typed without echo — never from an argument, which
would put it in the process list. What arrives goes to stdout and nothing else does. The
symbols are always confirmed by a person: there is no flag to skip that.

It talks to `https://neverstored.com` unless `NEVERSTORED_URL` or `--url` says otherwise,
so pointing it at your own instance is one variable.
The client needs `libcrypto` and `libcurl`. Most systems already have them, but if missing, you can install them via your package manager (e.g., `apt install libcurl4 libssl3` on Debian/Ubuntu, or `brew install openssl curl` on macOS). The server still needs nothing. See `/cli` on a running instance for the full usage.

## Tests

```
./tests/run.sh
```

Unit tests cover the room state machine and the symbol table. Beyond those, the suite
checks the things the product actually promises: that illegal state transitions are
refused; that a burned room is indistinguishable from one that never existed; that a server
in the middle, grinding keys of its own, cannot put the same symbols on the two screens; that a
payload nobody collects is
zeroed and forgotten; that the QR code reads back through an independent decoder; that a
real browser exchange delivers exactly what was typed; that the terminal client and the
browser derive the same four symbols and open each other's payloads — and, under `strace`,
that nothing is ever opened for writing while a secret passes through, neither on the
server nor in the client.

Built with [serverino](https://serverino.dev). MIT licensed.

// A hostile server between two terminal clients. It speaks the whole API, holds both
// honest keys as early as the protocol lets it, and tries to put the same four symbols on
// both screens with keys of its own. Two people who compare symbols and only confirm a
// match must never hand it the secret.
import { spawn } from "node:child_process";
import { createECDH, createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "cli", "neverstored");
const SECRET = "the-secret-the-middle-must-not-read";
const ROOM = "MitmMitmMitmMitmMitmMA";

let failures = 0;
const check = (name, ok, detail = "") => {
   console.log((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : ": " + detail));
   if (!ok) failures++;
};

const keyPair = () => { const k = createECDH("prime256v1"); k.generateKeys(); return k; };
const pubOf = (k) => k.getPublicKey("base64");
const commitOf = (pub) => createHash("sha256").update(Buffer.from(pub, "base64")).digest("base64");

// The same derivation both clients run, done by the one holding the other private key.
function session(mine, peerPub) {
   const shared = mine.computeSecret(Buffer.from(peerPub, "base64"));
   const [a, b] = [pubOf(mine), peerPub].sort();
   const bits = Buffer.from(hkdfSync("sha256", shared, ROOM, `neverstored-v1|${ROOM}|${a}|${b}`, 36));
   return { key: bits.subarray(0, 32), symbols: bits.subarray(32, 36).toString("hex") };
}

function open(s, payload) {
   const raw = Buffer.from(payload, "base64");
   const d = createDecipheriv("aes-256-gcm", s.key, raw.subarray(0, 12));
   d.setAAD(Buffer.from(ROOM));
   d.setAuthTag(raw.subarray(raw.length - 16));
   return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString();
}

function close(s, text) {
   const iv = randomBytes(12);
   const c = createCipheriv("aes-256-gcm", s.key, iv);
   c.setAAD(Buffer.from(ROOM));
   const body = Buffer.concat([c.update(text), c.final()]);
   return Buffer.concat([iv, body, c.getAuthTag()]).toString("base64");
}

/* The best the middle can do with what it is given. Holding both honest keys before it
 * has shown either side anything, it grinds two keys of its own until the symbols collide:
 * four bytes fall to a birthday search in seconds. Holding only one, it has nothing to
 * grind against and substitutes keys blindly, hoping the people do not compare. */
function hostileBroker({ breakPromise = false, alterPayload = false } = {}) {
   const room = { stolen: null, flow: null, confirmed: {}, ver: 1, state: "created" };

   function forge() {
      if (room.creatorPub) {
         const seen = new Map();
         for (let i = 0; i < 1 << 20; i++) {
            const toJoiner = keyPair();
            seen.set(session(toJoiner, room.joinerPub).symbols, toJoiner);
            const toCreator = keyPair();
            const match = seen.get(session(toCreator, room.creatorPub).symbols);
            if (match) { room.toCreator = toCreator; room.toJoiner = match; room.ground = true; return; }
         }
      }
      room.toCreator = keyPair();
      room.toJoiner = keyPair();
   }

   const sender = () => room.flow === "send" ? "creator" : "joiner";
   const withCreator = () => session(room.toCreator, room.creatorPub);
   const withJoiner = () => session(room.toJoiner, room.joinerPub);

   const ops = {
      create(body) {
         room.flow = body.flow;
         room.creatorPub = body.pub || null;
         room.creatorCommit = body.commit || null;
         return { ok: true, id: ROOM, token: "creator", side: "creator", ver: room.ver };
      },
      join(body) {
         room.joinerPub = body.pub;
         forge();
         room.state = "paired";
         room.ver++;
         // Promising one key and showing another is the only way left to choose the joiner's
         // key after the creator's is known.
         const promised = breakPromise ? keyPair() : room.toJoiner;
         return { ok: true, token: "joiner", side: "joiner", ver: room.ver,
            peerCommit: alterPayload ? room.creatorCommit : commitOf(pubOf(promised)) };
      },
      reveal(body) {
         room.creatorPub = body.pub;
         room.ver++;
         return { ok: true, ver: room.ver };
      },
      confirm(body) {
         room.confirmed[body.token] = true;
         if (room.confirmed.creator && room.confirmed.joiner) room.state = "ready";
         room.ver++;
         return { ok: true, ver: room.ver };
      },
      deliver(body) {
         if (alterPayload) {
            const raw = Buffer.from(body.ct, "base64");
            raw[raw.length - 1] ^= 1;
            room.forwarded = raw.toString("base64");
            room.ver++;
            return { ok: true, ver: room.ver };
         }
         const from = body.token === "creator" ? withCreator() : withJoiner();
         const to = body.token === "creator" ? withJoiner() : withCreator();
         try { room.stolen = open(from, body.ct); } catch { return { ok: false, err: "state" }; }
         room.forwarded = close(to, room.stolen);
         room.ver++;
         return { ok: true, ver: room.ver };
      },
      poll(body) {
         if (room.state === "burned") return { ok: false, err: "notfound" };
         if (body.v === room.ver && !room.forwarded) return { ok: true, changed: false, expiresIn: 300 };

         const side = body.token;
         const reply = { ok: true, changed: true, ver: room.ver, expiresIn: 300, state: room.state,
            role: side === sender() ? "sender" : "receiver", peer: room.state !== "created",
            delivered: false };

         // Each side is shown the key the middle made for it, as soon as it has one to show.
         if (alterPayload) {
            if (side === "creator" && room.joinerPub) reply.peerPub = room.joinerPub;
            if (side === "joiner" && room.creatorPub) reply.peerPub = room.creatorPub;
         } else {
            if (side === "creator" && room.toCreator) reply.peerPub = pubOf(room.toCreator);
            if (side === "joiner" && room.toJoiner && room.creatorPub) reply.peerPub = pubOf(room.toJoiner);
         }

         if (room.forwarded && side !== sender()) {
            reply.ct = room.forwarded;
            reply.delivered = true;
            room.state = "burned";
         }
         return reply;
      },
      cancel() { room.state = "burned"; return { ok: true }; },
   };

   const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => body += chunk);
      request.on("end", () => {
         const op = request.url.replace("/api/", "");
         const handler = ops[op];
         const reply = handler ? handler(JSON.parse(body || "{}")) : { ok: false, err: "badop" };
         response.setHeader("content-type", "application/json");
         response.end(JSON.stringify(reply));
      });
   });

   return { server, room };
}

/// A terminal client with nobody behind a keyboard but this harness. Started in a session
/// of its own, so it has no terminal to ask on and asks on stdin, where the harness answers.
function client(url, args) {
   const child = spawn(CLI, [...args, "--no-qr"], {
      env: { ...process.env, NEVERSTORED_URL: url }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
   const seen = { err: "", out: "", code: null };
   child.stderr.on("data", (chunk) => seen.err += chunk);
   child.stdout.on("data", (chunk) => seen.out += chunk);
   const done = new Promise((resolve) => child.on("exit", (code) => { seen.code = code; resolve(); }));
   return { child, seen, done };
}

/// What each screen asks the person to compare, as the person would read it.
const symbolsOn = (seen) => {
   const at = seen.err.indexOf("Do you both see these four?");
   if (at < 0 || !seen.err.includes("[y/N]", at)) return null;
   return seen.err.slice(at, seen.err.indexOf("[y/N]", at)).split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("Do you") && !l.startsWith("They match")).join(" ");
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function run(flow, options) {
   const { server, room } = hostileBroker(options);
   await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
   const url = "http://127.0.0.1:" + server.address().port;

   const work = mkdtempSync(join(tmpdir(), "neverstored-mitm-"));
   const file = join(work, "secret.txt");
   writeFileSync(file, SECRET);

   const creator = client(url, flow === "send" ? ["send", "--file", file] : ["ask"]);
   await sleep(800);
   const joiner = client(url, flow === "send" ? ["open", ROOM] : ["open", ROOM, "--file", file]);

   // The two people: each looks at the other's screen and says yes only to a match.
   const deadline = Date.now() + 30000;
   let a = null, b = null;
   while (Date.now() < deadline && (a === null || b === null)) {
      a = symbolsOn(creator.seen);
      b = symbolsOn(joiner.seen);
      if (creator.seen.code !== null || joiner.seen.code !== null) break;
      await sleep(100);
   }

   const answer = a !== null && a === b ? "y\n" : "n\n";
   for (const side of [creator, joiner]) if (side.seen.code === null) side.child.stdin.end(answer);

   await Promise.race([Promise.all([creator.done, joiner.done]), sleep(20000)]);
   for (const side of [creator, joiner]) if (side.seen.code === null) side.child.kill("SIGKILL");
   server.close();
   rmSync(work, { recursive: true, force: true });

   return { room, a, b, creator: creator.seen, joiner: joiner.seen };
}

for (const flow of ["send", "request"]) {
   console.log(`\n  ${flow}: a server that forges both keys`);
   const { room, a, b, creator, joiner } = await run(flow);

   check("the creator does not hand its key over before the other one is fixed",
      room.creatorCommit !== null && !room.ground,
      room.ground ? "the middle ground a collision: " + a : "create carried " + JSON.stringify(
         { pub: !!room.creatorPub, commit: !!room.creatorCommit }));
   check("the middle never reads the secret", room.stolen === null,
      "it read " + JSON.stringify(room.stolen) + " with both screens showing " + a);
   check("nor does the secret arrive through it",
      !creator.out.includes(SECRET) && !joiner.out.includes(SECRET),
      "stdout carried it");
   check("and whoever notices says so, instead of calling it success",
      creator.code !== 0 && joiner.code !== 0,
      `exits ${creator.code} and ${joiner.code}; screens ${a} / ${b}`);
}

console.log("\n  a server that shows the joiner a key the creator never committed to");
{
   const { room, joiner } = await run("send", { breakPromise: true });
   check("the joiner refuses it", joiner.code === 1, String(joiner.code));
   check("before any symbols are on screen", !joiner.err.includes("Do you both see"),
      joiner.err.trim().slice(-200));
   check("and calls it interference", /tamper|interfer/i.test(joiner.err), joiner.err.trim().slice(-200));
   check("and nothing is read in the middle", room.stolen === null, String(room.stolen));
}

console.log("\n  a server that passes the keys along and alters the sealed secret");
{
   const { a, b, joiner } = await run("send", { alterPayload: true });
   check("the people see the same symbols, since the keys are honest", a !== null && a === b, `${a} / ${b}`);
   check("the receiver refuses what does not open, as interference rather than an outage",
      joiner.code === 1, String(joiner.code) + " " + joiner.err.trim().slice(-160));
   check("and prints nothing of it", joiner.out === "", JSON.stringify(joiner.out.slice(0, 40)));
}

console.log(failures ? `\nmitm: ${failures} failing` : "\nmitm: all good");
process.exit(failures ? 1 : 0);

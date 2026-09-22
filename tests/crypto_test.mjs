// Runs the shipped static/crypto.js, so the tests cover what the browser receives.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = createContext({
   crypto,
   TextEncoder,
   TextDecoder,
   btoa: (s) => Buffer.from(s, "binary").toString("base64"),
   atob: (s) => Buffer.from(s, "base64").toString("binary"),
});

runInContext(readFileSync(join(here, "..", "static", "crypto.js"), "utf8"), sandbox);
const { createIdentity, deriveSession, seal, unseal, commitmentOf, opens } = sandbox;

const ROOM = "IQxLFZiBUNSy6eI2BRUn9Q";
let failures = 0;

async function check(name, body) {
   try { await body(); console.log("  ok   " + name); }
   catch (error) { failures++; console.log("  FAIL " + name + ": " + error.message); }
}

await check("both sides derive the same four symbols", async () => {
   const a = await createIdentity();
   const b = await createIdentity();

   const sa = await deriveSession(a, b.pub, ROOM);
   const sb = await deriveSession(b, a.pub, ROOM);

   assert.deepEqual(sa.symbols, sb.symbols);
   assert.equal(sa.symbols.length, 4);
   for (const index of sa.symbols) assert.ok(index >= 0 && index <= 255);
});

await check("a secret sealed by one side opens on the other", async () => {
   const a = await createIdentity();
   const b = await createIdentity();
   const sa = await deriveSession(a, b.pub, ROOM);
   const sb = await deriveSession(b, a.pub, ROOM);

   const secret = "correct horse battery staple";
   assert.equal(await unseal(sb, ROOM, await seal(sa, ROOM, secret)), secret);
});

await check("a man in the middle shows different symbols to each side", async () => {
   const a = await createIdentity();
   const b = await createIdentity();
   const attacker = await createIdentity();

   const withA = await deriveSession(a, attacker.pub, ROOM);
   const withB = await deriveSession(b, attacker.pub, ROOM);

   assert.notDeepEqual(withA.symbols, withB.symbols);
});

await check("the same key pair in another room yields other symbols", async () => {
   const a = await createIdentity();
   const b = await createIdentity();

   const here_ = await deriveSession(a, b.pub, ROOM);
   const there = await deriveSession(a, b.pub, "ZZZZZZZZZZZZZZZZZZZZZZ");

   assert.notDeepEqual(here_.symbols, there.symbols);
});

await check("a payload replayed into another room does not open", async () => {
   const a = await createIdentity();
   const b = await createIdentity();
   const sa = await deriveSession(a, b.pub, ROOM);
   const sb = await deriveSession(b, a.pub, ROOM);

   const payload = await seal(sa, ROOM, "secret");
   await assert.rejects(() => unseal(sb, "ZZZZZZZZZZZZZZZZZZZZZZ", payload));
});

await check("a tampered payload does not open", async () => {
   const a = await createIdentity();
   const b = await createIdentity();
   const sa = await deriveSession(a, b.pub, ROOM);
   const sb = await deriveSession(b, a.pub, ROOM);

   const payload = Buffer.from(await seal(sa, ROOM, "secret"), "base64");
   payload[payload.length - 1] ^= 1;
   await assert.rejects(() => unseal(sb, ROOM, payload.toString("base64")));
});

await check("a junk public key is refused", async () => {
   const a = await createIdentity();
   await assert.rejects(() => deriveSession(a, Buffer.alloc(65, 7).toString("base64"), ROOM));
});

await check("two rooms with fresh keys never share symbols by accident", async () => {
   const seen = new Set();
   for (let i = 0; i < 40; i++) {
      const a = await createIdentity();
      const b = await createIdentity();
      const s = await deriveSession(a, b.pub, ROOM);
      seen.add(s.symbols.join(","));
   }
   assert.ok(seen.size > 35, "symbol space looks degenerate: " + seen.size);
});

await check("an identity commits to its own key, as a SHA-256 of the raw point", async () => {
   const a = await createIdentity();
   const expected = Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(a.pub, "base64")))
      .toString("base64");
   assert.equal(a.commit, expected);
   assert.equal(await commitmentOf(a.pub), expected);
});

await check("a commitment opens with the key it was made from, and no other", async () => {
   const a = await createIdentity();
   const b = await createIdentity();
   assert.equal(await opens(a.commit, a.pub), true);
   assert.equal(await opens(a.commit, b.pub), false);
   assert.equal(await opens("", a.pub), false);
   assert.equal(await opens(undefined, a.pub), false);
});

console.log(failures ? "\ncrypto: " + failures + " failing" : "\ncrypto: all good");
process.exit(failures ? 1 : 0);

// Proves that the terminal client and the browser derive the same key and the same four
// symbols. If salt, info or key ordering ever drift apart, this is what notices.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROBE = join(ROOT, "cli", "probe");
const ROOM = "IQxLFZiBUNSy6eI2BRUn9Q";

const sandbox = createContext({
   crypto, TextEncoder, TextDecoder,
   btoa: (s) => Buffer.from(s, "binary").toString("base64"),
   atob: (s) => Buffer.from(s, "base64").toString("binary"),
});
runInContext(readFileSync(join(ROOT, "static", "crypto.js"), "utf8"), sandbox);
const { createIdentity, deriveSession, seal, unseal, commitmentOf } = sandbox;

/// Starts the probe, hands its public key to `answer`, then feeds back whatever that
/// returns and resolves with the probe's JSON result.
function probe(args, answer = async () => "") {
   return new Promise((resolve, reject) => {
      const child = spawn(PROBE, args);
      let out = "";
      let errors = "";
      let pub = null;

      child.stderr.on("data", (chunk) => (errors += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
         if (code !== 0) return reject(new Error(errors.trim() || "probe exited " + code));
         const lines = out.trim().split("\n");
         resolve(JSON.parse(lines[lines.length - 1]));
      });

      child.stdout.on("data", async (chunk) => {
         out += chunk;
         if (pub !== null || !out.includes("\n")) return;
         pub = out.split("\n")[0];
         child.stdin.end((await answer(pub)) + "\n");
      });
   });
}

let failures = 0;
async function check(name, body) {
   try { await body(); console.log("  ok   " + name); }
   catch (error) { failures++; console.log("  FAIL " + name + ": " + error.message); }
}

await check("browser and terminal commit to a key the same way", async () => {
   const browser = await createIdentity();
   const answer = await probe([browser.pub, ROOM]);

   assert.equal(answer.commit, await commitmentOf(answer.pub), "the browser cannot open the terminal's");
   assert.equal(answer.peerCommit, browser.commit, "the terminal cannot open the browser's");
});

await check("browser and terminal derive the same four symbols", async () => {
   const browser = await createIdentity();
   const answer = await probe([browser.pub, ROOM]);
   const session = await deriveSession(browser, answer.pub, ROOM);

   assert.deepEqual([...session.symbols], [...answer.symbols]);
});

await check("a secret sealed in the terminal opens in the browser", async () => {
   const browser = await createIdentity();
   const text = "prod-db: Ub3rSecret!2026 — con accento";
   const answer = await probe([browser.pub, ROOM, text]);
   const session = await deriveSession(browser, answer.pub, ROOM);

   assert.equal(await unseal(session, ROOM, answer.ct), text);
});

await check("a secret sealed in the browser opens in the terminal", async () => {
   const browser = await createIdentity();
   const text = "multi line\tsecret ✓ con accento";

   const answer = await probe([browser.pub, ROOM], async (pub) => {
      const session = await deriveSession(browser, pub, ROOM);
      return seal(session, ROOM, text);
   });

   assert.equal(answer.opened, text);
});

await check("a payload from another room does not open", async () => {
   const browser = await createIdentity();

   await assert.rejects(() => probe([browser.pub, ROOM], async (pub) => {
      const session = await deriveSession(browser, pub, "ZZZZZZZZZZZZZZZZZZZZZZ");
      return seal(session, "ZZZZZZZZZZZZZZZZZZZZZZ", "nope");
   }));
});

await check("a tampered payload does not open", async () => {
   const browser = await createIdentity();

   await assert.rejects(() => probe([browser.pub, ROOM], async (pub) => {
      const session = await deriveSession(browser, pub, ROOM);
      const sealed = Buffer.from(await seal(session, ROOM, "nope"), "base64");
      sealed[sealed.length - 1] ^= 1;
      return sealed.toString("base64");
   }));
});

await check("the symbols depend on the room, not only on the keys", async () => {
   const browser = await createIdentity();
   const here = await probe([browser.pub, ROOM]);
   const there = await probe([browser.pub, "ZZZZZZZZZZZZZZZZZZZZZZ"]);

   assert.notDeepEqual(here.symbols, there.symbols);
});

console.log(failures ? "\ninterop: " + failures + " failing" : "\ninterop: all good");
process.exit(failures ? 1 : 0);

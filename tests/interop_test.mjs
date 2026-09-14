// A terminal and a browser handing a secret to each other, both ways round. This is what
// proves the two implementations of the protocol are the same protocol.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "cli", "neverstored");
const SECRET = "prod-db: Ub3rSecret!2026 — con àccento ✓";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = () => new Promise((done) => {
   const probe = createServer();
   probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
   });
});

async function waitFor(check, what, tries = 160) {
   for (let i = 0; i < tries; i++) {
      const value = await check();
      if (value) return value;
      await sleep(250);
   }
   throw new Error("timed out waiting for " + what);
}

let failures = 0;
const check = (name, condition, detail = "") => {
   console.log((condition ? "  ok   " : "  FAIL ") + name + (condition ? "" : ": " + detail));
   if (!condition) failures++;
};

/// One CLI process, with its stderr kept around so the test can read the symbols off it.
function client(url, args, answer = "y\n") {
   const child = spawn(CLI, [...args, "--no-qr"], { env: { ...process.env, NEVERSTORED_URL: url } });
   const held = { out: "", err: "", code: null };

   child.stdout.on("data", (chunk) => (held.out += chunk));
   child.stderr.on("data", (chunk) => (held.err += chunk));
   child.on("close", (code) => (held.code = code));
   child.stdin.end(answer);

   held.link = () => (held.err.match(/http:\/\/\S+\/r\/[A-Za-z0-9_-]{22}/) || [null])[0];
   held.symbols = () => {
      const found = [...held.err.matchAll(/^ {3}\S+ {2}(\w+)$/gm)].map((m) => m[1]);
      return found.length === 4 ? found.join(" ") : null;
   };
   held.kill = () => child.kill();
   return held;
}

async function main() {
   const port = await freePort();
   const debugPort = await freePort();
   const workdir = mkdtempSync(join(tmpdir(), "neverstored-interop-"));
   const base = "http://127.0.0.1:" + port;
   const secretFile = join(workdir, "secret.txt");
   writeFileSync(secretFile, SECRET);

   const server = spawn(join(ROOT, "neverstored"), [], {
      env: { ...process.env, NEVERSTORED_PORT: String(port), NEVERSTORED_SOCKET: join(workdir, "b.sock"),
         NEVERSTORED_NO_PROXY: "1" },
      stdio: "ignore",
   });

   const chrome = spawn("google-chrome", [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--user-data-dir=" + join(workdir, "profile"), "--remote-debugging-port=" + debugPort, "about:blank",
   ], { stdio: "ignore" });

   let socket;
   const pending = new Map();
   let next = 1;

   try {
      const version = await waitFor(async () => {
         try {
            const response = await fetch("http://127.0.0.1:" + debugPort + "/json/version");
            return response.ok ? response.json() : null;
         } catch { return null; }
      }, "the browser");

      socket = new WebSocket(version.webSocketDebuggerUrl);
      socket.onmessage = (event) => {
         const message = JSON.parse(event.data);
         const waiter = pending.get(message.id);
         if (!waiter) return;
         pending.delete(message.id);
         message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      };
      await new Promise((done) => (socket.onopen = done));

      const send = (method, params = {}, sessionId) => {
         const id = next++;
         socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
         return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      };

      const openTab = async (url) => {
         const { targetId } = await send("Target.createTarget", { url });
         const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
         const tab = {
            eval: async (expression) => {
               const result = await send("Runtime.evaluate",
                  { expression, awaitPromise: true, returnByValue: true }, sessionId);
               if (result.exceptionDetails)
                  throw new Error(result.exceptionDetails.exception?.description || "page threw");
               return result.result.value;
            },
         };
         await waitFor(() => tab.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"),
            "the page");
         return tab;
      };

      const pageSymbols = (tab) => tab.eval(
         "(() => { const holder = document.getElementById('symbols');"
         + " if (!holder || holder.classList.contains('pending')) return null;"
         + " const s = holder.querySelectorAll('span em');"
         + " return s.length === 4 ? [...s].map(n => n.textContent).join(' ') : null; })()");

      console.log("the terminal hands it to the browser");

      const terminal = client(base, ["send", "--file", secretFile]);
      const link = await waitFor(() => terminal.link(), "the link from the terminal");
      check("the terminal prints a link the browser can open", link.startsWith(base + "/r/"), link);

      const page = await openTab(link);
      const fromPage = await waitFor(() => pageSymbols(page), "the symbols in the page");
      const fromTerminal = await waitFor(() => terminal.symbols(), "the symbols in the terminal");
      check("terminal and browser show the same four symbols", fromPage === fromTerminal,
         fromTerminal + " vs " + fromPage);

      await page.eval("document.getElementById('confirm').click()");

      const arrived = await waitFor(() => page.eval(
         "(() => { const s = document.getElementById('secret');"
         + " return !s || s.classList.contains('pending') ? null : s.textContent; })()"), "the secret");
      check("the browser reads what the terminal sent", arrived === SECRET, arrived);
      check("the terminal exits cleanly", await waitFor(async () => terminal.code === 0 || null,
         "the terminal to finish") === true);

      console.log("\nthe browser hands it to the terminal");

      const writer = await openTab(base + "/");
      await writer.eval("document.getElementById('pickSend').click()");
      await writer.eval(`document.getElementById('secret-input').value = ${JSON.stringify(SECRET)};
         document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);

      const pageLink = await waitFor(() => writer.eval(
         "document.getElementById('link').value || null"), "the link from the page");

      const reader = client(base, ["open", pageLink]);
      const readerSymbols = await waitFor(() => reader.symbols(), "the symbols in the terminal");
      const writerSymbols = await waitFor(() => pageSymbols(writer), "the symbols in the page");
      check("and the same four the other way round", readerSymbols === writerSymbols,
         readerSymbols + " vs " + writerSymbols);

      await writer.eval("document.getElementById('confirm').click()");
      await waitFor(() => writer.eval("!document.getElementById('handover').disabled || null"),
         "the handover button");
      await writer.eval("document.getElementById('handover').click()");

      await waitFor(async () => reader.code !== null || null, "the terminal to finish");
      check("the terminal reads what the browser sent", reader.out === SECRET, reader.out);
      check("and exits cleanly", reader.code === 0, String(reader.code));

   } finally {
      socket?.close();
      chrome.kill();
      server.kill("SIGINT");
      await sleep(300);
      rmSync(workdir, { recursive: true, force: true });
   }

   console.log(failures ? "\ninterop: " + failures + " failing" : "\ninterop: all good");
   process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error("interop: " + error.message); process.exit(1); });

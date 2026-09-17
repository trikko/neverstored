// Drives a real browser through a real exchange: two tabs, two key pairs,
// one secret handed over. Uses the DevTools protocol directly, no dependencies.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import assert from "node:assert/strict";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = "hunter2-correct-horse-battery-staple";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
   return new Promise((done) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
         const { port } = probe.address();
         probe.close(() => done(port));
      });
   });
}

async function waitFor(check, what, tries = 120) {
   for (let i = 0; i < tries; i++) {
      const value = await check();
      if (value) return value;
      await sleep(250);
   }
   throw new Error("timed out waiting for " + what);
}

class Devtools {
   constructor(url) { this.url = url; this.next = 1; this.pending = new Map(); }

   async open() {
      this.socket = new WebSocket(this.url);
      this.socket.onmessage = (event) => {
         const message = JSON.parse(event.data);
         const waiter = this.pending.get(message.id);
         if (!waiter) return;
         this.pending.delete(message.id);
         message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      };
      await new Promise((done, fail) => {
         this.socket.onopen = done;
         this.socket.onerror = () => fail(new Error("cannot reach " + this.url));
      });
      return this;
   }

   send(method, params = {}, sessionId) {
      const id = this.next++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.socket.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
   }

   close() { this.socket.close(); }
}

class Tab {
   constructor(devtools, sessionId) { this.devtools = devtools; this.sessionId = sessionId; }

   async eval(expression) {
      const result = await this.devtools.send("Runtime.evaluate",
         { expression, awaitPromise: true, returnByValue: true }, this.sessionId);
      if (result.exceptionDetails)
         throw new Error(result.exceptionDetails.exception?.description || "page threw");
      return result.result.value;
   }
}

async function main() {
   const port = await freePort();
   const debugPort = await freePort();
   const workdir = mkdtempSync(join(tmpdir(), "neverstored-browser-"));
   const profile = join(workdir, "profile");
   const base = "http://127.0.0.1:" + port;

   const server = spawn(join(ROOT, "neverstored"), [], {
      env: { ...process.env, NEVERSTORED_PORT: String(port), NEVERSTORED_SOCKET: join(workdir, "b.sock"),
         NEVERSTORED_NO_PROXY: "1" },
      stdio: "ignore",
   });

   const chrome = spawn("google-chrome", [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--user-data-dir=" + profile, "--remote-debugging-port=" + debugPort, "about:blank",
   ], { stdio: "ignore" });

   let devtools;
   let failures = 0;
   const check = (name, condition, detail = "") => {
      console.log((condition ? "  ok   " : "  FAIL ") + name + (condition ? "" : ": " + detail));
      if (!condition) failures++;
   };

   try {
      const version = await waitFor(async () => {
         try {
            const response = await fetch("http://127.0.0.1:" + debugPort + "/json/version");
            return response.ok ? response.json() : null;
         } catch { return null; }
      }, "the browser");

      devtools = await new Devtools(version.webSocketDebuggerUrl).open();

      const openTab = async (url) => {
         const { targetId } = await devtools.send("Target.createTarget", { url });
         const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
         const tab = new Tab(devtools, sessionId);
         await tab.eval("1");
         return tab;
      };

      const sender = await openTab(base + "/");
      await waitFor(() => sender.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");

      const intro = await sender.eval(
         "(() => { const block = document.querySelector('.intro');"
         + " return block && block.offsetParent !== null ? block.textContent : null; })()");
      check("the first screen explains what this is",
         intro && intro.includes("Your browser encrypts it"), String(intro).slice(0, 60));

      const noPathYet = await sender.eval("document.getElementById('steps').hidden");
      check("no path is shown before a direction is chosen", noPathYet === true);

      await sender.eval("document.getElementById('pickSend').click()");

      const introGone = await sender.eval(
         "(() => { const block = document.querySelector('.intro');"
         + " return !block || block.offsetParent === null; })()");
      check("and steps aside once there is work to do", introGone === true);

      const senderPath = await sender.eval(
         "[...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|')");
      check("the sender's path appears whole on the first click",
         senderPath === "1Write|2Share|3Verify|4Hand over", senderPath);

      const boxVisible = await sender.eval(
         "(() => { const b = document.getElementById('secret-input');"
         + " const r = b.getBoundingClientRect();"
         + " return b.offsetParent !== null && r.width > 200 && r.height > 100; })()");
      check("the writing box is actually visible after choosing to send", boxVisible === true);

      const focused = await sender.eval("document.activeElement.id");
      check("the writing box takes focus", focused === "secret-input", focused);
      await sender.eval(`document.getElementById('secret-input').value = ${JSON.stringify(SECRET)};
         document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);

      const link = await waitFor(() => sender.eval("document.getElementById('link').value || null"), "the link");
      check("the sender gets a room link", link.startsWith(base + "/r/"), link);

      const pathHeld = await sender.eval(
         "[...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|')");
      check("and does not change shape once the room exists",
         pathHeld === "1Write|2Share|3Verify|4Hand over", pathHeld);

      const quietLinkStage = await sender.eval(
         "(() => { const hidden = (v) => document.querySelector('[data-view=' + v + ']').hidden;"
         + " return hidden('verify') && hidden('handoff') && hidden('compose'); })()");
      check("while nobody is there, only the link is on screen", quietLinkStage === true);

      const qrPixels = await sender.eval(
         "(() => { const c = document.getElementById('qr'); return c.hidden ? 0 : c.width; })()");
      check("a scannable code is drawn for the link", qrPixels > 100, String(qrPixels));

      const codeFirst = await sender.eval(
         "(() => { const s = document.querySelector('[data-view=link]');"
         + " const box = s.querySelector('.qr-box'), field = s.querySelector('.field');"
         + " return box.compareDocumentPosition(field) === Node.DOCUMENT_POSITION_FOLLOWING; })()");
      check("the code comes first and the link sits under it", codeFirst === true);

      const countdown = await waitFor(
         () => sender.eval("(() => { const b = document.getElementById('expiry');"
            + " return b.hidden ? null : b.textContent; })()"), "the countdown");
      check("the room says how long it has left", /expires in \d+:\d\d/.test(countdown), countdown);

      const outOfTheWay = await sender.eval(
         "(() => { const b = document.getElementById('expiry');"
         + " return b.closest('#status') === null && b.parentElement.className === 'card'; })()");
      check("and keeps it out of the headline", outOfTheWay === true);

      const ticking = await waitFor(
         () => sender.eval("(() => { const b = document.getElementById('expiry');"
            + " return b.textContent !== " + JSON.stringify(countdown) + " ? b.textContent : null; })()"),
         "the countdown to move");
      check("and counts it down rather than sitting there", ticking !== countdown, ticking);

      const receiver = await openTab(link);
      await waitFor(() => receiver.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the room page");

      // The tiles are drawn empty from the start, so wait for them to carry the words.
      const symbolsOf = (tab) => tab.eval(
         "(() => { const holder = document.getElementById('symbols');"
         + " if (holder.classList.contains('pending')) return null;"
         + " const s = holder.querySelectorAll('span em');"
         + " return s.length ? [...s].map(n => n.textContent).join(' ') : null; })()");

      const symbolsVisible = await waitFor(() => sender.eval(
         "(() => { const s = document.querySelector('#symbols span');"
         + " return s ? s.offsetParent !== null : null; })()"), "the symbols to be on screen");
      check("the symbols are actually on screen", symbolsVisible === true);

      const receiverPath = await receiver.eval(
         "[...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|')");
      check("the recipient walks their own path, not the sender's",
         receiverPath === "1Open|2Verify|3Receive", receiverPath);

      const ends = (tab) => tab.eval(
         "document.getElementById('spot-from').textContent + ' -> '"
         + " + document.getElementById('spot-to').textContent");
      check("the track points away from the sender",
         (await ends(sender)) === "your device -> their device", await ends(sender));
      check("and towards the recipient",
         (await ends(receiver)) === "their device -> your device", await ends(receiver));

      const litForReceiver = await receiver.eval(
         "document.querySelector('#where b.lit').dataset.spot");
      check("while waiting, the secret is shown on the other device",
         litForReceiver === "from", litForReceiver);

      const waitingWasTold = await waitFor(() => sender.eval(
         "document.title.includes('Someone is here') || null"), "the arrival notice");
      check("whoever was waiting is told someone arrived", waitingWasTold === true);

      const openerWasNotTold = await receiver.eval("document.title");
      check("whoever opened the link is not told what they just did",
         !openerWasNotTold.includes("Someone is here"), openerWasNotTold);

      const senderSymbols = await waitFor(() => symbolsOf(sender), "the sender symbols");
      const receiverSymbols = await waitFor(() => symbolsOf(receiver), "the receiver symbols");
      check("both sides see the same four symbols", senderSymbols === receiverSymbols,
         senderSymbols + " vs " + receiverSymbols);
      check("there are four of them", senderSymbols.split(" ").length === 4, senderSymbols);

      const leakedToServer = await sender.eval(
         "(async () => { const r = await fetch('/api/poll', { method: 'POST',"
         + " headers: { 'content-type': 'application/json' },"
         + " body: JSON.stringify({ id: location.pathname, token: 'x' }) }); return (await r.text()); })()");
      check("the server has nothing to show without a token", leakedToServer.includes("notfound"));

      const drawnEarly = await sender.eval(
         "(() => { const b = document.getElementById('handover');"
         + " return b.offsetParent !== null && b.disabled; })()");
      check("the handover button is drawn, disabled, before both confirm", drawnEarly === true);

      const settledBefore = await sender.eval(
         "document.querySelector('[data-view=verify]').classList.contains('settled')");
      check("the symbols are live while they still matter", settledBefore === false);

      const nothingBefore = await receiver.eval(
         "document.querySelector('[data-view=reveal]').hidden");
      check("the arrival box does not exist before the arrival", nothingBefore === true);

      await sender.eval("document.getElementById('confirm').click()");

      const heldAfterOwnConfirm = await waitFor(() => sender.eval(
         "(() => { const b = document.getElementById('confirm');"
         + " const v = document.querySelector('[data-view=verify]');"
         + " return b.disabled && v.classList.contains('settled') ? b.textContent : null; })()"),
         "the confirmation to hold");
      check("confirming once is enough, and it shows", heldAfterOwnConfirm === "Confirmed",
         String(heldAfterOwnConfirm));

      const stillWaiting = await receiver.eval(
         "document.querySelector('[data-view=reveal]').hidden");
      check("and not while one side is still waiting for the other", stillWaiting === true);

      await receiver.eval("document.getElementById('confirm').click()");

      await waitFor(() => sender.eval(
         "!document.getElementById('handover').disabled"), "the handover button to unlock");

      const settledAfter = await sender.eval(
         "document.querySelector('[data-view=verify]').classList.contains('settled')");
      check("once confirmed, the symbols step back", settledAfter === true);
      await sender.eval("document.getElementById('handover').click()");

      // Handing over must not bounce back through the writing box on its way to the end.
      let bounced = false;
      for (let i = 0; i < 12; i++) {
         if (await sender.eval("!document.querySelector('[data-view=compose]').hidden"))
            bounced = true;
         await sleep(120);
      }
      check("the writing box never comes back after handing over", bounced === false);

      const revealArrived = await waitFor(() => receiver.eval(
         "!document.querySelector('[data-view=reveal]').hidden || null"), "the secret box");
      check("it arrives once both have confirmed", revealArrived === true);

      const revealed = await waitFor(() => receiver.eval(
         "(() => { const s = document.getElementById('secret');"
         + " return s.classList.contains('pending') ? null : s.textContent; })()"), "the secret");
      check("the recipient reads exactly what was sent", revealed === SECRET, revealed);

      const litAfter = await receiver.eval("document.querySelector('#where b.lit').dataset.spot");
      check("once delivered, the secret is shown on this device", litAfter === "to", litAfter);

      const placeholderShown = await receiver.eval(
         "document.getElementById('secret').textContent.length > 0");
      check("the box that will hold the secret is drawn in advance", placeholderShown === true);

      const stepState = (tab) => tab.eval(
         "(() => { const list = document.getElementById('steps');"
         + " const items = [...list.children];"
         + " return { total: items.length, at: items.findIndex(n => n.classList.contains('at')),"
         + "   complete: list.classList.contains('complete') }; })()");

      const receiverSteps = await waitFor(async () => {
         const s = await stepState(receiver);
         return s.complete ? s : null;
      }, "the recipient's steps to finish");
      check("the recipient's steps reach the end", receiverSteps.at === receiverSteps.total - 1,
         JSON.stringify(receiverSteps));

      const aloneOnScreen = await receiver.eval(
         "[...document.querySelectorAll('[data-view]')].filter(v => !v.hidden)"
         + ".map(v => v.dataset.view).join(',')");
      check("the secret gets the page to itself", aloneOnScreen === "reveal", aloneOnScreen);

      const copyReady = await receiver.eval(
         "!document.getElementById('copySecret').disabled");
      check("the recipient can copy what arrived", copyReady === true);

      const receiverAgain = await receiver.eval("document.getElementById('again').hidden");
      check("the recipient is not offered another exchange, they received", receiverAgain === true);

      const keepNoteGone = await receiver.eval("document.getElementById('keepNote').hidden");
      check("the waiting keep-it-safe note is hidden once it arrived", keepNoteGone === true);

      // The one who receives is told what the one who sends is told: the room is gone for
      // everyone, this copy is the only one left.
      const receiverNote = await receiver.eval(
         "(() => { const note = document.getElementById('goneNote');"
         + " return { shown: !note.hidden,"
         + "   text: note.textContent.replace(/\\s+/g, ' ').trim() }; })()");
      check("the arrival explains that the room is gone for everyone",
         receiverNote.shown === true && receiverNote.text.includes("the shared link"),
         JSON.stringify(receiverNote));
      check("and that this page is the only copy left",
         receiverNote.text.includes("the only place the secret exists now"),
         JSON.stringify(receiverNote));

      const revealLabel = await receiver.eval(
         "document.querySelector('[data-view=reveal] label').textContent");
      check("the box is labelled as the secret, not as 'here it is'",
         revealLabel === "The secret they sent you", revealLabel);

      // This one followed the link; the other flow's recipient sent it. "This link" would
      // be wrong for one of them, so neither is told whose link it was.
      const receiverEnding = await receiver.eval("document.getElementById('status').textContent");
      check("whoever receives is told the shared link leads nowhere",
         receiverEnding.includes("the shared link leads nowhere"), receiverEnding);

      const senderDone = await waitFor(() => sender.eval(
         "document.getElementById('status').textContent"
         + " === 'Delivered — it reached them. Nothing left to delete.' || null"), "delivery");
      check("the sender is told it went through", senderDone === true);

      const senderSteps = await waitFor(async () => {
         const s = await stepState(sender);
         return s.complete ? s : null;
      }, "the sender's steps to finish");
      check("the sender's steps reach the end", senderSteps.at === senderSteps.total - 1,
         JSON.stringify(senderSteps));

      const senderDoneScreen = await sender.eval(
         "(() => { const done = document.querySelector('[data-view=done]');"
         + " return { shown: !done.hidden, heading: done.querySelector('.verdict'),"
         + "   again: done.querySelector('a').textContent }; })()");
      check("the sender lands on a conclusive delivered screen", senderDoneScreen.shown === true,
         JSON.stringify(senderDoneScreen));
      check("the sender is offered another exchange",
         senderDoneScreen.again === "Send another secret", JSON.stringify(senderDoneScreen));
      // The recipient's final screen says it all in the status line; this one does too,
      // so a heading here would only repeat it.
      check("the delivered screen carries no heading of its own",
         senderDoneScreen.heading === null, JSON.stringify(senderDoneScreen));

      // Both flows land on this screen, one having sent the link and one having opened it,
      // so it must not claim either.
      const senderDoneWording = await sender.eval(
         "document.querySelector('[data-view=done]').textContent.replace(/\\s+/g, ' ')");
      check("the delivered screen speaks of the link without assuming who shared it",
         senderDoneWording.includes("the shared link")
         && !/link you (shared|opened)/.test(senderDoneWording), senderDoneWording.trim());

      const reopened = await openTab(link);
      await waitFor(() => reopened.eval("document.readyState === 'complete'"), "the reopened link");
      await sleep(1500);
      const afterwards = await reopened.eval("document.getElementById('status').textContent");
      check("reopening the link finds nothing", /nothing|gone|leads nowhere/i.test(afterwards), afterwards);

      const stillInPage = await receiver.eval("JSON.stringify(state).includes(" + JSON.stringify(SECRET) + ")");
      check("the app keeps no copy of the secret in its state", stillInPage === false);

      console.log("\n  asking someone else for a secret");

      const asker = await openTab(base + "/");
      await waitFor(() => asker.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");
      await asker.eval("document.getElementById('pickRequest').click()");

      const askLink = await waitFor(() => asker.eval(
         "document.getElementById('link').value || null"), "the request link");
      check("asking for a secret still gives a link", askLink.startsWith(base + "/r/"), askLink);

      const quietAskStage = await asker.eval(
         "(() => { const hidden = (v) => document.querySelector('[data-view=' + v + ']').hidden;"
         + " return hidden('verify') && hidden('reveal'); })()");
      check("the asker sees only the link until someone arrives", quietAskStage === true);

      const askQr = await asker.eval(
         "(() => { const c = document.getElementById('qr'); return c.hidden ? 0 : c.width; })()");
      check("and a code to scan", askQr > 100, String(askQr));

      const linkStays = await asker.eval(
         "!document.querySelector('[data-view=link]').hidden");
      check("the link stays on screen while nobody has arrived", linkStays === true);

      const askerPath = await asker.eval(
         "[...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|')");
      check("the asker walks a path without a writing step",
         askerPath === "1Share|2Verify|3Receive", askerPath);

      const writer = await openTab(askLink);
      await waitFor(() => writer.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the room page");
      await waitFor(() => writer.eval(
         "document.getElementById('secret-input').offsetParent !== null || null"), "the writing box");

      const OTHER = "second-secret-9f3a";
      await writer.eval(`document.getElementById('secret-input').value = ${JSON.stringify(OTHER)};
         document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);

      await waitFor(() => symbolsOf(writer), "symbols");
      await waitFor(() => symbolsOf(asker), "symbols");
      await writer.eval("document.getElementById('confirm').click()");
      await asker.eval("document.getElementById('confirm').click()");

      await waitFor(() => writer.eval("!document.getElementById('handover').disabled"), "the handover button");

      const oversized = await writer.eval(
         "(() => { const box = document.getElementById('secret-input');"
         + " box.value = 'x'.repeat(9 * 1024);"
         + " box.dispatchEvent(new Event('input'));"
         + " return { blocked: document.getElementById('handover').disabled,"
         + "   warned: !document.getElementById('tooBig').hidden }; })()");
      check("a secret past the limit cannot be handed over",
         oversized.blocked && oversized.warned, JSON.stringify(oversized));

      await writer.eval(`document.getElementById('secret-input').value = ${JSON.stringify(OTHER)};
         document.getElementById('secret-input').dispatchEvent(new Event('input'))`);

      const writerPath = await writer.eval(
         "[...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|')");
      check("the writer verifies before writing", writerPath === "1Open|2Verify|3Write|4Hand over",
         writerPath);

      const boxOrder = await writer.eval(
         "(() => { const v = document.querySelector('[data-view=verify]');"
         + " const c = document.querySelector('[data-view=compose]');"
         + " return (v.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })()");
      check("and the box sits under the symbols", boxOrder === true);

      const boxStays = await writer.eval(
         "(() => { const v = document.querySelector('[data-view=compose]');"
         + " return !v.hidden && document.getElementById('secret-input').value; })()");
      check("the writing box stays available after both confirmed", boxStays === OTHER, String(boxStays));

      const EDITED = OTHER + "-edited";
      await writer.eval(`document.getElementById('secret-input').value = ${JSON.stringify(EDITED)};
         document.getElementById('secret-input').dispatchEvent(new Event('input'))`);
      await writer.eval("document.getElementById('handover').click()");

      // The box is legitimately still there while the handover is in flight; what must
      // never happen is that it comes back once it has gone.
      await waitFor(() => writer.eval(
         "document.querySelector('[data-view=compose]').hidden || null"), "the box to close");

      let writerBounced = false;
      for (let i = 0; i < 12; i++) {
         if (await writer.eval("!document.querySelector('[data-view=compose]').hidden"))
            writerBounced = true;
         await sleep(120);
      }
      check("nor does it come back in the other flow", writerBounced === false);

      await waitFor(() => writer.eval(
         "document.querySelector('[data-view=done]').hidden ? null : true"),
         "the writer's delivered screen");

      const asked = await waitFor(() => asker.eval(
         "(() => { const s = document.getElementById('secret');"
         + " return s.classList.contains('pending') ? null : s.textContent; })()"), "the secret");
      check("the asker receives the edited text, not the first draft", asked === EDITED, asked);

      const askerEnd = await waitFor(async () => {
         const state = await asker.eval(
            "(() => { const list = document.getElementById('steps');"
            + " const items = [...list.children];"
            + " return { total: items.length, at: items.findIndex(n => n.classList.contains('at')),"
            + "   complete: list.classList.contains('complete'),"
            + "   again: document.getElementById('again').hidden }; })()");
         return state.complete ? state : null;
      }, "the asker's steps to finish");
      check("the asker's steps reach the end too", askerEnd.at === askerEnd.total - 1,
         JSON.stringify(askerEnd));
      check("and they are not offered another exchange either, they received",
         askerEnd.again === true, JSON.stringify(askerEnd));

      // They opened the room and sent the link away: "this link" would be a link they
      // never had on screen.
      const askerEnding = await asker.eval("document.getElementById('status').textContent");
      check("the asker is told the same, and not that they opened a link",
         askerEnding.includes("the shared link leads nowhere")
         && !askerEnding.includes("this link"), askerEnding);

   } finally {
      devtools?.close();
      chrome.kill();
      server.kill("SIGINT");
      await sleep(300);
      rmSync(workdir, { recursive: true, force: true });
   }

   console.log(failures ? "\nbrowser: " + failures + " failing" : "\nbrowser: all good");
   process.exit(failures ? 1 : 0);
}

main().catch((error) => { console.error("browser: " + error.message); process.exit(1); });

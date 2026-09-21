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

// Drives render() over every combination of what it reads and reports one line per
// case: the sections that are up, the step that is lit, which controls are off, which
// elements are hidden, where the secret is, and the status line. Each case starts from
// the same blank page, so a line says what render() wrote and nothing about the case
// before it — the `created` branch returns before it reaches half of these.
const RENDER_PROBE = `(() => {
   const OFF = ["handover", "continue", "confirm", "secret-input"];
   const GONE = ["lastStep", "handNote", "handQuote", "composeHint", "tooBig", "steps", "where"];
   const box = document.getElementById("secret-input");
   const out = [];

   // Every case starts from the same blank page, so a shape says what render() wrote and
   // nothing about the case before it: the \`created\` branch returns before it reaches
   // half of these, and would otherwise inherit them.
   const blank = () => {
      for (const id of OFF) document.getElementById(id).disabled = false;
      for (const id of GONE) document.getElementById(id).hidden = false;
      for (const view of document.querySelectorAll("[data-view]")) view.hidden = true;
      for (const dot of document.querySelectorAll("#where b")) dot.classList.remove("lit");
      const steps = document.getElementById("steps");
      steps.textContent = "";
      delete steps.dataset.shape;
      delete steps.dataset.at;
      document.getElementById("status").textContent = "";
   };

   const shape = () => {
      const views = [...document.querySelectorAll("[data-view]")]
         .filter((v) => !v.hidden).map((v) => v.dataset.view).join("+") || "-";
      const steps = [...document.querySelectorAll("#steps li")]
         .map((n) => (n.className === "at" ? "[" + n.textContent + "]" : n.textContent)).join("/") || "-";
      const off = OFF.map((id) => (document.getElementById(id).disabled ? "1" : "0")).join("");
      const gone = GONE.map((id) => (document.getElementById(id).hidden ? "1" : "0")).join("");
      const dot = document.querySelector("#where b.lit");
      return views + " | " + steps + " | " + off + " " + gone + " " + (dot ? dot.dataset.spot : "-")
         + " | " + document.getElementById("status").textContent;
   };

   for (const role of ["sender", "receiver"])
   for (const owner of [true, false])
   for (const said of ["created", "paired", "ready"])
   for (const confirmed of [false, true])
   for (const sent of [false, true])
   for (const secret of ["none", "held", "typed"]) {
      Object.assign(state, {
         role, owner, confirmed, sent, finished: false,
         // Every screen that draws symbols has derived them: a page that could not is
         // finished before render() is ever asked to draw it.
         room: "rrrrrrrr", token: "t", session: { symbols: [0, 1, 2, 3] }, step: "",
         secret: secret === "held" ? "s" : null,
         last: { state: said, ver: 1, role },
      });
      box.value = secret === "typed" ? "s" : "";
      blank();
      render();
      out.push([role, owner ? "owner" : "guest", said, confirmed ? "C" : "-", sent ? "S" : "-", secret]
         .join(",") + " => " + shape());
   }

   return out;
})()`;

// Recorded from the page as it was. A line that moves means the refactoring changed a
// screen, which is the one thing it must not do.
const RENDER_SHAPES = `
   sender,owner,created,-,-,none => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,-,-,held => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,-,-,typed => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,-,S,none => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,-,S,held => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,-,S,typed => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,C,-,none => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,C,-,held => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,C,-,typed => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,C,S,none => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,C,S,held => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,created,C,S,typed => link | 1Write/[2Share]/3Verify/4Send | 0000 0000000 from | This link is not a secret — it is just an address. Share it however you like.
   sender,owner,paired,-,-,none => verify | 1Write/2Share/[3Verify]/4Send | 1000 0011000 from | Someone is here. Check they see the same four symbols.
   sender,owner,paired,-,-,held => verify | 1Write/2Share/[3Verify]/4Send | 1000 0011000 from | Someone is here. Check they see the same four symbols.
   sender,owner,paired,-,-,typed => verify | 1Write/2Share/[3Verify]/4Send | 1000 0011000 from | Someone is here. Check they see the same four symbols.
   sender,owner,paired,-,S,none => verify | 1Write/2Share/[3Verify]/4Send | 1001 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,paired,-,S,held => verify | 1Write/2Share/[3Verify]/4Send | 1001 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,paired,-,S,typed => verify | 1Write/2Share/[3Verify]/4Send | 1001 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,paired,C,-,none => verify | 1Write/2Share/[3Verify]/4Send | 1010 0011000 from | Waiting for them to confirm the symbols.
   sender,owner,paired,C,-,held => verify | 1Write/2Share/[3Verify]/4Send | 1010 0011000 from | Waiting for them to confirm the symbols.
   sender,owner,paired,C,-,typed => verify | 1Write/2Share/[3Verify]/4Send | 1010 0011000 from | Waiting for them to confirm the symbols.
   sender,owner,paired,C,S,none => verify | 1Write/2Share/[3Verify]/4Send | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,paired,C,S,held => verify | 1Write/2Share/[3Verify]/4Send | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,paired,C,S,typed => verify | 1Write/2Share/[3Verify]/4Send | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,ready,-,-,none => handoff | 1Write/2Share/3Verify/[4Send] | 1010 0011000 from | They are waiting. Write the secret and send it.
   sender,owner,ready,-,-,held => handoff | 1Write/2Share/3Verify/[4Send] | 0010 0011100 from | They are waiting for you.
   sender,owner,ready,-,-,typed => handoff | 1Write/2Share/3Verify/[4Send] | 0010 0011100 from | They are waiting for you.
   sender,owner,ready,-,S,none => handoff | 1Write/2Share/3Verify/[4Send] | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,ready,-,S,held => handoff | 1Write/2Share/3Verify/[4Send] | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,ready,-,S,typed => handoff | 1Write/2Share/3Verify/[4Send] | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,ready,C,-,none => handoff | 1Write/2Share/3Verify/[4Send] | 1010 0011000 from | They are waiting. Write the secret and send it.
   sender,owner,ready,C,-,held => handoff | 1Write/2Share/3Verify/[4Send] | 0010 0011100 from | They are waiting for you.
   sender,owner,ready,C,-,typed => handoff | 1Write/2Share/3Verify/[4Send] | 0010 0011100 from | They are waiting for you.
   sender,owner,ready,C,S,none => handoff | 1Write/2Share/3Verify/[4Send] | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,ready,C,S,held => handoff | 1Write/2Share/3Verify/[4Send] | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,owner,ready,C,S,typed => handoff | 1Write/2Share/3Verify/[4Send] | 1011 1011000 from | Sent. Waiting for them to pick it up.
   sender,guest,created,-,-,none => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,-,-,held => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,-,-,typed => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,-,S,none => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,-,S,held => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,-,S,typed => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,C,-,none => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,C,-,held => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,C,-,typed => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,C,S,none => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,C,S,held => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,created,C,S,typed => waiting | [1Open]/2Verify/3Write/4Send | 0000 0000000 from | Connected. Waiting for the other side.
   sender,guest,paired,-,-,none => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   sender,guest,paired,-,-,held => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   sender,guest,paired,-,-,typed => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   sender,guest,paired,-,S,none => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1001 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,paired,-,S,held => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1001 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,paired,-,S,typed => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1001 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,paired,C,-,none => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1010 0101000 from | Waiting for them to confirm the symbols.
   sender,guest,paired,C,-,held => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1010 0101000 from | Waiting for them to confirm the symbols.
   sender,guest,paired,C,-,typed => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1010 0101000 from | Waiting for them to confirm the symbols.
   sender,guest,paired,C,S,none => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,paired,C,S,held => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,paired,C,S,typed => verify+compose+handoff | 1Open/[2Verify]/3Write/4Send | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,ready,-,-,none => verify+compose+handoff | 1Open/2Verify/[3Write]/4Send | 1010 0101000 from | They are waiting. Write the secret and send it.
   sender,guest,ready,-,-,held => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 0010 0101100 from | They are waiting for you.
   sender,guest,ready,-,-,typed => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 0010 0101100 from | They are waiting for you.
   sender,guest,ready,-,S,none => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,ready,-,S,held => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,ready,-,S,typed => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,ready,C,-,none => verify+compose+handoff | 1Open/2Verify/[3Write]/4Send | 1010 0101000 from | They are waiting. Write the secret and send it.
   sender,guest,ready,C,-,held => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 0010 0101100 from | They are waiting for you.
   sender,guest,ready,C,-,typed => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 0010 0101100 from | They are waiting for you.
   sender,guest,ready,C,S,none => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,ready,C,S,held => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   sender,guest,ready,C,S,typed => verify+compose+handoff | 1Open/2Verify/3Write/[4Send] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,created,-,-,none => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,-,-,held => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,-,-,typed => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,-,S,none => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,-,S,held => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,-,S,typed => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,C,-,none => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,C,-,held => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,C,-,typed => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,C,S,none => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,C,S,held => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,created,C,S,typed => link | [1Share]/2Verify/3Receive | 0000 0000000 - | Share this link with them and they will write the secret on their side.
   receiver,owner,paired,-,-,none => verify | 1Share/[2Verify]/3Receive | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   receiver,owner,paired,-,-,held => verify | 1Share/[2Verify]/3Receive | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   receiver,owner,paired,-,-,typed => verify | 1Share/[2Verify]/3Receive | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   receiver,owner,paired,-,S,none => verify | 1Share/[2Verify]/3Receive | 1001 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,paired,-,S,held => verify | 1Share/[2Verify]/3Receive | 1001 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,paired,-,S,typed => verify | 1Share/[2Verify]/3Receive | 1001 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,paired,C,-,none => verify | 1Share/[2Verify]/3Receive | 1010 0101000 from | Waiting for them to confirm the symbols.
   receiver,owner,paired,C,-,held => verify | 1Share/[2Verify]/3Receive | 1010 0101000 from | Waiting for them to confirm the symbols.
   receiver,owner,paired,C,-,typed => verify | 1Share/[2Verify]/3Receive | 1010 0101000 from | Waiting for them to confirm the symbols.
   receiver,owner,paired,C,S,none => verify | 1Share/[2Verify]/3Receive | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,paired,C,S,held => verify | 1Share/[2Verify]/3Receive | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,paired,C,S,typed => verify | 1Share/[2Verify]/3Receive | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,ready,-,-,none => verify | 1Share/2Verify/[3Receive] | 1010 0101000 from | Both confirmed. Waiting for them to send it.
   receiver,owner,ready,-,-,held => verify | 1Share/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,owner,ready,-,-,typed => verify | 1Share/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,owner,ready,-,S,none => verify | 1Share/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,ready,-,S,held => verify | 1Share/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,ready,-,S,typed => verify | 1Share/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,ready,C,-,none => verify | 1Share/2Verify/[3Receive] | 1010 0101000 from | Both confirmed. Waiting for them to send it.
   receiver,owner,ready,C,-,held => verify | 1Share/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,owner,ready,C,-,typed => verify | 1Share/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,owner,ready,C,S,none => verify | 1Share/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,ready,C,S,held => verify | 1Share/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,owner,ready,C,S,typed => verify | 1Share/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,created,-,-,none => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,-,-,held => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,-,-,typed => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,-,S,none => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,-,S,held => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,-,S,typed => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,C,-,none => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,C,-,held => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,C,-,typed => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,C,S,none => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,C,S,held => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,created,C,S,typed => waiting | [1Open]/2Verify/3Receive | 0000 0000000 - | Connected. Waiting for the other side.
   receiver,guest,paired,-,-,none => verify | 1Open/[2Verify]/3Receive | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   receiver,guest,paired,-,-,held => verify | 1Open/[2Verify]/3Receive | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   receiver,guest,paired,-,-,typed => verify | 1Open/[2Verify]/3Receive | 1000 0101000 from | Someone is here. Check they see the same four symbols.
   receiver,guest,paired,-,S,none => verify | 1Open/[2Verify]/3Receive | 1001 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,paired,-,S,held => verify | 1Open/[2Verify]/3Receive | 1001 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,paired,-,S,typed => verify | 1Open/[2Verify]/3Receive | 1001 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,paired,C,-,none => verify | 1Open/[2Verify]/3Receive | 1010 0101000 from | Waiting for them to confirm the symbols.
   receiver,guest,paired,C,-,held => verify | 1Open/[2Verify]/3Receive | 1010 0101000 from | Waiting for them to confirm the symbols.
   receiver,guest,paired,C,-,typed => verify | 1Open/[2Verify]/3Receive | 1010 0101000 from | Waiting for them to confirm the symbols.
   receiver,guest,paired,C,S,none => verify | 1Open/[2Verify]/3Receive | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,paired,C,S,held => verify | 1Open/[2Verify]/3Receive | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,paired,C,S,typed => verify | 1Open/[2Verify]/3Receive | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,ready,-,-,none => verify | 1Open/2Verify/[3Receive] | 1010 0101000 from | Both confirmed. Waiting for them to send it.
   receiver,guest,ready,-,-,held => verify | 1Open/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,guest,ready,-,-,typed => verify | 1Open/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,guest,ready,-,S,none => verify | 1Open/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,ready,-,S,held => verify | 1Open/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,ready,-,S,typed => verify | 1Open/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,ready,C,-,none => verify | 1Open/2Verify/[3Receive] | 1010 0101000 from | Both confirmed. Waiting for them to send it.
   receiver,guest,ready,C,-,held => verify | 1Open/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,guest,ready,C,-,typed => verify | 1Open/2Verify/[3Receive] | 0010 0101100 from | Both confirmed. Waiting for them to send it.
   receiver,guest,ready,C,S,none => verify | 1Open/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,ready,C,S,held => verify | 1Open/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
   receiver,guest,ready,C,S,typed => verify | 1Open/2Verify/[3Receive] | 1011 1101000 from | Sent. Waiting for them to pick it up.
`;

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

      // Every link but the ones under test is followed the way a person follows it.
      const enterRoom = async (url, phone = false) => {
         const tab = await openTab(url, phone);
         await waitFor(() => tab.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"),
            "the room page");
         await waitFor(() => tab.eval("!!document.getElementById('arrive') || null"), "the arrival gate");
         await tab.eval("document.getElementById('arrive').click(), 1");
         return tab;
      };

      const openTab = async (url, phone = false) => {
         const { targetId } = await devtools.send("Target.createTarget", { url });
         const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
         if (phone) {
            await devtools.send("Emulation.setDeviceMetricsOverride",
               { width: 390, height: 780, deviceScaleFactor: 2, mobile: true }, sessionId);
            await devtools.send("Emulation.setTouchEmulationEnabled",
               { enabled: true, maxTouchPoints: 5 }, sessionId);
         }
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
         senderPath === "1Write|2Share|3Verify|4Send", senderPath);

      const boxVisible = await sender.eval(
         "(() => { const b = document.getElementById('secret-input');"
         + " const r = b.getBoundingClientRect();"
         + " return b.offsetParent !== null && r.width > 200 && r.height > 100; })()");
      check("the writing box is actually visible after choosing to send", boxVisible === true);

      const focused = await sender.eval("document.activeElement.id");
      check("the writing box takes focus", focused === "secret-input", focused);

      // Pressing it with nothing written does nothing at all today, which reads as a
      // broken button rather than as a step not yet earned.
      const shutWhileEmpty = await sender.eval("document.getElementById('continue').disabled");
      check("there is nothing to continue to while the box is empty", shutWhileEmpty === true);

      const gate = await sender.eval(
         "(() => { const b = document.getElementById('secret-input');"
         + " const c = document.getElementById('continue');"
         + " b.value = 'x'; b.dispatchEvent(new Event('input'));"
         + " const opened = !c.disabled;"
         + " b.value = ''; b.dispatchEvent(new Event('input'));"
         + " return { opened, shutAgain: c.disabled }; })()");
      check("it opens on the first character and shuts again if the box is emptied",
         gate.opened === true && gate.shutAgain === true, JSON.stringify(gate));

      // Nothing on this screen has mentioned a link or the symbols yet, so neither the
      // hint nor the button may lean on something the reader has not met.
      const firstHint = await sender.eval(
         "(() => { const h = document.getElementById('composeHint');"
         + " return h.hidden ? null : h.textContent.replace(/\\s+/g, ' ').trim(); })()");
      check("the hint under the box speaks of what is on screen, not of symbols yet to come",
         firstHint !== null && !/symbol/i.test(firstHint) && /link/i.test(firstHint),
         String(firstHint));

      const continueLabel = await sender.eval(
         "document.getElementById('continue').textContent.replace(/\\s+/g, ' ').trim()");
      check("the button under the box names where it leads, not what it withholds",
         continueLabel === "Get the link to share", continueLabel);
      await sender.eval(`document.getElementById('secret-input').value = ${JSON.stringify(SECRET)};
         document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);

      const link = await waitFor(() => sender.eval("document.getElementById('link').value || null"), "the link");
      check("the sender gets a room link", link.startsWith(base + "/r/"), link);

      const linkWording = await sender.eval(
         "(() => { const l = document.querySelector('[data-view=link] label');"
         + " return { label: l.textContent.replace(/\\s+/g, ' ').trim(),"
         + "   status: document.getElementById('status').textContent }; })()");
      check("the link is shared, never sent: the secret is the only thing that is sent",
         linkWording.label === "Share this link with them"
         && !/\bsen[dt]\b/i.test(linkWording.status), JSON.stringify(linkWording));

      // Three buttons copy something; a button that answers "copied" next to one that
      // answers "Copied" reads as two different things happening.
      const copiedLink = await sender.eval(
         "(() => { const b = document.getElementById('copyLink'); const before = b.offsetWidth;"
         + " b.click();"
         + " return { text: b.textContent, before, after: b.offsetWidth }; })()");
      check("copying the link says so the way every other button does",
         copiedLink.text === "Copied", copiedLink.text);

      // The answer arrives under the pointer: a button that grows while saying it has
      // moved the thing that was just clicked.
      check("and the button keeps the size it was clicked at",
         copiedLink.before === copiedLink.after, JSON.stringify(copiedLink));

      const pathHeld = await sender.eval(
         "[...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|')");
      check("and does not change shape once the room exists",
         pathHeld === "1Write|2Share|3Verify|4Send", pathHeld);

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

      const receiver = await enterRoom(link);
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

      // A full room is the one case where the page knows perfectly well what is going on,
      // so it must not fall back on the "we cannot tell the difference" screen.
      const third = await enterRoom(link);
      await waitFor(() => third.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the room page");
      const crowded = await waitFor(() => third.eval(
         "(() => { const s = document.querySelector('[data-view=occupied]');"
         + " return s && !s.hidden ? (document.getElementById('status').textContent + ' ' "
         + " + s.textContent).replace(/\\s+/g, ' ') : null; })()"), "the full-room screen");
      check("a third arrival is told the room is full", /already in this room/.test(crowded), crowded.trim());
      check("and is not told the link leads nowhere",
         !/leads nowhere|never existed|Nothing here/.test(crowded), crowded.trim());

      const openerWasNotTold = await receiver.eval("document.title");
      check("whoever opened the link is not told what they just did",
         !openerWasNotTold.includes("Someone is here"), openerWasNotTold);

      const senderSymbols = await waitFor(() => symbolsOf(sender), "the sender symbols");
      const receiverSymbols = await waitFor(() => symbolsOf(receiver), "the receiver symbols");
      // The warning that stops a man-in-the-middle is the last place to spend an idiom
      // a reader may not have.
      const mismatch = await sender.eval(
         "document.getElementById('mismatchNote').textContent.replace(/\\s+/g, ' ').trim()");
      check("the warning against a stranger in the middle says it plainly",
         /someone is in the middle/i.test(mismatch) && !/hand/i.test(mismatch), mismatch);

      check("both sides see the same four symbols", senderSymbols === receiverSymbols,
         senderSymbols + " vs " + receiverSymbols);
      check("there are four of them", senderSymbols.split(" ").length === 4, senderSymbols);

      const leakedToServer = await sender.eval(
         "(async () => { const r = await fetch('/api/poll', { method: 'POST',"
         + " headers: { 'content-type': 'application/json' },"
         + " body: JSON.stringify({ id: location.pathname, token: 'x' }) }); return (await r.text()); })()");
      check("the server has nothing to show without a token", leakedToServer.includes("notfound"));

      // Whoever wrote before sharing the link reaches the handover as a screen of its
      // own, so here it is not on the symbols screen at all — and neither is the line
      // about the last step, nor a gap where either of them would be.
      const drawnEarly = await sender.eval(
         "(() => { const h = document.querySelector('[data-view=handoff]');"
         + " return { shown: document.getElementById('handover').offsetParent !== null,"
         + "   room: h.getBoundingClientRect().height,"
         + "   warned: document.getElementById('lastStep').offsetParent !== null }; })()");
      check("no handover button is offered while it could not be pressed",
         drawnEarly.shown === false, JSON.stringify(drawnEarly));
      check("and it leaves no empty room under the symbols either",
         drawnEarly.room === 0 && drawnEarly.warned === false, JSON.stringify(drawnEarly));

      const quietEarly = await sender.eval("document.title");
      check("and nothing claims it is the sender's turn before it is",
         !quietEarly.includes("Your turn"), quietEarly);

      const settledBefore = await sender.eval(
         "document.querySelector('[data-view=verify]').classList.contains('settled')");
      check("the symbols are live while they still matter", settledBefore === false);

      const copiedSymbols = await sender.eval(
         "(() => { document.getElementById('copySymbols').click();"
         + " return document.getElementById('copySymbols').textContent; })()");
      check("copying the symbols answers in the same word too", copiedSymbols === "Copied",
         copiedSymbols);

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

      // Whoever holds the secret has just spent a minute comparing symbols somewhere else,
      // so the moment it becomes their turn has to reach them off the page as well.
      const turnAnnounced = await waitFor(() => sender.eval(
         "document.title.includes('Your turn') || null"), "the sender's turn notice");
      check("the sender is told it is their turn, tab in the background or not",
         turnAnnounced === true);

      const handoffAlone = await waitFor(() => sender.eval(
         "(() => { const v = document.querySelector('[data-view=verify]');"
         + " const h = document.querySelector('[data-view=handoff]');"
         + " return v.hidden && !h.hidden ? true : null; })()"),
         "the handover screen");
      check("whoever wrote before sharing reaches a screen of its own to hand it over",
         handoffAlone === true);

      const handWording = await sender.eval(
         "(() => { const p = document.querySelector('[data-view=handoff] p:not([hidden])');"
         + " return { text: p.textContent.replace(/\\s+/g, ' ').trim(),"
         + "   quoted: p.classList.contains('note') }; })()");
      check("and reads it as plain text, not as an aside", handWording.quoted === false);
      check("which says it has not gone anywhere yet",
         /not|nothing/i.test(handWording.text) && /press/i.test(handWording.text),
         handWording.text);

      const askedToAct = await sender.eval(
         "document.getElementById('status').textContent + ' '"
         + " + document.querySelector('[data-view=handoff]').textContent");
      check("and the sender is told the other side is waiting on them",
         /waiting/i.test(askedToAct), askedToAct.replace(/\s+/g, " ").trim());

      // The one string people act on. The icon carries no text of its own, so the label
      // stays exact, and it must not speak to a reader who hears it read out.
      const goButton = await sender.eval(
         "(() => { const h = document.getElementById('handover');"
         + " const icon = h.querySelector('svg');"
         + " return { label: h.textContent.replace(/\\s+/g, ' ').trim(),"
         + "   drawn: !!icon, quiet: icon ? icon.getAttribute('aria-hidden') === 'true' : false }; })()");
      check("the last button names the act in words a learner has",
         goButton.label === "Send it now", JSON.stringify(goButton));
      check("and carries a drawn icon, not a character borrowed from the symbols",
         goButton.drawn && goButton.quiet, JSON.stringify(goButton));

      const finality = await sender.eval(
         "(() => { const p = document.getElementById('lastStep');"
         + " return p ? { shown: !p.hidden, text: p.textContent.replace(/\\s+/g, ' ').trim() }"
         + "   : { shown: false, text: '' }; })()");
      check("with a line saying this one is the last and cannot be taken back",
         finality.shown && /last step/i.test(finality.text) && /undone/i.test(finality.text),
         JSON.stringify(finality));

      // The pointer arriving must not take the paint off it: the hover shorthand drops the
      // gradient at once, and the colour it replaces it with starts from nothing.
      const hoverSpot = await sender.eval(
         "(() => { const r = document.getElementById('handover').getBoundingClientRect();"
         + " return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
      await devtools.send("Input.dispatchMouseEvent",
         { type: "mouseMoved", x: hoverSpot.x, y: hoverSpot.y }, sender.sessionId);
      const hovered = await sender.eval(
         "(() => { const c = getComputedStyle(document.getElementById('handover'));"
         + " return { image: c.backgroundImage, colour: c.backgroundColor }; })()");
      check("hovering the handover never leaves it unpainted",
         hovered.image !== "none", JSON.stringify(hovered));

      const pressSnapshot = "(() => { const h = document.getElementById('handover');"
         + " const r = h.getBoundingClientRect();"
         + " return { label: h.textContent, top: r.top, scroll: window.scrollY,"
         + "   steps: [...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|') }; })()";

      const beforePress = await sender.eval(pressSnapshot);
      await sender.eval("document.getElementById('handover').click()");
      await waitFor(() => sender.eval(
         "/Sent\\./.test(document.getElementById('status').textContent) || null"), "the sent notice");
      const afterPress = await sender.eval(pressSnapshot);

      check("pressing it leaves the button where and what it was",
         afterPress.label === beforePress.label && Math.abs(afterPress.top - beforePress.top) < 1
            && afterPress.scroll === beforePress.scroll,
         JSON.stringify(beforePress) + " -> " + JSON.stringify(afterPress));
      check("and does not walk the steps back",
         afterPress.steps === beforePress.steps, beforePress.steps + " -> " + afterPress.steps);

      const finalityGone = await sender.eval(
         "(() => { const p = document.getElementById('lastStep'); return p ? p.hidden : null; })()");
      check("and takes the warning with it: there is nothing left to undo",
         finalityGone === true, String(finalityGone));

      // Handing over must not bounce back through the writing box on its way to the end,
      // nor rearrange the screen it was pressed on: the only screen it may lead to is the
      // one that ends the exchange.
      let bounced = false;
      let stripped = false;
      for (let i = 0; i < 12; i++) {
         const now = await sender.eval(
            "(() => { const v = document.querySelector('[data-view=verify]');"
            + " const c = document.querySelector('[data-view=compose]');"
            + " const h = document.querySelector('[data-view=handoff]');"
            + " return { box: !c.hidden, symbols: !v.hidden, hand: !h.hidden }; })()");
         if (now.box) bounced = true;
         if (now.hand && now.symbols) stripped = true;
         await sleep(120);
      }
      check("the writing box never comes back after handing over", bounced === false);
      check("and the handover screen is not rebuilt while it waits", stripped === false);

      const titleCalmed = await waitFor(() => sender.eval(
         "!document.title.includes('Your turn') || null"), "the title to settle");
      check("and the tab stops asking once it has been handed over", titleCalmed === true);

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

      const copiedSecret = await receiver.eval(
         "(() => { document.getElementById('copySecret').click();"
         + " return document.getElementById('copySecret').textContent; })()");
      check("and the button answers in the same word as the others", copiedSecret === "Copied",
         copiedSecret);

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

      // The track is the one thing on screen that says where the secret is. Going dark at
      // the end reads as "nowhere", on the screen that exists to say it arrived.
      const litAtEnd = await sender.eval(
         "(() => { const dot = document.querySelector('#where b.lit');"
         + " return { spot: dot ? dot.dataset.spot : null,"
         + "   shown: !document.getElementById('where').hidden }; })()");
      check("and the track still points at the device it reached",
         litAtEnd.shown && litAtEnd.spot === "to", JSON.stringify(litAtEnd));
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

      const reopened = await enterRoom(link);
      await waitFor(() => reopened.eval("document.readyState === 'complete'"), "the reopened link");
      await sleep(1500);
      const afterwards = await reopened.eval("document.getElementById('status').textContent");
      check("reopening the link finds nothing", /nothing|gone|leads nowhere/i.test(afterwards), afterwards);

      const stillInPage = await receiver.eval("JSON.stringify(state).includes(" + JSON.stringify(SECRET) + ")");
      check("the app keeps no copy of the secret in its state", stillInPage === false);

      // Over plain http on a LAN address WebCrypto is missing, and the page knows exactly
      // why — so it must not offer the screen it shows for a room it cannot account for.
      const insecure = await openTab(base + "/");
      await waitFor(() => insecure.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");
      const refusal = await insecure.eval(
         "(() => { Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });"
         + " wire();"
         + " const s = document.querySelector('[data-view=insecure]');"
         + " return s.hidden ? null : (document.getElementById('status').textContent + ' '"
         + " + s.textContent).replace(/\\s+/g, ' '); })()");
      check("without a secure context the page says so", /secure connection/.test(String(refusal)), String(refusal).trim());
      check("and does not pretend the link leads nowhere",
         refusal !== null && !/leads nowhere|never existed|Nothing here/.test(refusal), String(refusal).trim());
      const noPathThere = await insecure.eval("document.getElementById('steps').hidden");
      check("and shows no path it cannot walk", noPathThere === true);

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

      const writer = await enterRoom(askLink);
      await waitFor(() => writer.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the room page");
      await waitFor(() => writer.eval(
         "document.getElementById('secret-input').offsetParent !== null || null"), "the writing box");

      const OTHER = "second-secret-9f3a";
      await writer.eval(`document.getElementById('secret-input').value = ${JSON.stringify(OTHER)};
         document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);

      await waitFor(() => symbolsOf(writer), "symbols");
      await waitFor(() => symbolsOf(asker), "symbols");

      // Writing inside someone else's room is one screen from start to finish: the button
      // is on it from the moment there is a box to fill, out of reach until it is earned.
      const offeredEarly = await writer.eval(
         "(() => { const b = document.getElementById('handover');"
         + " const q = document.querySelector('[data-view=handoff] p.note');"
         + " return { shown: b.offsetParent !== null, locked: b.disabled,"
         + "   quoted: q !== null && q.offsetParent !== null,"
         + "   text: q ? q.textContent.replace(/\\s+/g, ' ').trim() : '' }; })()");
      check("the writer is shown the handover before it can be pressed",
         offeredEarly.shown && offeredEarly.locked, JSON.stringify(offeredEarly));

      // The gradient is set through the background shorthand, which leaves no colour
      // under it: drop the image for a disabled button and what is left is white on
      // white — a gap under the symbols where a step out of reach should be.
      const paintOf = "(() => { const c = getComputedStyle(document.getElementById('handover'));"
         + " const alpha = (v) => { const m = v.match(/[\\d.]+/g); return m ? (m.length > 3 ? +m[3] : 1) : 0; };"
         + " return { image: c.backgroundImage, colour: c.backgroundColor,"
         + "   painted: c.backgroundImage !== 'none' || alpha(c.backgroundColor) > 0.1 }; })()";
      const writerLockedPaint = await writer.eval(paintOf);
      check("and drawn as a button while it waits, not as a gap under the symbols",
         writerLockedPaint.painted === true, JSON.stringify(writerLockedPaint));

      // Out of reach is not the same as pressable: the pointer must not repaint it.
      const lockedSpot = await writer.eval(
         "(() => { const b = document.getElementById('handover'); window.wasAt = window.scrollY;"
         + " b.scrollIntoView({ block: 'center' });"
         + " const r = b.getBoundingClientRect();"
         + " return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
      const restPaintInView = await writer.eval(paintOf);
      await devtools.send("Input.dispatchMouseEvent",
         { type: "mouseMoved", x: lockedSpot.x, y: lockedSpot.y }, writer.sessionId);
      // The paint is under a transition, so read it once it has had time to change.
      await sleep(400);
      const hoveredPaint = await writer.eval(paintOf);
      await devtools.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }, writer.sessionId);
      await writer.eval("window.scrollTo(0, window.wasAt)");
      check("and does not light up under a pointer while it is out of reach",
         hoveredPaint.image === restPaintInView.image && hoveredPaint.colour === restPaintInView.colour,
         JSON.stringify(restPaintInView) + " -> " + JSON.stringify(hoveredPaint));
      check("with the promise quoted above it", offeredEarly.quoted === true);
      check("and the promise says both what holds it here and what pressing costs",
         /stays in this page/i.test(offeredEarly.text)
            && /only moment anything leaves your device/i.test(offeredEarly.text),
         offeredEarly.text);

      // One screen from start to finish: what it ends with is on it from the beginning,
      // the button and the line that says what pressing it costs.
      const finalityHeld = await writer.eval(
         "(() => { const h = document.getElementById('handover');"
         + " const p = document.getElementById('lastStep');"
         + " return { locked: h.disabled, warned: p.offsetParent !== null,"
         + "   text: p.textContent.replace(/\\s+/g, ' ').trim() }; })()");
      check("and the line under it says from the start what that press costs",
         finalityHeld.locked === true && finalityHeld.warned === true
            && /last step/i.test(finalityHeld.text) && /undone/i.test(finalityHeld.text),
         JSON.stringify(finalityHeld));

      const hintNotRepeated = await writer.eval(
         "(() => { const h = document.querySelector('[data-view=compose] .hint');"
         + " return h === null || h.offsetParent === null; })()");
      check("and is not told the same thing twice under the box", hintNotRepeated === true);

      await writer.eval("document.getElementById('confirm').click()");

      // This used to prove less than it looked: show() refocused the box on every render,
      // and that focus scrolled it back into view however much the page above it had
      // changed height. Now nothing pulls it back, so top and scroll are the whole claim.
      const placeWas = await writer.eval(
         "(() => { const b = document.getElementById('secret-input').getBoundingClientRect();"
         + " return { top: b.top, scroll: window.scrollY }; })()");

      // Focus taken once, when the box arrives, is a convenience. Focus taken again
      // whenever the other side does something is a trap: it drags the reader back into
      // the box they deliberately left, and on a phone it reopens the keyboard.
      await writer.eval("document.getElementById('secret-input').blur()");

      await asker.eval("document.getElementById('confirm').click()");

      await waitFor(() => writer.eval("!document.getElementById('handover').disabled"), "the handover button");

      const stillAway = await writer.eval("document.activeElement.id");
      check("focus left the box stays left when their turn arrives",
         stillAway !== "secret-input", stillAway);

      const placeNow = await writer.eval(
         "(() => { const b = document.getElementById('secret-input').getBoundingClientRect();"
         + " return { top: b.top, scroll: window.scrollY }; })()");
      check("nothing moves under the caret when it becomes the writer's turn",
         Math.abs(placeNow.top - placeWas.top) < 1 && placeNow.scroll === placeWas.scroll,
         JSON.stringify(placeWas) + " -> " + JSON.stringify(placeNow));

      const writerTold = await waitFor(() => writer.eval(
         "document.title.includes('Your turn') || null"), "the writer's turn notice");
      check("the writer is told it is their turn in this direction too", writerTold === true);

      // Here a caret may be sitting in the box when the other side confirms, so the
      // handover arrives under it and everything above it stays where it was.
      const writerKeeps = await writer.eval(
         "(() => { const c = document.querySelector('[data-view=compose]');"
         + " const h = document.querySelector('[data-view=handoff]');"
         + " return { box: !c.hidden, hand: !h.hidden }; })()");
      check("the writer keeps the box, and the handover arrives with it",
         writerKeeps.box && writerKeeps.hand, JSON.stringify(writerKeeps));

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
      check("the writer verifies before writing", writerPath === "1Open|2Verify|3Write|4Send",
         writerPath);

      const writerGo = await writer.eval(
         "document.getElementById('handover').textContent.replace(/\\s+/g, ' ').trim()");
      check("and reads the same last button as the other way round", writerGo === "Send it now",
         writerGo);

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
      const writerSnapshot = "(() => { const h = document.getElementById('handover');"
         + " const b = document.getElementById('secret-input');"
         + " return { label: h.textContent, top: h.getBoundingClientRect().top,"
         + "   boxTop: b.getBoundingClientRect().top, scroll: window.scrollY,"
         + "   steps: [...document.querySelectorAll('#steps li')].map(n => n.textContent).join('|') }; })()";

      const writerBefore = await writer.eval(writerSnapshot);
      await writer.eval("document.getElementById('handover').click()");
      await waitFor(() => writer.eval(
         "document.getElementById('secret-input').disabled || null"), "the box to go quiet");
      const writerAfter = await writer.eval(writerSnapshot);

      check("pressing it leaves this screen exactly as it was, too",
         writerAfter.label === writerBefore.label
            && Math.abs(writerAfter.top - writerBefore.top) < 1
            && Math.abs(writerAfter.boxTop - writerBefore.boxTop) < 1
            && writerAfter.scroll === writerBefore.scroll,
         JSON.stringify(writerBefore) + " -> " + JSON.stringify(writerAfter));
      check("and does not walk the steps back either",
         writerAfter.steps === writerBefore.steps,
         writerBefore.steps + " -> " + writerAfter.steps);

      const boxQuiet = await writer.eval(
         "(() => { const b = document.getElementById('secret-input');"
         + " return { held: b.value, shut: b.disabled, shown: b.offsetParent !== null }; })()");
      check("the box keeps its place and its text, out of use rather than emptied",
         boxQuiet.held === EDITED && boxQuiet.shut && boxQuiet.shown, JSON.stringify(boxQuiet));

      let writerBounced = false;
      let writerStripped = false;
      for (let i = 0; i < 12; i++) {
         const now = await writer.eval(
            "(() => { const c = document.querySelector('[data-view=compose]');"
            + " const v = document.querySelector('[data-view=verify]');"
            + " const h = document.querySelector('[data-view=handoff]');"
            + " return { box: !c.hidden, symbols: !v.hidden, hand: !h.hidden }; })()");
         if (now.hand && !now.box) writerBounced = true;
         if (now.hand && !now.symbols) writerStripped = true;
         await sleep(120);
      }
      check("and never leaves while the pickup is waited for", writerBounced === false);
      check("and pressing it rearranges nothing while it waits", writerStripped === false);

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

      console.log("\n  writing on a phone");

      const phone = await openTab(base + "/", true);
      await waitFor(() => phone.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");

      const coarse = await phone.eval("matchMedia('(pointer: coarse)').matches");
      check("the emulated device reports a finger, not a mouse", coarse === true);

      await phone.eval("document.getElementById('pickSend').click()");

      // Focusing the box raises the keyboard over the screen that says what is about to
      // happen, before the reader has read it. A tap is cheaper than that.
      const phoneFocus = await phone.eval(
         "(() => { const b = document.getElementById('secret-input');"
         + " return { visible: b.offsetParent !== null, focused: document.activeElement.id }; })()");
      check("the box is there to be tapped, and does not raise the keyboard by itself",
         phoneFocus.visible === true && phoneFocus.focused !== "secret-input",
         JSON.stringify(phoneFocus));

      console.log("\n  a poll that goes wrong");

      const startRoom = async (tab) => {
         await waitFor(() => tab.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");
         await tab.eval("document.getElementById('pickSend').click()");
         await tab.eval(`document.getElementById('secret-input').value = ${JSON.stringify(SECRET)};
            document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);
         return waitFor(() => tab.eval("document.getElementById('link').value || null"), "the link");
      };

      const symbolsOnScreen = (tab) => tab.eval(
         "(() => { if (document.querySelector('[data-view=verify]').hidden) return null;"
         + " const s = document.querySelectorAll('#symbols span em');"
         + " return s.length ? [...s].map(n => n.textContent).join(' ') : null; })()");

      const dropped = await openTab(base + "/");
      const droppedLink = await startRoom(dropped);
      await dropped.eval(
         "(() => { const real = window.fetch; let drop = 1;"
         + " window.fetch = (url, opts) => (drop && String(url).includes('/api/poll'))"
         + "    ? (drop--, Promise.reject(new TypeError('Failed to fetch')))"
         + "    : real(url, opts); return true; })()");
      await enterRoom(droppedLink);
      const afterDrop = await waitFor(() => symbolsOnScreen(dropped), "the sender past a lost request");
      check("a request that never lands does not end the exchange", typeof afterDrop === "string", String(afterDrop));

      // What Chrome on Android actually did, in the one step only the room's creator runs.
      // It throws after everything apply() guards against repeating, so nothing but the
      // change coming round again can rescue the page.
      const thrown = await openTab(base + "/");
      const thrownLink = await startRoom(thrown);
      await thrown.eval(
         "(() => { const real = window.alertPeerArrived; let boom = 1;"
         + " window.alertPeerArrived = () => { if (boom) { boom--; throw new TypeError('Illegal constructor'); }"
         + "    return real(); }; return true; })()");
      await enterRoom(thrownLink);
      const afterThrow = await waitFor(() => symbolsOnScreen(thrown), "the sender past a throw mid-change");
      check("a throw while applying a change does not end it either",
         typeof afterThrow === "string", String(afterThrow));

      console.log("\n  a room that runs out of time");

      const owner = await openTab(base + "/");
      await waitFor(() => owner.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");
      await owner.eval("document.getElementById('pickSend').click()");
      await owner.eval(`document.getElementById('secret-input').value = ${JSON.stringify(SECRET)};
         document.getElementById('compose').dispatchEvent(new Event('submit', { cancelable: true }))`);
      const doomed = await waitFor(() => owner.eval("document.getElementById('link').value || null"), "the link");

      const guest = await enterRoom(doomed);
      await waitFor(() => guest.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the room page");
      await waitFor(() => guest.eval("state.peerSeen || null"), "the pairing");

      // The shortest deadline is two minutes, too long to sit through here. What the page
      // actually decides on is a poll that finds no room once the deadline it was told has
      // passed, and that is what both tabs are put in front of.
      /* A poll that was already in flight answers with the deadline the server still knows
       * about, and every reply carries it: letting it land would push the deadline back into
       * the future and turn "expired" into "gone", which is a different screen and a race the
       * page never runs. The deadline is nailed down instead of merely set. */
      const runOut = "state.token = 'x'.repeat(43);"
         + " Object.defineProperty(state, 'expiresAt',"
         + "   { value: Date.now() - 1000, writable: false, configurable: true }); true";
      const expiredScreen = (tab) => tab.eval(
         "(() => { const s = document.querySelector('[data-view=expired]');"
         + " if (s.hidden) return null;"
         + " return { text: (document.getElementById('status').textContent + ' ' + s.textContent)"
         + "     .replace(/\\s+/g, ' ').trim(),"
         + "   again: !document.getElementById('expiredAgain').hidden }; })()");

      await owner.eval(runOut);
      const ownerExpiry = await waitFor(() => expiredScreen(owner), "the owner's expiry screen");
      check("a room that runs out of time says so", /expired/i.test(ownerExpiry.text), ownerExpiry.text);
      check("and does not claim it cannot tell what happened",
         !/never existed|Nothing here/.test(ownerExpiry.text), ownerExpiry.text);
      check("whoever opened the room is offered another one", ownerExpiry.again === true);

      await guest.eval(runOut);
      const guestExpiry = await waitFor(() => expiredScreen(guest), "the guest's expiry screen");
      check("whoever arrived by link is told the same", /expired/i.test(guestExpiry.text), guestExpiry.text);
      check("but is not offered an exchange they cannot start", guestExpiry.again === false);

      console.log("\n  a link opened before anyone asked");

      // Opening a link is the browser doing as it is told; being there is a person saying so.
      // Until the button is pressed the room must be exactly as its owner left it, whoever or
      // whatever loaded the page — a prefetch, a preview, a scanner, or someone who will read
      // the chat in ten minutes.
      const api = async (op, body) => {
         const response = await fetch(base + "/api/" + op, { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
         return response.json();
      };

      const untouched = await api("create", { flow: "send", pub: btoa("A".repeat(65)) });
      const arriving = await openTab(base + "/r/" + untouched.id);
      await waitFor(() => arriving.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"),
         "the room page");

      const gateText = await arriving.eval(
         "(() => { const s = document.querySelector('[data-view=arrival]');"
         + " return s && !s.hidden ? s.textContent.replace(/\\s+/g, ' ').trim() : null; })()");
      check("a link asks before it joins", gateText !== null, String(gateText));

      // What the screen is about is a room, and what the button does is go into it: the two
      // words someone has to understand before pressing anything.
      check("and says what the link is", /room/i.test(gateText || ""), String(gateText));
      check("and the button says what pressing does",
         /enter|join/i.test(await arriving.eval("document.getElementById('arrive').textContent")),
         await arriving.eval("document.getElementById('arrive').textContent"));

      // The page cannot know whether anyone is still on the other side, so it must not say so.
      check("and does not promise someone is there",
         gateText !== null && !/(someone|somebody) (has|is waiting|sent)/i.test(gateText), String(gateText));

      await sleep(500);
      const beforeAnyone = await api("poll", { id: untouched.id, token: untouched.token, v: 0 });
      check("the room is untouched until the button is pressed",
         beforeAnyone.state === "created", JSON.stringify(beforeAnyone));

      await arriving.eval("document.getElementById('arrive').click(), 1");
      const opened = await waitFor(async () => {
         const said = await api("poll", { id: untouched.id, token: untouched.token, v: 0 });
         return said.state === "paired" ? said : null;
      }, "the room to pair once the button is pressed");
      check("and joins the moment it is", opened.state === "paired");

      // Between the press and the answer the page knows nothing new, so it must not draw the
      // screen that says the secret is on the other person's device: on a link that leads
      // nowhere that sentence is false, and on a slow connection it is not a flash. The join
      // is held open here to look at the moment that would otherwise pass too quickly.
      const pressed = await openTab(base + "/r/" + "B".repeat(21) + "Q");
      await waitFor(() => pressed.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"),
         "the room page");
      await pressed.eval(
         "(() => { const real = window.fetch;"
         + " window.fetch = (url, opts) => String(url).includes('/api/join')"
         + "    ? new Promise((done) => setTimeout(() => done(real(url, opts)), 2000))"
         + "    : real(url, opts); return true; })()");
      await pressed.eval("document.getElementById('arrive').click(), 1");
      await sleep(400);

      const waiting = await pressed.eval(
         "(() => { const shown = (v) => !document.querySelector('[data-view=' + v + ']').hidden;"
         + " const b = document.getElementById('arrive');"
         + " return { arrival: shown('arrival'), waiting: shown('waiting'),"
         + "   label: b.textContent, off: b.disabled }; })()");
      check("while the join is in flight the page stays where it was",
         waiting.arrival === true && waiting.waiting === false, JSON.stringify(waiting));
      check("with the button saying what it is doing, and not pressable again",
         /opening/i.test(waiting.label) && waiting.off === true, JSON.stringify(waiting));

      // A link that leads nowhere looks the same until you press: the gate claims nothing it
      // cannot back, and the answer comes from trying.
      const nowhere = await enterRoom(base + "/r/" + "A".repeat(21) + "Q");
      const nothingThere = await waitFor(() => nowhere.eval(
         "(() => { const s = document.querySelector('[data-view=gone]');"
         + " return s && !s.hidden ? document.getElementById('status').textContent : null; })()"),
         "the verdict on an invented link");
      check("an invented link says so only once it has been tried",
         /nothing|nowhere/i.test(nothingThere), nothingThere);

      console.log("\n  a peer whose key cannot be used");

      // Only a broken or hostile peer sends a key that is not a point on the curve, and the
      // page used to treat the failure as a lost request: it complained about the server and
      // then drew the verify screen with four empty tiles and a live confirm button. That is
      // the worst possible screen at the one step that stops a stranger in the middle.
      const bogus = await api("create", { flow: "send", pub: btoa("A".repeat(65)) });
      const puzzled = await enterRoom(base + "/r/" + bogus.id);

      const verdict = await waitFor(() => puzzled.eval(
         "(() => { const s = document.querySelector('[data-view=unusable]');"
         + " return s && !s.hidden ? (document.getElementById('status').textContent + ' '"
         + " + s.textContent).replace(/\\s+/g, ' ').trim() : null; })()"), "the unusable-key screen");
      check("a key this browser cannot use ends the exchange", verdict !== null, String(verdict));
      check("and the server is not blamed for it",
         !/trouble reaching|still trying/i.test(verdict), verdict);

      // Nobody sends a key off the curve by accident, so the screen says what it looks like
      // rather than filing it under "something went wrong".
      check("and it is called what it is", /tamper|interfer/i.test(verdict), verdict);

      // Whoever reads this screen is being told to stop and go somewhere else. Curves and
      // keys are our vocabulary, not theirs, and a sentence they cannot parse reads as a
      // glitch — which is exactly the wrong conclusion here.
      check("and says it without jargon", !/curve|point|public key/i.test(verdict), verdict);

      const offered = await puzzled.eval(
         "!document.querySelector('[data-view=verify]').hidden");
      check("the four symbols are never put on screen", offered === false);
      check("and cannot be confirmed",
         (await puzzled.eval("document.getElementById('confirm').disabled")) === true);

      console.log("\n  every screen render() can draw");

      // A net under the refactoring of render(), not a check of any one screen: it drives
      // render() over every combination of the things it reads — reachable or not, which is
      // the point — and pins what each one draws. Nothing here says a screen is right; the
      // screens above do that. This says none of them moved.
      const drawn = await openTab(base + "/");
      await waitFor(() => drawn.eval("document.readyState === 'complete' && typeof SYMBOLS !== 'undefined'"), "the app");

      const shapes = await drawn.eval(RENDER_PROBE);
      const golden = RENDER_SHAPES.trim().split("\n").map((line) => line.trim());
      const moved = shapes.map((line, i) => [golden[i], line])
         .filter(([was, now]) => was !== now);
      check("render() draws the same " + golden.length + " screens it drew before",
         shapes.length === golden.length && moved.length === 0,
         moved.length
            ? moved.length + " moved, first:\n      was " + moved[0][0] + "\n      now " + moved[0][1]
            : shapes.length + " shapes against " + golden.length);

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

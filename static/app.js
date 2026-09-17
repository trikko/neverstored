const MAX_SECRET_BYTES = 8 * 1024;
const FAST_POLL = 500;
const SLOW_POLL = 3000;

const state = {
   poll: 0,
   trouble: 0,
   room: null,
   token: null,
   role: null,
   flow: null,
   secret: null,
   identity: null,
   session: null,
   version: 0,
   step: "",
   owner: false,
   sent: false,
   last: null,
   confirmed: false,
   peerSeen: false,
   finished: false,
   expiresAt: 0,
};

const $ = (id) => document.getElementById(id);

// Four ways through the exchange: you either opened the room or followed a link,
// and you either hold the secret or are waiting for it.
function pathOf() {
   const sending = state.role !== "receiver";

   if (state.owner && sending)
      return [["write", "Write"], ["share", "Share"], ["verify", "Verify"], ["hand", "Hand over"]];
   if (state.owner)
      return [["share", "Share"], ["verify", "Verify"], ["receive", "Receive"]];
   if (sending)
      return [["open", "Open"], ["verify", "Verify"], ["write", "Write"], ["hand", "Hand over"]];

   return [["open", "Open"], ["verify", "Verify"], ["receive", "Receive"]];
}

/// The step follows what is actually happening, not what happens to be on screen.
function atStep(step) {
   state.step = step;
   drawSteps();
}

function drawSteps() {
   const path = pathOf();
   const at = state.step;
   const list = $("steps");

   const shape = state.role + ":" + state.owner + ":" + state.finished;
   if (list.dataset.shape === shape && list.dataset.at === at) return;
   list.dataset.shape = shape;
   list.dataset.at = at;
   list.classList.toggle("complete", state.finished);
   list.textContent = "";

   const reached = state.finished ? path.length - 1 : path.findIndex(([key]) => key === at);
   path.forEach(([key, label], index) => {
      const item = document.createElement("li");
      const badge = document.createElement("span");
      badge.textContent = index + 1;
      item.append(badge, document.createTextNode(label));
      if (index === reached) item.className = "at";
      else if (reached >= 0 && index < reached) item.className = "past";
      list.appendChild(item);
   });
}

function drawTrack() {
   const mine = state.role === "receiver";
   $("spot-from").textContent = mine ? "their device" : "your device";
   $("spot-to").textContent = mine ? "your device" : "their device";
}

const show = (...ids) => {
   for (const view of document.querySelectorAll("[data-view]"))
      view.hidden = !ids.includes(view.dataset.view);

   // Before a direction is chosen, and once the room is gone, there is no path to show —
   // and nothing for the status line to narrate either.
   const onAPath = !ids.some(id => ["chooser", "gone", "expired", "occupied", "insecure"].includes(id));
   $("steps").hidden = !onAPath;
   $("where").hidden = !onAPath;
   $("status").hidden = ids.includes("chooser");

   drawSteps();
   drawTrack();

   const focusable = document.querySelector("[data-view]:not([hidden]) textarea");
   if (focusable) focusable.focus();
};

function say(text) { $("status").textContent = text; }

/// The room dies on its own schedule, and whoever is waiting should see it coming rather
/// than watch the page turn into "this room is gone" without warning.
function drawExpiry() {
   const box = $("expiry");

   if (state.finished || !state.expiresAt) {
      box.hidden = true;
      return;
   }

   const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
   const minutes = Math.floor(left / 60);
   const seconds = String(left % 60).padStart(2, "0");

   box.hidden = false;
   box.textContent = left > 0
      ? `This room expires in ${minutes}:${seconds}`
      : "This room has expired.";
   box.classList.toggle("soon", left <= 60);
}

/// The block steps back as soon as you are done with it, not when the other side is.
function settle(done, both) {
   $("confirm").disabled = done;
   $("copySymbols").disabled = done;
   $("showDigits").disabled = done;
   document.querySelector("[data-view=verify]").classList.toggle("settled", done);

   if (done) $("confirm").textContent = both ? "Both confirmed" : "Confirmed";
}

/// "from" is whoever holds the secret now, "to" is whoever is waiting for it.
function whereIsIt(spot) {
   for (const dot of document.querySelectorAll("#where b"))
      dot.classList.toggle("lit", dot.dataset.spot === spot);
}

async function post(op, extra) {
   const response = await fetch("/api/" + op, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ id: state.room, token: state.token }, extra)),
   });
   return response.json();
}

function drawSymbols() {
   const holder = $("symbols");
   const waiting = !state.session;
   holder.textContent = "";
   holder.classList.toggle("pending", waiting);

   for (const index of (state.session ? state.session.symbols : [null, null, null, null])) {
      const entry = index === null ? ["·", ""] : SYMBOLS[index];
      const box = document.createElement("span");
      const face = document.createElement("i");
      const word = document.createElement("em");
      face.textContent = entry[0];
      word.textContent = entry[1];
      box.append(face, word);
      holder.appendChild(box);
   }

   if (waiting) return;

   $("digits").textContent = state.session.symbols.join(" · ");
   $("copySymbols").onclick = () => {
      const words = state.session.symbols.map((i) => SYMBOLS[i][1]).join(" ");
      const faces = state.session.symbols.map((i) => SYMBOLS[i][0]).join("");
      navigator.clipboard.writeText(faces + " (" + words + ")");
      $("copySymbols").textContent = "copied";
   };
}

/// The tab title is the whole notice. A real notification would need permission we would
/// have to ask for while the code is on screen, and on Android it cannot be raised at all
/// without a service worker — which is not a thing to install on a site that keeps nothing.
function alertPeerArrived() {
   document.title = "Someone is here — neverstored";
}

/// One place schedules the next poll, and it cancels the pending one first: two chains
/// running at once would poll each other's versions away.
function schedule(delay) {
   clearTimeout(state.poll);
   state.poll = setTimeout(tick, delay);
}

async function tick() {
   if (state.finished) return;

   try {
      await poll();
   } catch (error) {
      // The exchange is minutes long and lives on phones: a lost request, a tunnel, a
      // moment of sleep. Whatever went wrong, the one thing that must not happen is the
      // loop ending, because only a poll can move the page — the room would expire with
      // nobody watching, in front of a screen that never changed.
      state.trouble++;
      if (state.trouble >= 3) say("Trouble reaching the server. Still trying.");
      schedule(SLOW_POLL);
   }
}

async function poll() {
   const reply = await post("poll", { v: state.version });

   // A poll that goes through takes the complaint off the screen, even when it carries
   // no news: render() puts back whatever the page was saying before.
   if (state.trouble) {
      state.trouble = 0;
      render();
   }

   if (!reply.ok) {
      if (reply.err === "notfound") {
         // The room dies the same way for everyone on the server, and a stranger opening the
         // link cannot be told why. Whoever was inside it watched the countdown run out, so
         // telling them we cannot tell the difference would be a lie they just disproved.
         // Only whoever opened the room is offered another one: the other side arrived
         // through a link and has nothing to start again.
         if (state.expiresAt && Date.now() >= state.expiresAt) {
            $("expiredAgain").hidden = !state.owner;
            return finish("expired")("This room expired before the secret was handed over.");
         }
         return finish("gone")("This room is gone. Nothing was left behind.");
      }
      return schedule(SLOW_POLL);
   }

   // Every reply carries it, changed or not, so the countdown is corrected on each poll
   // instead of drifting between them.
   if (typeof reply.expiresIn === "number") {
      state.expiresAt = Date.now() + reply.expiresIn * 1000;
      drawExpiry();
   }

   if (reply.changed) await apply(reply);

   const idle = !state.peerSeen;
   schedule(idle ? SLOW_POLL : FAST_POLL);
}

async function apply(reply) {
   state.version = reply.ver;
   state.role = reply.role;
   state.last = reply;

   if (reply.peerPub && !state.session) {
      state.session = await deriveSession(state.identity, reply.peerPub, state.room);
      drawSymbols();
   }

   if (reply.peer && !state.peerSeen) {
      state.peerSeen = true;
      // Only whoever was waiting learns that someone arrived: the one who followed
      // the link already knows they opened it.
      if (state.owner) alertPeerArrived();
   }

   if (reply.ct) {
      const secret = await unseal(state.session, state.room, reply.ct);
      $("secret").textContent = secret;
      $("secret").classList.remove("pending");

      $("copySecret").disabled = false;
      $("copySecret").onclick = () => {
         navigator.clipboard.writeText(secret);
         $("copySecret").textContent = "Copied";
      };

      // The waiting note is written for a secret that has not arrived yet; once it has,
      // the fuller one takes over. "Start another" would suggest sending something, and
      // the recipient just received.
      $("keepNote").hidden = true;
      $("goneNote").hidden = false;
      $("again").hidden = true;

      // The arrival gets the page to itself: nothing above it is useful any more. One of
      // the two sent the link and the other opened it, so it is neither "this link" nor
      // "the link you shared".
      return finish("reveal")("It is yours now. The room is gone — the shared link leads nowhere.");
   }

   if (reply.delivered && state.role === "sender") {
      // The delivery gets the page to itself, mirroring the recipient's reveal screen.
      return finish("done")("Delivered — it reached them. Nothing left to delete.");
   }

   if (reply.state === "burned")
      return finish("gone")("Nothing was ever sent. Start again when you are both online.");

   render();
}

/// Draws the page from everything known right now, local and remote alike, so a local
/// action never has to wait for the server to say something new.
function render() {
   const reply = state.last;
   if (!reply || state.finished) return;

   const sending = state.role === "sender";
   const alone = reply.state === "created";
   const ready = reply.state === "ready";
   // Whoever writes inside the room keeps the box until they actually hand it over,
   // so the secret can still be edited after the symbols are agreed.
   const writing = sending && !state.sent && !state.secret;

   // While nobody is there, there is only the link. From the moment the other side
   // arrives, every remaining stage is on screen at once and only its state changes.
   if (alone) {
      show(state.owner ? "link" : "waiting");
      atStep(state.owner ? "share" : "open");
      drawTrack();
      say(state.owner
         ? (sending
            ? "This link is not a secret — it is just an address. Send it however you like."
            : "Send them this link and they will write the secret on their side.")
         : "Connected. Waiting for the other side.");
      whereIsIt(sending ? "from" : null);
      return;
   }

   const stages = [];
   if (writing) stages.push("compose");
   stages.push("verify");
   if (sending) stages.push("handoff");
   show(...stages);

   // Whoever writes inside the room verifies first and writes after, which is also
   // the order the blocks appear in.
   atStep(writing
      ? (!ready ? "verify" : secretInHand() ? "hand" : "write")
      : !ready ? "verify" : sending ? "hand" : "receive");

   drawSymbols();
   settle(state.confirmed || ready, ready);
   $("continue").hidden = !!state.room;
   $("handover").disabled = state.sent || !ready || !secretInHand() || !secretFits();

   if (state.sent) {
      $("handover").textContent = "Handed over";
      say("Sent. Waiting for them to pick it up.");
   } else if (ready) {
      say(sending
         ? (secretInHand()
            ? "Both confirmed. Nothing is sent until you press the button."
            : "Both confirmed. Write the secret to hand it over.")
         : "Both confirmed. Waiting for them to hand it over.");
   } else {
      say(state.confirmed
         ? "Waiting for them to confirm the symbols."
         : "Someone is here. Check they see the same four symbols.");
   }

   whereIsIt("from");
}

function secretInHand() {
   return !!(state.secret || $("secret-input").value);
}

function secretSize() {
   return new TextEncoder().encode(state.secret || $("secret-input").value).length;
}

function secretFits() {
   const over = secretInHand() && secretSize() > MAX_SECRET_BYTES;
   $("tooBig").hidden = !over;
   return !over;
}

function finish(...views) {
   return (text) => {
      state.finished = true;
      state.secret = null;
      show(...views);
      atStep(views.includes("reveal") ? "receive" : views.includes("handoff") ? "hand" : "");
      settle(true, true);
      say(text);
      whereIsIt(views.includes("reveal") || views.includes("handoff") ? "to" : null);
      drawExpiry();
      window.onbeforeunload = null;
   };
}

function guardUnload() {
   window.onbeforeunload = () => state.finished ? null : "";
}

async function createRoom(flow, secret) {
   state.identity = await createIdentity();
   const response = await fetch("/api/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow, pub: state.identity.pub }),
   });
   const reply = await response.json();

   if (!reply.ok) { say("The service is busy. Try again in a moment."); return; }

   state.room = reply.id;
   state.token = reply.token;
   state.owner = true;
   state.role = flow === "send" ? "sender" : "receiver";
   state.flow = flow;
   state.secret = secret;
   state.version = 0;

   const link = location.origin + "/r/" + reply.id;
   $("link").value = link;
   $("copyLink").onclick = () => {
      navigator.clipboard.writeText(link);
      $("copyLink").textContent = "copied";
   };

   $("qr").hidden = !drawQr($("qr"), link);

   state.last = { state: "created", ver: 0, role: state.role };
   render();
   whereIsIt(secret ? "from" : null);
   guardUnload();
   tick();
}

async function joinRoom(id) {
   state.identity = await createIdentity();
   state.room = id;

   const response = await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, pub: state.identity.pub }),
   });
   const reply = await response.json();

   if (!reply.ok) {
      // A full room is not a missing one: saying the link leads nowhere would be a lie the
      // two people inside could disprove.
      if (reply.err === "occupied") {
         show("occupied");
         say("Two people are already in this room.");
         return;
      }

      show("gone");
      say("This link leads nowhere. Nothing was left behind.");
      return;
   }

   state.token = reply.token;
   state.version = 0;
   state.role = "receiver";
   atStep("open");
   show("waiting");
   say("Connected. Waiting for the other side.");
   whereIsIt("from");
   guardUnload();
   tick();
}

function wire() {
   // Browsers only expose WebCrypto in a secure context, so plain http on a LAN address
   // leaves the page unable to do anything. Say so instead of failing silently.
   if (!window.isSecureContext || !window.crypto?.subtle) {
      show("insecure");
      say("This page needs a secure connection.");
      return;
   }

   setInterval(drawExpiry, 1000);

   const inRoom = location.pathname.startsWith("/r/");

   if (inRoom) {
      state.role = "receiver";
      atStep("open");
      show("waiting");
      say("Opening…");
      joinRoom(location.pathname.slice(3));
   } else {
      show("chooser");
      say("Nothing has been sent yet.");

      // Picking a direction is what decides the path, so claim the role right away
      // instead of letting the steps change shape once the room exists.
      $("pickSend").onclick = () => {
         state.owner = true;
         state.role = "sender";
         atStep("write");
         show("compose");
         say("Still on your device. Nothing has been sent.");
         whereIsIt("from");
      };

      $("pickRequest").onclick = () => {
         state.owner = true;
         state.role = "receiver";
         createRoom("request", null);
      };
   }

   $("compose").onsubmit = async (event) => {
      event.preventDefault();
      const secret = $("secret-input").value;
      if (!secret || !secretFits()) return;

      if (state.room) render();
      else {
         await createRoom("send", secret);
         $("secret-input").value = "";
      }
   };

   $("confirm").onclick = async () => {
      $("confirm").disabled = true;
      const reply = await post("confirm", {});

      // A refused confirmation must not look like a confirmed one, or both sides
      // end up waiting for each other with nothing left to press.
      if (!reply.ok) {
         $("confirm").disabled = false;
         say(reply.err === "notfound"
            ? "This room is no longer there. Start again."
            : "That did not go through. Try again.");
         return;
      }

      state.confirmed = true;
      render();
   };

   $("handover").onclick = async () => {
      $("handover").disabled = true;
      whereIsIt("server");

      const secret = state.secret || $("secret-input").value;
      const reply = await post("deliver", { ct: await seal(state.session, state.room, secret) });

      if (!reply.ok) {
         $("handover").disabled = false;
         whereIsIt("from");
         say("It did not go through. Nothing was delivered, try again.");
         return;
      }

      state.sent = true;
      state.secret = null;
      $("secret-input").value = "";
      render();
   };

   $("secret-input").oninput = () => {
      if (!state.room) return;

      const ready = state.last && state.last.state === "ready";
      $("handover").disabled = state.sent || !ready || !secretInHand() || !secretFits();
      if (ready) atStep(secretInHand() ? "hand" : "write");
   };

   $("showDigits").onclick = () => $("digits").hidden = !$("digits").hidden;

   window.addEventListener("pagehide", () => {
      if (state.room && state.token && !state.finished)
         navigator.sendBeacon("/api/cancel",
            new Blob([JSON.stringify({ id: state.room, token: state.token })], { type: "application/json" }));
   });
}

wire();

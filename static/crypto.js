// Loaded both by the page and by the test suite, so what is tested is what is served.
const CTX = "neverstored-v1";

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const utf8 = (text) => new TextEncoder().encode(text);

async function createIdentity() {
   const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

   const pub = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
   return { priv: pair.privateKey, pub, commit: await commitmentOf(pub) };
}

// Whoever opens a room sends only this at first, and its key once the other one is in:
// a server holding both keys before showing either side anything could grind a pair of
// its own until the symbols collide.
async function commitmentOf(pub) {
   return b64(await crypto.subtle.digest("SHA-256", unb64(pub)));
}

async function opens(commit, pub) {
   return typeof commit === "string" && commit.length > 0 && (await commitmentOf(pub)) === commit;
}

// The transcript pins the room and both public keys, so someone in the middle
// cannot make the two sides land on the same symbols.
async function deriveSession(identity, peerPub, roomId) {
   const peer = await crypto.subtle.importKey(
      "raw", unb64(peerPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
   const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, identity.priv, 256);
   const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);

   const ordered = [identity.pub, peerPub].sort();
   const info = utf8(CTX + "|" + roomId + "|" + ordered[0] + "|" + ordered[1]);
   const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: utf8(roomId), info }, material, 288));

   const key = await crypto.subtle.importKey(
      "raw", bits.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

   return { key, symbols: Array.from(bits.slice(32, 36)) };
}

async function seal(session, roomId, text) {
   const iv = crypto.getRandomValues(new Uint8Array(12));
   const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(roomId) }, session.key, utf8(text));

   const joined = new Uint8Array(iv.length + sealed.byteLength);
   joined.set(iv);
   joined.set(new Uint8Array(sealed), iv.length);

   return b64(joined);
}

async function unseal(session, roomId, payload) {
   const raw = unb64(payload);
   const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: utf8(roomId) },
      session.key, raw.slice(12));

   return new TextDecoder().decode(plain);
}

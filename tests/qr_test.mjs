// Encodes with the shipped qr.js and reads the result back with zbarimg,
// so the encoder is checked against an independent decoder.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = createContext({ TextEncoder, Math, console });
runInContext(readFileSync(join(here, "..", "static", "qr.js"), "utf8"), sandbox);
const { qrMatrix } = sandbox;

const crcTable = Array.from({ length: 256 }, (_, n) => {
   let c = n;
   for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
   return c >>> 0;
});

function crc32(buffer) {
   let c = 0xffffffff;
   for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
   return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
   const length = Buffer.alloc(4);
   length.writeUInt32BE(data.length);
   const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
   const crc = Buffer.alloc(4);
   crc.writeUInt32BE(crc32(body));
   return Buffer.concat([length, body, crc]);
}

function writePng(path, modules, scale = 8, quiet = 4) {
   const size = (modules.length + quiet * 2) * scale;
   const rows = [];

   for (let y = 0; y < size; y++) {
      const line = Buffer.alloc(size + 1, 0xff);
      line[0] = 0;
      const row = Math.floor(y / scale) - quiet;
      for (let x = 0; x < size; x++) {
         const col = Math.floor(x / scale) - quiet;
         const dark = row >= 0 && col >= 0 && row < modules.length && col < modules.length
            && modules[row][col] === 1;
         line[x + 1] = dark ? 0x00 : 0xff;
      }
      rows.push(line);
   }

   const header = Buffer.alloc(13);
   header.writeUInt32BE(size, 0);
   header.writeUInt32BE(size, 4);
   header[8] = 8;
   header[9] = 0;

   writeFileSync(path, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(rows))),
      chunk("IEND", Buffer.alloc(0)),
   ]));
}

const workdir = mkdtempSync(join(tmpdir(), "qr-test-"));
let failures = 0;

function roundTrip(text) {
   const modules = qrMatrix(text);
   assert.ok(modules, "no version fits " + text.length + " bytes");

   const path = join(workdir, "code.png");
   writePng(path, modules);

   const decoded = execFileSync("zbarimg", ["-q", "--raw", path], { encoding: "utf8" });
   return decoded.replace(/\n$/, "");
}

function check(name, body) {
   try { body(); console.log("  ok   " + name); }
   catch (error) { failures++; console.log("  FAIL " + name + ": " + error.message); }
}

check("a room link scans back exactly", () => {
   const link = "https://neverstored.com/r/IQxLFZiBUNSy6eI2BRUn9Q";
   assert.equal(roundTrip(link), link);
});

check("a local instance link scans back exactly", () => {
   const link = "http://127.0.0.1:8099/r/IQxLFZiBUNSy6eI2BRUn9Q";
   assert.equal(roundTrip(link), link);
});

check("a long self hosted link still scans", () => {
   const link = "https://secrets.internal.example-company.com/r/IQxLFZiBUNSy6eI2BRUn9Q";
   assert.equal(roundTrip(link), link);
});

check("every length up to the limit scans back", () => {
   for (const length of [10, 17, 30, 45, 60, 80, 100]) {
      const text = "https://x.tld/r/" + "a".repeat(Math.max(0, length - 16));
      if (!qrMatrix(text)) continue;
      assert.equal(roundTrip(text), text, "failed at length " + text.length);
   }
});

check("an oversized payload is rejected rather than mangled", () => {
   assert.equal(qrMatrix("x".repeat(200)), null);
});

rmSync(workdir, { recursive: true, force: true });
console.log(failures ? "\nqr: " + failures + " failing" : "\nqr: all good");
process.exit(failures ? 1 : 0);

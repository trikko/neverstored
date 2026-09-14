// Minimal QR encoder, byte mode, versions 1 to 6. Enough for a room link, and it
// keeps the page free of third party code.
const QR_TOTAL = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172 };
const QR_BLOCKS = {
   L: { 1: [1, 7], 2: [1, 10], 3: [1, 15], 4: [1, 20], 5: [1, 26], 6: [2, 18] },
   M: { 1: [1, 10], 2: [1, 16], 3: [1, 26], 4: [2, 18], 5: [2, 24], 6: [4, 16] },
};
const QR_ECC_BITS = { L: 1, M: 0 };

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function buildTables() {
   let x = 1;
   for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
   }
   for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];

function generator(degree) {
   let poly = [1];
   for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
         next[j] ^= poly[j];
         next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
      }
      poly = next;
   }
   return poly;
}

function remainder(data, degree) {
   const result = new Array(degree).fill(0);
   const gen = generator(degree);

   for (const byte of data) {
      const factor = byte ^ result[0];
      result.shift();
      result.push(0);
      for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i + 1], factor);
   }
   return result;
}

function pickVersion(length) {
   for (const level of ["M", "L"])
      for (let version = 1; version <= 6; version++) {
         const [blocks, ecc] = QR_BLOCKS[level][version];
         const capacity = QR_TOTAL[version] - blocks * ecc - 2;
         if (length <= capacity) return { version, level, blocks, ecc };
      }
   return null;
}

function codewords(text, plan) {
   const bytes = new TextEncoder().encode(text);
   const bits = [];
   const push = (value, width) => {
      for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
   };

   push(4, 4);
   push(bytes.length, 8);
   for (const byte of bytes) push(byte, 8);

   const total = QR_TOTAL[plan.version] - plan.blocks * plan.ecc;
   const room = total * 8;
   for (let i = 0; i < 4 && bits.length < room; i++) bits.push(0);
   while (bits.length % 8) bits.push(0);

   const data = [];
   for (let i = 0; i < bits.length; i += 8)
      data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

   const padding = [0xec, 0x11];
   while (data.length < total) data.push(padding[data.length % 2 === 0 ? 0 : 1]);

   const perBlock = total / plan.blocks;
   const dataBlocks = [];
   const eccBlocks = [];
   for (let i = 0; i < plan.blocks; i++) {
      const block = data.slice(i * perBlock, (i + 1) * perBlock);
      dataBlocks.push(block);
      eccBlocks.push(remainder(block, plan.ecc));
   }

   const out = [];
   for (let i = 0; i < perBlock; i++) for (const block of dataBlocks) out.push(block[i]);
   for (let i = 0; i < plan.ecc; i++) for (const block of eccBlocks) out.push(block[i]);
   return out;
}

function blankMatrix(version) {
   const size = 17 + 4 * version;
   const modules = Array.from({ length: size }, () => new Array(size).fill(null));

   const finder = (row, col) => {
      for (let r = -1; r <= 7; r++)
         for (let c = -1; c <= 7; c++) {
            const y = row + r, x = col + c;
            if (y < 0 || x < 0 || y >= size || x >= size) continue;
            const edge = r === -1 || r === 7 || c === -1 || c === 7;
            const ring = r === 0 || r === 6 || c === 0 || c === 6;
            const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            modules[y][x] = edge ? 0 : (ring || core) ? 1 : 0;
         }
   };

   finder(0, 0);
   finder(0, size - 7);
   finder(size - 7, 0);

   for (let i = 8; i < size - 8; i++) {
      modules[6][i] = i % 2 === 0 ? 1 : 0;
      modules[i][6] = i % 2 === 0 ? 1 : 0;
   }

   if (version >= 2) {
      const center = size - 7;
      for (let r = -2; r <= 2; r++)
         for (let c = -2; c <= 2; c++)
            modules[center + r][center + c] =
               (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
   }

   modules[size - 8][8] = 1;

   for (let i = 0; i < 9; i++) {
      if (modules[8][i] === null) modules[8][i] = 0;
      if (modules[i][8] === null) modules[i][8] = 0;
   }
   for (let i = 0; i < 8; i++) {
      if (modules[8][size - 1 - i] === null) modules[8][size - 1 - i] = 0;
      if (modules[size - 1 - i][8] === null) modules[size - 1 - i][8] = 0;
   }

   return modules;
}

function reserved(version, row, col) {
   const size = 17 + 4 * version;
   if (row === 6 || col === 6) return true;
   if (row < 9 && col < 9) return true;
   if (row < 9 && col >= size - 8) return true;
   if (row >= size - 8 && col < 9) return true;

   if (version >= 2) {
      const center = size - 7;
      if (Math.abs(row - center) <= 2 && Math.abs(col - center) <= 2) return true;
   }
   return false;
}

function placeData(modules, version, bytes) {
   const size = modules.length;
   const bits = [];
   for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);

   let index = 0;
   let upward = true;

   for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--;
      for (let step = 0; step < size; step++) {
         const row = upward ? size - 1 - step : step;
         for (const col of [right, right - 1]) {
            if (reserved(version, row, col)) continue;
            modules[row][col] = index < bits.length ? bits[index++] : 0;
         }
      }
      upward = !upward;
   }
}

const MASKS = [
   (r, c) => (r + c) % 2 === 0,
   (r) => r % 2 === 0,
   (r, c) => c % 3 === 0,
   (r, c) => (r + c) % 3 === 0,
   (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
   (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
   (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
   (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(modules) {
   const size = modules.length;
   let score = 0;

   const runScore = (line) => {
      let total = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
         if (line[i] === line[i - 1]) run++;
         else { if (run >= 5) total += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) total += 3 + (run - 5);
      return total;
   };

   for (let i = 0; i < size; i++) {
      score += runScore(modules[i]);
      score += runScore(modules.map((row) => row[i]));
   }

   for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++) {
         const block = modules[r][c] + modules[r][c + 1] + modules[r + 1][c] + modules[r + 1][c + 1];
         if (block === 0 || block === 4) score += 3;
      }

   const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
   const matches = (line, at) => pattern.every((value, i) => line[at + i] === value);
   const reverse = [...pattern].reverse();
   const matchesReverse = (line, at) => reverse.every((value, i) => line[at + i] === value);

   for (let i = 0; i < size; i++) {
      const row = modules[i];
      const col = modules.map((line) => line[i]);
      for (let at = 0; at + 11 <= size; at++) {
         if (matches(row, at) || matchesReverse(row, at)) score += 40;
         if (matches(col, at) || matchesReverse(col, at)) score += 40;
      }
   }

   let dark = 0;
   for (const row of modules) for (const value of row) dark += value;
   score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

   return score;
}

function writeFormat(modules, level, mask) {
   const size = modules.length;
   const value = (QR_ECC_BITS[level] << 3) | mask;
   let bch = value << 10;

   for (let i = 4; i >= 0; i--)
      if (bch & (1 << (i + 10))) bch ^= 0x537 << i;

   const bits = ((value << 10) | bch) ^ 0x5412;
   const at = (position) => (bits >> (14 - position)) & 1;

   for (let i = 0; i <= 5; i++) modules[8][i] = at(i);
   modules[8][7] = at(6);
   modules[8][8] = at(7);
   modules[7][8] = at(8);
   for (let i = 9; i <= 14; i++) modules[14 - i][8] = at(i);

   for (let i = 0; i <= 6; i++) modules[size - 1 - i][8] = at(i);
   for (let i = 7; i <= 14; i++) modules[8][size - 15 + i] = at(i);
}

function qrMatrix(text) {
   const bytes = new TextEncoder().encode(text);
   const plan = pickVersion(bytes.length);
   if (!plan) return null;

   const data = codewords(text, plan);
   let best = null;

   for (let mask = 0; mask < 8; mask++) {
      const modules = blankMatrix(plan.version);
      placeData(modules, plan.version, data);

      for (let r = 0; r < modules.length; r++)
         for (let c = 0; c < modules.length; c++)
            if (!reserved(plan.version, r, c) && MASKS[mask](r, c)) modules[r][c] ^= 1;

      writeFormat(modules, plan.level, mask);

      const score = penalty(modules);
      if (!best || score < best.score) best = { score, modules };
   }

   return best.modules;
}

function drawQr(canvas, text, scale = 6, quiet = 4) {
   const modules = qrMatrix(text);
   if (!modules) return false;

   const size = modules.length + quiet * 2;
   canvas.width = canvas.height = size * scale;

   const pen = canvas.getContext("2d");
   pen.fillStyle = "#ffffff";
   pen.fillRect(0, 0, canvas.width, canvas.height);
   pen.fillStyle = "#000000";

   for (let r = 0; r < modules.length; r++)
      for (let c = 0; c < modules.length; c++)
         if (modules[r][c]) pen.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);

   return true;
}

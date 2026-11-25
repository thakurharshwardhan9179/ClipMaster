'use strict';

// Minimal zero-dependency QR Code (Byte mode, ECC Level L, Versions 1-6) SVG generator.
// Supports URLs up to ~134 UTF-8 bytes cleanly (covers all LAN/tunnel URLs).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// Version 1..6 Level-L specs: [totalDataCodewords, ecCodewordsPerBlock, numBlocks, alignCenter]
const VERSIONS = [
  null,
  { size: 21, dataCw: 19, ecCw: 7, blocks: 1, align: [] },
  { size: 25, dataCw: 34, ecCw: 10, blocks: 1, align: [6, 18] },
  { size: 29, dataCw: 55, ecCw: 15, blocks: 1, align: [6, 22] },
  { size: 33, dataCw: 80, ecCw: 20, blocks: 1, align: [6, 26] },
  { size: 37, dataCw: 108, ecCw: 26, blocks: 1, align: [6, 30] },
  { size: 41, dataCw: 136, ecCw: 18, blocks: 2, align: [6, 34] }
];

function encodeByteData(bytes, verSpec) {
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8); // Char count (versions 1..9 use 8 bits)
  for (const b of bytes) pushBits(b, 8);
  const maxBits = verSpec.dataCw * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  const pads = [0xec, 0x11];
  let pIdx = 0;
  while (codewords.length < verSpec.dataCw) {
    codewords.push(pads[pIdx++ % 2]);
  }
  return Uint8Array.from(codewords);
}

function buildCodewords(bytes) {
  let version = -1;
  for (let v = 1; v < VERSIONS.length; v++) {
    // 4 bits mode + 8 bits len + 8*N data <= dataCw*8
    if (12 + bytes.length * 8 <= VERSIONS[v].dataCw * 8) {
      version = v;
      break;
    }
  }
  if (version < 0) throw new Error('Text too long for QR code');
  const spec = VERSIONS[version];
  const data = encodeByteData(bytes, spec);

  const blocks = [];
  const ecBlocks = [];
  const perBlock = Math.floor(spec.dataCw / spec.blocks);
  let offset = 0;
  for (let b = 0; b < spec.blocks; b++) {
    const slice = data.slice(offset, offset + perBlock);
    offset += perBlock;
    blocks.push(slice);
    ecBlocks.push(rsEncode(slice, spec.ecCw));
  }

  const finalBytes = [];
  for (let i = 0; i < perBlock; i++) {
    for (const blk of blocks) finalBytes.push(blk[i]);
  }
  for (let i = 0; i < spec.ecCw; i++) {
    for (const ec of ecBlocks) finalBytes.push(ec[i]);
  }
  return { version, size: spec.size, align: spec.align, bytes: finalBytes };
}

function createMatrix(size) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(mat, row, col) {
  const size = mat.length;
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      mat[rr][cc] = inOuter && (onBorder || inInner) ? 1 : 0;
    }
  }
}

function placeAlignment(mat, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      if (mat[row + r][col + c] !== -1) return;
    }
  }
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const isDark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      mat[row + r][col + c] = isDark ? 1 : 0;
    }
  }
}

function computeFormatBits(maskPattern) {
  // ECC L = 01
  const data = (0b01 << 3) | maskPattern;
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= gen << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function placeFormat(mat, maskPattern) {
  const size = mat.length;
  const fmt = computeFormatBits(maskPattern);
  const bit = i => (fmt >> i) & 1;

  for (let i = 0; i <= 5; i++) mat[8][i] = bit(14 - i);
  mat[8][7] = bit(8);
  mat[8][8] = bit(7);
  mat[7][8] = bit(6);
  for (let i = 9; i <= 14; i++) mat[14 - i][8] = bit(14 - i);

  for (let i = 0; i <= 7; i++) mat[size - 1 - i][8] = bit(14 - i);
  for (let i = 8; i <= 14; i++) mat[8][size - 15 + i] = bit(14 - i);
  mat[size - 8][8] = 1; // Dark module
}

function penaltyScore(mat) {
  const n = mat.length;
  let score = 0;
  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (mat[r][c] === mat[r][c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (mat[r][c] === mat[r - 1][c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  }
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = mat[r][c];
      if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) score += 3;
    }
  }
  return score;
}

function generateQrMatrix(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  const { size, align, bytes: codewords } = buildCodewords(bytes);

  const base = createMatrix(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    base[6][i] = i % 2 === 0 ? 1 : 0;
    base[i][6] = i % 2 === 0 ? 1 : 0;
  }

  for (const r of align) {
    for (const c of align) {
      placeAlignment(base, r, c);
    }
  }

  // Reserve format info cells
  for (let i = 0; i <= 8; i++) {
    if (base[8][i] === -1) base[8][i] = 0;
    if (base[i][8] === -1) base[i][8] = 0;
  }
  for (let i = size - 8; i < size; i++) {
    if (base[8][i] === -1) base[8][i] = 0;
    if (base[i][8] === -1) base[i][8] = 0;
  }
  base[size - 8][8] = 1;

  const isFunc = base.map(row => row.map(v => v !== -1));

  // Place data bits
  const dataBits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1);
  }
  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!isFunc[r][c]) {
          base[r][c] = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
        }
      }
    }
    up = !up;
  }

  const masks = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  let bestMat = null;
  let bestScore = Infinity;
  for (let m = 0; m < masks.length; m++) {
    const candidate = base.map((row, r) =>
      row.map((val, c) => (isFunc[r][c] ? val : val ^ (masks[m](r, c) ? 1 : 0)))
    );
    placeFormat(candidate, m);
    const sc = penaltyScore(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      bestMat = candidate;
    }
  }
  return bestMat;
}

function generateQrSvg(text, margin = 3) {
  const mat = generateQrMatrix(text);
  const n = mat.length;
  const total = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (mat[r][c] === 1) {
        d += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

module.exports = { generateQrMatrix, generateQrSvg };

/**
 * A dependency-free QR Code encoder, written from ISO/IEC 18004. It covers what a pairing screen needs: byte mode
 * (UTF-8), error correction L/M/Q/H, versions 1 to 40, and automatic mask selection with the four penalty rules.
 *
 * `qrMatrix` returns the modules without a quiet zone. The renderer adds one (4 modules is the spec minimum):
 * `qrSvgPath` takes a `margin`, `qrSvg` defaults to 4, and the React `<PairingQr>` draws its own.
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrOptions {
  /** Error correction level. Default `M` (about 15% of the symbol can be lost). */
  ecc?: QrEcc;
  /** Smallest version to use (1..40). Default 1. */
  minVersion?: number;
  /** Largest version to use (1..40). Default 40. */
  maxVersion?: number;
  /** Force a mask pattern (0..7). Default: the one with the lowest penalty score. */
  mask?: number;
  /** Prefix an ECI 26 (UTF-8) header. Default false: phone scanners read UTF-8 byte mode without it. */
  eci?: boolean;
}

export interface QrMatrix {
  /** Modules per side: 17 + 4 x version. */
  size: number;
  version: number;
  ecc: QrEcc;
  mask: number;
  /** `modules[y][x]`, true = dark. */
  modules: boolean[][];
}

/** One horizontal run of dark modules in row `y`, starting at `x`, `w` modules wide. */
export interface QrRun {
  x: number;
  y: number;
  w: number;
}

// Spec tables (ISO/IEC 18004, Table 9), indexed [level][version - 1], levels in the order L, M, Q, H.
const LEVELS: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];
const EC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const EC_BLOCKS: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
// Alignment pattern centres per version (Annex E, Table E.1); version 1 has none.
const ALIGNMENT: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];
/** Row and column coordinates of the alignment pattern centres for a version (version 1 has none). */
export function qrAlignmentCentres(version: number): number[] {
  return [...(ALIGNMENT[version - 1] ?? [])];
}

/** The two format-information bits for each level (Table 12). */
const LEVEL_BITS: Readonly<Record<QrEcc, number>> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
const FORMAT_GENERATOR = 0b10100110111; // x^10 + x^8 + x^5 + x^4 + x^2 + x + 1
const FORMAT_XOR = 0b101010000010010;
const VERSION_GENERATOR = 0b1111100100101; // x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1

/** Remainder of `value` x^degree divided by `generator` (polynomials over GF(2), as bits). */
function bchRemainder(value: number, generator: number, degree: number): number {
  let r = value << degree;
  for (let bit = 31 - Math.clz32(r); bit >= degree; bit--) if (r & (1 << bit)) r ^= generator << (bit - degree);
  return r;
}

/** The 15 format bits for a level and mask, BCH-protected and masked (bit 14 first). */
export function qrFormatBits(ecc: QrEcc, mask: number): number {
  const data = (LEVEL_BITS[ecc] << 3) | mask;
  return ((data << 10) | bchRemainder(data, FORMAT_GENERATOR, 10)) ^ FORMAT_XOR;
}

/** The 18 version bits (versions 7 and up). */
export function qrVersionBits(version: number): number {
  return (version << 12) | bchRemainder(version, VERSION_GENERATOR, 12);
}

// Reed-Solomon over GF(256) with the field polynomial x^8 + x^4 + x^3 + x^2 + 1.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}
const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!);

const generators = new Map<number, Uint8Array>();
/** Generator polynomial (x - a^0)(x - a^1)...(x - a^(n-1)), coefficients highest degree first. */
function rsGenerator(n: number): Uint8Array {
  let g = generators.get(n);
  if (g) return g;
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!; // times x
      next[j + 1]! ^= gfMul(poly[j]!, GF_EXP[i]!); // times a^i (minus is plus in GF(2^8))
    }
    poly = next;
  }
  g = Uint8Array.from(poly);
  generators.set(n, g);
  return g;
}

/** The n error-correction codewords of one data block: the remainder of data(x) x^n divided by the generator. */
function rsRemainder(data: ArrayLike<number>, n: number): Uint8Array {
  const g = rsGenerator(n);
  const r = new Uint8Array(n);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ r[0]!;
    r.copyWithin(0, 1);
    r[n - 1] = 0;
    if (factor) for (let j = 0; j < n; j++) r[j]! ^= gfMul(g[j + 1]!, factor);
  }
  return r;
}

/** UTF-8 bytes of a string, without relying on TextEncoder (some TV runtimes lack it). Lone surrogates become U+FFFD. */
export function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    let c = ch.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** A symbol under construction: module colours plus which modules belong to function patterns. */
class Grid {
  readonly size: number;
  readonly dark: Uint8Array;
  readonly fixed: Uint8Array;
  constructor(readonly version: number) {
    this.size = 17 + 4 * version;
    this.dark = new Uint8Array(this.size * this.size);
    this.fixed = new Uint8Array(this.size * this.size);
    this.drawFunctionPatterns();
  }

  set(x: number, y: number, dark: boolean) {
    const i = y * this.size + x;
    this.dark[i] = dark ? 1 : 0;
    this.fixed[i] = 1;
  }

  private drawFunctionPatterns() {
    const { size, version } = this;
    // Timing patterns first: finders and alignment patterns overwrite their ends.
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    // Finder patterns with their light separators (clipped at the edges).
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, ring !== 2 && ring !== 4);
        }
    }
    // Alignment patterns, except where they would overlap a finder.
    const centres = ALIGNMENT[version - 1]!;
    const last = centres.length - 1;
    for (let i = 0; i <= last; i++)
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) this.set(centres[j]! + dx, centres[i]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    // Reserve the format areas (written for real once the mask is known), and the always-dark module.
    this.drawFormat(0);
    this.set(8, size - 8, true);
    if (version >= 7) this.drawVersion();
  }

  /** Both copies of the 15 format bits. Bit 14 is the most significant. */
  drawFormat(bits: number) {
    const { size } = this;
    const bit = (b: number) => ((bits >>> b) & 1) === 1;
    // Copy 1, around the top-left finder: bits 14..9 along row 8, then bit 8, 7, 6 at the corner, then 5..0 up column 8.
    for (let k = 0; k <= 5; k++) this.set(k, 8, bit(14 - k));
    this.set(7, 8, bit(8));
    this.set(8, 8, bit(7));
    this.set(8, 7, bit(6));
    for (let k = 9; k <= 14; k++) this.set(8, 14 - k, bit(14 - k));
    // Copy 2: bits 14..8 up from the bottom of column 8, bits 7..0 along row 8 to the right edge.
    for (let k = 0; k <= 6; k++) this.set(8, size - 1 - k, bit(14 - k));
    for (let k = 7; k <= 14; k++) this.set(size - 15 + k, 8, bit(14 - k));
  }

  /** Both 6 x 3 copies of the 18 version bits (bit 0 first). */
  private drawVersion() {
    const { size } = this;
    const bits = qrVersionBits(this.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      this.set(b, a, dark); // top right
      this.set(a, b, dark); // bottom left
    }
  }

  /** Codewords the data area holds: free modules / 8 (the 0, 3, 4 or 7 left-over modules stay light). */
  freeCodewords(): number {
    let free = 0;
    for (const f of this.fixed) if (!f) free++;
    return Math.floor(free / 8);
  }

  /** Place the codeword stream in the two-column zigzag from the bottom-right corner, skipping the timing column. */
  placeData(codewords: Uint8Array) {
    const { size } = this;
    const bitCount = codewords.length * 8;
    let i = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let k = 0; k < size; k++) {
        const y = upward ? size - 1 - k : k;
        for (let dx = 0; dx < 2; dx++) {
          const idx = y * size + right - dx;
          if (this.fixed[idx]) continue;
          this.dark[idx] = i < bitCount ? (codewords[i >>> 3]! >>> (7 - (i & 7))) & 1 : 0;
          i++;
        }
      }
      upward = !upward;
    }
  }
}

/** The eight data masks (Table 10): true where a data module is inverted. `i` is the row, `j` the column. */
const MASKS: ReadonlyArray<(i: number, j: number) => boolean> = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): Uint8Array {
  const { size, dark, fixed } = grid;
  const out = dark.slice();
  const m = MASKS[mask]!;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (!fixed[idx] && m(y, x)) out[idx]! ^= 1;
    }
  return out;
}

const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1];

/** Penalty score of a finished symbol (section 7.8.3): long runs, 2 x 2 blocks, finder look-alikes, dark balance. */
export function qrPenalty(modules: ArrayLike<number>, size: number): number {
  let score = 0;
  const at = (x: number, y: number) => modules[y * size + x]!;
  for (let pass = 0; pass < 2; pass++) {
    // pass 0 reads rows, pass 1 reads columns
    const get = pass === 0 ? (line: number, k: number) => at(k, line) : (line: number, k: number) => at(line, k);
    for (let line = 0; line < size; line++) {
      // Rule 1: 5 or more of one colour in a row scores 3, plus 1 for each module past 5.
      let run = 1;
      for (let k = 1; k <= size; k++) {
        if (k < size && get(line, k) === get(line, k - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      // Rule 3: 1:1:3:1:1 (dark-light-dark x3-light-dark) with 4 light modules on one side. Outside the symbol is light.
      for (let k = -4; k < size; k++) {
        let match = true;
        for (let p = 0; p < 7 && match; p++) {
          const pos = k + p;
          const v = pos >= 0 && pos < size ? get(line, pos) : 0;
          if (v !== FINDER_LIKE[p]) match = false;
        }
        if (!match) continue;
        const light = (from: number) => {
          for (let q = from; q < from + 4; q++) if (q >= 0 && q < size && get(line, q)) return false;
          return true;
        };
        if (light(k - 4)) score += 40;
        if (light(k + 7)) score += 40;
      }
    }
  }
  // Rule 2: every 2 x 2 block of one colour scores 3 (overlapping blocks count separately).
  let dark = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const v = at(x, y);
      dark += v;
      if (x + 1 < size && y + 1 < size && v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  // Rule 4: 10 points for every full 5% the dark share is away from 50%.
  const total = size * size;
  score += 10 * Math.floor(Math.abs(dark * 20 - total * 10) / total);
  return score;
}

const capacity = new Map<number, number>();
/** Total codewords (data + error correction) in a version. */
function totalCodewords(version: number): number {
  let n = capacity.get(version);
  if (n === undefined) {
    n = new Grid(version).freeCodewords();
    capacity.set(version, n);
  }
  return n;
}

/** Data codewords a version holds at a level. */
export function qrDataCodewords(version: number, ecc: QrEcc): number {
  const l = LEVELS.indexOf(ecc);
  return totalCodewords(version) - EC_CODEWORDS_PER_BLOCK[l]![version - 1]! * EC_BLOCKS[l]![version - 1]!;
}

/** Bytes of text that fit in byte mode at this version and level. */
export function qrByteCapacity(version: number, ecc: QrEcc = 'M'): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((qrDataCodewords(version, ecc) * 8 - 4 - countBits) / 8);
}

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Split data into blocks, add each block's error correction, and interleave (section 7.6). */
function interleave(data: Uint8Array, version: number, ecc: QrEcc): Uint8Array {
  const l = LEVELS.indexOf(ecc);
  const ecLen = EC_CODEWORDS_PER_BLOCK[l]![version - 1]!;
  const blocks = EC_BLOCKS[l]![version - 1]!;
  const total = totalCodewords(version);
  const shortBlock = Math.floor(total / blocks); // codewords in a short block, data + ec
  const longBlocks = total % blocks;
  const shortBlocks = blocks - longBlocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortBlock - ecLen + (b >= shortBlocks ? 1 : 0);
    const d = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(d);
    ecBlocks.push(rsRemainder(d, ecLen));
  }
  const out = new Uint8Array(total);
  let k = 0;
  for (let i = 0; i <= shortBlock - ecLen; i++) for (const d of dataBlocks) if (i < d.length) out[k++] = d[i]!;
  for (let i = 0; i < ecLen; i++) for (const e of ecBlocks) out[k++] = e[i]!;
  return out;
}

/**
 * Encode text as a QR Code symbol in byte mode (UTF-8). Picks the smallest version that fits and the mask with
 * the lowest penalty. Throws a RangeError when the text does not fit in `maxVersion` at the chosen level.
 */
export function qrMatrix(text: string, opts: QrOptions = {}): QrMatrix {
  const ecc = opts.ecc ?? 'M';
  if (!LEVELS.includes(ecc)) throw new RangeError(`qr: unknown error correction level "${String(ecc)}"`);
  const minVersion = Math.max(1, Math.min(40, Math.floor(opts.minVersion ?? 1)));
  const maxVersion = Math.max(minVersion, Math.min(40, Math.floor(opts.maxVersion ?? 40)));
  const bytes = utf8Bytes(text);
  const header = opts.eci ? 12 : 0; // ECI mode (4 bits) + designator 26 (8 bits)
  let version = minVersion;
  for (; version <= maxVersion; version++) {
    const countBits = version <= 9 ? 8 : 16;
    if (bytes.length < 2 ** countBits && header + 4 + countBits + bytes.length * 8 <= qrDataCodewords(version, ecc) * 8) break;
  }
  if (version > maxVersion) throw new RangeError(`qr: ${bytes.length} bytes do not fit a version-${maxVersion} symbol at level ${ecc}`);

  // Data bit stream: [ECI] mode, count, bytes, terminator, padding to a byte, then the 0xEC 0x11 pad codewords.
  const capacityBits = qrDataCodewords(version, ecc) * 8;
  const buf = new BitBuffer();
  if (opts.eci) {
    buf.put(0b0111, 4);
    buf.put(26, 8);
  }
  buf.put(0b0100, 4);
  buf.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  buf.put(0, Math.min(4, capacityBits - buf.bits.length));
  buf.put(0, (8 - (buf.bits.length % 8)) % 8);
  const data = new Uint8Array(capacityBits / 8);
  for (let i = 0; i < buf.bits.length; i++) data[i >>> 3]! |= buf.bits[i]! << (7 - (i & 7));
  for (let i = buf.bits.length / 8, pad = 0xec; i < data.length; i++, pad ^= 0xec ^ 0x11) data[i] = pad;

  const grid = new Grid(version);
  grid.placeData(interleave(data, version, ecc));

  let best: { mask: number; modules: Uint8Array } | null = null;
  let bestScore = Infinity;
  const candidates = opts.mask !== undefined ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const mask of candidates) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError(`qr: mask must be 0..7, got ${String(mask)}`);
    grid.drawFormat(qrFormatBits(ecc, mask));
    const modules = applyMask(grid, mask);
    const score = candidates.length > 1 ? qrPenalty(modules, grid.size) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = { mask, modules };
    }
  }
  const { size } = grid;
  const chosen = best!;
  const modules: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = new Array(size);
    for (let x = 0; x < size; x++) row[x] = chosen.modules[y * size + x] === 1;
    modules.push(row);
  }
  return { size, version, ecc, mask: chosen.mask, modules };
}

/** Horizontal runs of dark modules, row by row: what a renderer draws instead of one shape per module. */
export function qrRuns(matrix: Pick<QrMatrix, 'size' | 'modules'>): QrRun[] {
  const runs: QrRun[] = [];
  for (let y = 0; y < matrix.size; y++) {
    const row = matrix.modules[y]!;
    for (let x = 0; x < matrix.size; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < matrix.size && row[x]) x++;
      runs.push({ x: start, y, w: x - start });
    }
  }
  return runs;
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * One SVG path `d` string covering every dark module, merged into horizontal runs. `cell` is the module size
 * (default 1) and `margin` shifts the drawing by that many modules (the quiet zone; default 0).
 */
export function qrSvgPath(matrix: Pick<QrMatrix, 'size' | 'modules'>, opts: { cell?: number; margin?: number } = {}): string {
  const cell = opts.cell ?? 1;
  const m = opts.margin ?? 0;
  let d = '';
  for (const r of qrRuns(matrix)) d += `M${fmt((r.x + m) * cell)} ${fmt((r.y + m) * cell)}h${fmt(r.w * cell)}v${fmt(cell)}h${fmt(-r.w * cell)}z`;
  return d;
}

/** A complete SVG document for a matrix, with a quiet zone (default 4 modules). */
export function qrSvg(matrix: Pick<QrMatrix, 'size' | 'modules'>, opts: { cell?: number; margin?: number; dark?: string; light?: string } = {}): string {
  const cell = opts.cell ?? 8;
  const margin = opts.margin ?? 4;
  const side = fmt((matrix.size + 2 * margin) * cell);
  const esc = (s: string) => s.replace(/[<>&"]/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${esc(opts.light ?? '#fff')}"/>` +
    `<path fill="${esc(opts.dark ?? '#000')}" d="${qrSvgPath(matrix, { cell, margin })}"/></svg>`
  );
}

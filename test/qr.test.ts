// The QR encoder is checked by decoding: every symbol is rasterized to RGBA and read back with an independent
// decoder (a devDependency), which must return the exact input text and the version we chose.
import jsqr from 'jsqr';
import { describe, expect, it } from 'vitest';
import { qrAlignmentCentres, qrByteCapacity, qrFormatBits, qrMatrix, qrRuns, qrSvg, qrSvgPath, qrVersionBits, utf8Bytes, type QrEcc, type QrMatrix } from '../src/qr.js';

// The decoder is CommonJS: at run time the default import is the decoder function itself.
const jsQR = ((jsqr as unknown as { default?: unknown }).default ?? jsqr) as typeof jsqr.default;
const LEVELS: QrEcc[] = ['L', 'M', 'Q', 'H'];

/** Rasterize with a 4-module quiet zone, `scale` pixels per module. */
function raster(m: Pick<QrMatrix, 'size' | 'modules'>, scale = 4, margin = 4) {
  const side = (m.size + 2 * margin) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++) {
      if (!m.modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + margin) * scale + dy) * side + (x + margin) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
    }
  return { px, side };
}

function decode(m: Pick<QrMatrix, 'size' | 'modules'>, scale = 4) {
  const { px, side } = raster(m, scale);
  return jsQR(px, side, side, { inversionAttempts: 'dontInvert' });
}

function roundTrip(text: string, opts: Parameters<typeof qrMatrix>[1] = {}) {
  const m = qrMatrix(text, opts);
  const scale = m.size > 100 ? 3 : 4;
  const got = decode(m, scale);
  expect(got, `decode failed: v${m.version}-${m.ecc} mask ${m.mask}, ${text.length} chars`).not.toBeNull();
  expect(got!.data).toBe(text);
  expect(got!.version).toBe(m.version);
  return m;
}

/** A deterministic printable-ASCII filler of exactly n bytes. */
const filler = (n: number, seed = 7) => {
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += String.fromCharCode(33 + (x % 94));
  }
  return s;
};

describe('qr: decodes back to the input', () => {
  const samples = [
    'A',
    'hello',
    'http://192.168.1.20:8800/p/K7QF',
    'https://tv.example/p/K7QF#k=Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3A',
    'https://hub.example.com:8443/p/ABCD?name=living%20room&lang=en-US#k=' + 'x'.repeat(120),
    'Café ☕ 日本語 🎉 naïve résumé',
    'Ünïcödé only: Привет, мир',
    '',
    ' leading and trailing spaces ',
  ];
  for (const ecc of LEVELS) it.each(samples)(`ecc ${ecc}: %j`, (text) => void roundTrip(text, { ecc }));

  it('defaults to level M and the smallest version that fits', () => {
    const m = roundTrip('http://192.168.1.20:8800/p/K7QF');
    expect(m.ecc).toBe('M');
    expect(m.version).toBe(3); // 31 bytes: version 2-M holds 26, version 3-M holds 42
    expect(m.size).toBe(29);
    expect(m.modules).toHaveLength(29);
    expect(m.modules.every((r) => r.length === 29)).toBe(true);
  });

  it('byte capacities match the spec table at the corners (versions 1 and 40)', () => {
    expect(LEVELS.map((l) => qrByteCapacity(1, l))).toEqual([17, 14, 11, 7]);
    expect(LEVELS.map((l) => qrByteCapacity(40, l))).toEqual([2953, 2331, 1663, 1273]);
  });

  // The strongest check of the block and alignment tables: fill every version at every level to the last byte,
  // and one byte over, and read each one back.
  // One exception: the decoder's own table puts version 23's fourth alignment centre at 74, where the spec (Table E.1)
  // has 78, as its even spacing requires. It then reads the wrong modules there. Levels M, Q and H have enough error
  // correction to absorb that; level L does not, so 23-L is only checked structurally (see 'alignment centres' below).
  const decoderTableMismatch = (v: number, ecc: QrEcc) => v === 23 && ecc === 'L';
  for (const ecc of LEVELS)
    it(`ecc ${ecc}: every version 1..40 at full capacity, and one byte past it moves up a version`, () => {
      for (let v = 1; v <= 40; v++) {
        const cap = qrByteCapacity(v, ecc);
        if (decoderTableMismatch(v, ecc)) expect(qrMatrix(filler(cap, v), { ecc }).version).toBe(v);
        else expect(roundTrip(filler(cap, v), { ecc }).version).toBe(v);
        if (v < 40) expect(qrMatrix(filler(cap + 1, v), { ecc }).version).toBe(v + 1);
      }
    }, 60_000);

  it('alignment centres: 6 first, size - 7 last, evenly spaced from the last one back, and drawn (version 23 included)', () => {
    expect(qrAlignmentCentres(1)).toEqual([]);
    for (let v = 2; v <= 40; v++) {
      const c = qrAlignmentCentres(v);
      const size = 17 + 4 * v;
      expect(c).toHaveLength(Math.floor(v / 7) + 2);
      expect(c[0]).toBe(6);
      expect(c[c.length - 1]).toBe(size - 7);
      const gaps = c.slice(1).map((x, i) => x - c[i]!);
      expect(new Set(gaps.slice(1)).size).toBeLessThanOrEqual(1); // all gaps but the first are equal
      expect(c.every((x) => x % 2 === 0)).toBe(true);
      // Each pattern is in the symbol: dark centre, light ring, dark border (skipping the three finder corners).
      const m = qrMatrix('x', { minVersion: v, mask: 0 });
      const last = c.length - 1;
      for (let i = 0; i <= last; i++)
        for (let j = 0; j <= last; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
          for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) expect(m.modules[c[i]! + dy]![c[j]! + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
  });

  it('every mask pattern decodes; automatic selection picks one of them', () => {
    const text = 'https://tv.example/p/K7QF';
    for (let mask = 0; mask < 8; mask++) expect(roundTrip(text, { mask }).mask).toBe(mask);
    const auto = qrMatrix(text);
    expect(auto.mask).toBeGreaterThanOrEqual(0);
    expect(auto.mask).toBeLessThan(8);
  });

  it('UTF-8 with an ECI 26 header also decodes', () => {
    const m = roundTrip('日本語のテキスト 🎉', { eci: true });
    expect(m.version).toBeGreaterThanOrEqual(1);
  });

  it('minVersion and maxVersion bound the choice; too much text is a RangeError', () => {
    expect(roundTrip('hi', { minVersion: 5 }).version).toBe(5);
    expect(() => qrMatrix(filler(100), { maxVersion: 3 })).toThrow(RangeError);
    expect(() => qrMatrix(filler(2954), { ecc: 'L' })).toThrow(/do not fit/);
    expect(() => qrMatrix('x', { mask: 9 })).toThrow(RangeError);
  });
});

describe('qr: format and version information', () => {
  it('BCH-coded words match the spec examples', () => {
    expect(qrFormatBits('M', 0)).toBe(0b101010000010010); // data 00000: only the fixed mask pattern
    expect(qrFormatBits('L', 0)).toBe(0b111011111000100);
    expect(qrVersionBits(7)).toBe(0b000111110010010100);
  });

  // Each copy must be readable on its own: damage four bits of one copy (beyond the decoder's 3-bit correction)
  // and the symbol must still decode from the other.
  const flip = (m: QrMatrix, cells: Array<[number, number]>) => {
    const modules = m.modules.map((r) => [...r]);
    for (const [x, y] of cells) modules[y]![x] = !modules[y]![x];
    return { size: m.size, modules };
  };
  it('the format information reads from either copy', () => {
    const text = 'https://tv.example/p/K7QF#k=0123456789abcdef0123456789abcdef0123456789abcdef';
    for (const ecc of LEVELS) {
      const m = qrMatrix(text, { ecc, minVersion: 7 });
      const s = m.size;
      const firstDamaged = flip(m, [[0, 8], [1, 8], [2, 8], [3, 8]]);
      const secondDamaged = flip(m, [[8, s - 1], [8, s - 2], [8, s - 3], [8, s - 4]]);
      expect(decode(firstDamaged)?.data).toBe(text);
      expect(decode(secondDamaged)?.data).toBe(text);
    }
  });
  it('the version information reads from either copy', () => {
    for (const v of [7, 12, 21, 33, 40]) {
      const text = filler(qrByteCapacity(v, 'M'), v);
      const m = qrMatrix(text);
      expect(m.version).toBe(v);
      const s = m.size;
      const topRightDamaged = flip(m, [[s - 11, 0], [s - 11, 1], [s - 11, 2], [s - 11, 3]]);
      const bottomLeftDamaged = flip(m, [[0, s - 11], [1, s - 11], [2, s - 11], [3, s - 11]]);
      const scale = s > 100 ? 3 : 4;
      expect(decode(topRightDamaged, scale)?.data).toBe(text);
      expect(decode(bottomLeftDamaged, scale)?.data).toBe(text);
    }
  }, 30_000);
});

describe('qr: rendering helpers', () => {
  const m = qrMatrix('https://tv.example/p/K7QF');

  it('runs cover exactly the dark modules, merged per row', () => {
    const grid = m.modules.map((r) => r.map(() => false));
    for (const r of qrRuns(m)) {
      expect(r.w).toBeGreaterThan(0);
      for (let x = r.x; x < r.x + r.w; x++) {
        expect(grid[r.y]![x]).toBe(false); // no overlap
        grid[r.y]![x] = true;
      }
      expect(m.modules[r.y]![r.x - 1] ?? false).toBe(false); // maximal: nothing dark just before or after
      expect(m.modules[r.y]![r.x + r.w] ?? false).toBe(false);
    }
    expect(grid).toEqual(m.modules);
  });

  it('qrSvgPath is one path of rectangles, scaled and shifted by the quiet zone', () => {
    const d = qrSvgPath(m, { cell: 10, margin: 4 });
    const rects = d.match(/M[^z]+z/g)!;
    expect(rects).toHaveLength(qrRuns(m).length);
    expect(rects[0]).toBe('M40 40h70v10h-70z'); // the top-left finder's first row: 7 modules at (4, 4)
  });

  it('qrSvg renders a full document whose path decodes when rasterized back', () => {
    const svg = qrSvg(m);
    expect(m.size).toBe(25); // 25 bytes fit version 2-M (26)
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 264 264"/); // (25 + 8) x 8
    const d = /d="([^"]+)"/.exec(svg)![1]!;
    const back = m.modules.map((r) => r.map(() => false));
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      for (let k = 0; k < Number(w) / 8; k++) back[Number(y) / 8 - 4]![Number(x) / 8 - 4 + k] = true;
    }
    expect(decode({ size: m.size, modules: back })?.data).toBe('https://tv.example/p/K7QF');
  });

  it('utf8Bytes matches the platform encoder, including astral characters and lone surrogates', () => {
    for (const s of ['abc', 'é', '€', '日本', '🎉', 'a\ud800b']) expect(utf8Bytes(s)).toEqual([...new TextEncoder().encode(s)]);
  });
});

// scripts/bench.mjs: the stick run's numbers, from the voice-loop hub's {"event":"loop"} lines.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script
import { bench, percentile } from '../scripts/bench.mjs';

const loop = (heardMs: number | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'loop', said: 'hello', shownMs: 20, agentMs: 3, ttsMs: 150, sayToPlayingMs: 90, heardMs, replyMs: 1200, state: 'ended', ...extra });

describe('scripts/bench.mjs', () => {
  it('percentile is nearest-rank: p50 of 1..10 is 5, p95 is 10', () => {
    const xs = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });

  it('reads only loop lines, summarizes each leg, counts states, and keeps the nulls out of the numbers', () => {
    const log = [
      '{"event":"ready","port":8790}',
      'not json',
      ...[100, 200, 300, 400, 500].map((h) => loop(h)),
      loop(null, { state: 'error: MediaError 4', sayToPlayingMs: null }),
      loop(250, { state: 'interrupted' }),
    ].join('\n');
    const b = bench(log, { label: 'test run' });
    expect(b.label).toBe('test run');
    expect(b.n).toBe(7);
    expect(b.states).toEqual({ ended: 5, 'error: MediaError 4': 1, interrupted: 1 });
    expect(b.legs.heardMs).toEqual({ n: 6, min: 100, p50: 250, p95: 500, max: 500 });
    expect(b.legs.sayToPlayingMs.n).toBe(6);
    expect(b.legs.shownMs).toEqual({ n: 7, min: 20, p50: 20, p95: 20, max: 20 });
  });

  it('prints JSON, or a markdown table with --markdown; fails on a log with no loop lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvb-bench-'));
    try {
      const file = join(dir, 'hub.log');
      writeFileSync(file, [loop(300), loop(320)].join('\n'));
      const script = fileURLToPath(new URL('../scripts/bench.mjs', import.meta.url));
      const json = JSON.parse(execFileSync('node', [script, file, '--label', 'stick'], { encoding: 'utf8' }));
      expect(json).toMatchObject({ label: 'stick', n: 2, legs: { heardMs: { p50: 300, p95: 320 } } });
      const md = execFileSync('node', [script, file, '--markdown'], { encoding: 'utf8' });
      expect(md).toContain('| speech end → reply audible (`heardMs`) | 2 | 300 | 320 | 300–320 |');
      writeFileSync(file, '{"event":"ready"}\n');
      expect(() => execFileSync('node', [script, file], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

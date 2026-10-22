#!/usr/bin/env node
// The numbers of a measured run, from the voice-loop hub's log: one {"event":"loop",...} JSON line per utterance
// (examples/vega-voice-loop/hub.mjs prints them). Per leg: n, min, p50, p95, max in milliseconds, hub clock.
//   node scripts/bench.mjs stick-scripted.log --label "Fire TV Stick, scripted phone" > bench-scripted.json
//   node scripts/bench.mjs stick-scripted.log --markdown
// Percentiles are nearest-rank (p95 of 20 values is the 19th smallest). A leg that was not measured for a line
// (no audio played, say) is left out of that leg's numbers, and the line's state is counted.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LEGS = {
  shownMs: 'speech end → answer on screen',
  agentMs: 'transcript in → agent reply',
  ttsMs: 'reply → clip ready (text-to-speech)',
  sayToPlayingMs: '`screen.say` → audio playing',
  heardMs: 'speech end → reply audible',
  replyMs: 'reply playing time',
};

/** Nearest-rank percentile of the values, or null when there are none. */
export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length, Math.max(1, Math.ceil((p / 100) * xs.length))) - 1];
}

export function bench(log, { label = '' } = {}) {
  const rows = [];
  for (const line of String(log).split(/\r?\n/)) {
    try {
      const e = JSON.parse(line);
      if (e && e.event === 'loop') rows.push(e);
    } catch {
      // not a JSON line (a warning, a stack trace): skip it
    }
  }
  const legs = {};
  for (const leg of Object.keys(LEGS)) {
    const xs = rows.map((r) => r[leg]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    legs[leg] = { n: xs.length, min: xs.length ? Math.min(...xs) : null, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null };
  }
  const states = {};
  for (const r of rows) states[r.state ?? 'unknown'] = (states[r.state ?? 'unknown'] ?? 0) + 1;
  return { label, n: rows.length, legs, states, said: rows.map((r) => r.said) };
}

export function markdown(b) {
  const lines = [`${b.label ? `**${b.label}**, ` : ''}N=${b.n} (hub clock, ms; nearest-rank percentiles)`, '', '| Leg | N | p50 | p95 | min–max |', '|---|---|---|---|---|'];
  for (const [leg, name] of Object.entries(LEGS)) {
    const s = b.legs[leg];
    if (s.n) lines.push(`| ${name} (\`${leg}\`) | ${s.n} | ${s.p50} | ${s.p95} | ${s.min}–${s.max} |`);
  }
  lines.push('', `States: ${Object.entries(b.states).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--label');
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : '';
  const b = bench(readFileSync(file ?? 0, 'utf8'), { label });
  if (!b.n) {
    console.error('no {"event":"loop"} lines in the log');
    process.exit(1);
  }
  process.stdout.write(args.includes('--markdown') ? markdown(b) : `${JSON.stringify(b, null, 2)}\n`);
}

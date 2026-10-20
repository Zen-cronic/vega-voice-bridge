import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs example module
import { createTts, ttsEngine } from '../examples/vega-voice-loop/tts.mjs';

type Call = { cmd: string; args: string[]; env?: Record<string, string> };
const recorder = () => {
  const calls: Call[] = [];
  return { calls, run: async (cmd: string, args: string[], env?: Record<string, string>) => void calls.push({ cmd, args, env }) };
};
// Stands in for ffmpeg: writes its output file (the last argument), or fails on the step named.
const encoder = (o: { failOn?: 'm4a' | 'mp3'; calls?: Call[] } = {}) => async (cmd: string, args: string[]) => {
  o.calls?.push({ cmd, args });
  const out = args.at(-1)!;
  writeFileSync(out, 'partial');
  if (o.failOn && out.endsWith(`.${o.failOn}`)) throw new Error('ffmpeg: killed');
};

describe('the voice loop text-to-speech', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('picks say on macOS and espeak elsewhere by default', () => {
    expect(ttsEngine({}, { os: 'darwin' }).name).toBe('say');
    expect(ttsEngine({ TTS_VOICE: 'Ava' }, { os: 'darwin' }).name).toBe('say (Ava)');
    expect(ttsEngine({}, { os: 'linux' }).name).toBe('espeak');
  });

  it('TTS_ENGINE=polly asks the AWS CLI for a generative Ruth clip in us-east-1 unless told otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const r = recorder();
    const e = ttsEngine({ TTS_ENGINE: 'polly' }, { run: r.run, os: 'linux' });
    expect(e.name).toBe('polly (generative Ruth)');
    expect(await e.render('-1 is the answer.', join(dir, 'abc'))).toBe(join(dir, 'abc.polly.mp3'));
    expect(r.calls[0]?.cmd).toBe('aws');
    expect(r.calls[0]?.args).toEqual(['polly', 'synthesize-speech', '--region', 'us-east-1', '--engine', 'generative', '--voice-id', 'Ruth', '--output-format', 'mp3', '--sample-rate', '24000', '--text', `file://${join(dir, 'abc.polly.txt')}`, join(dir, 'abc.polly.mp3')]);
    expect(r.calls[0]?.env).toEqual({ AWS_CLI_FILE_ENCODING: 'UTF-8' });
    const n = ttsEngine({ TTS_ENGINE: 'polly', POLLY_VOICE: 'Matthew', POLLY_ENGINE: 'neural', AWS_REGION: 'us-west-2' }, { run: r.run });
    expect(n.name).toBe('polly (neural Matthew)');
    await n.render('Hi.', join(dir, 'def'));
    expect(r.calls[1]?.args.slice(2, 8)).toEqual(['--region', 'us-west-2', '--engine', 'neural', '--voice-id', 'Matthew']);
  });

  it('Polly gets the reply text from a file, so text that starts with file://, fileb:// or a URL is spoken, not loaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const seen: Array<{ args: string[]; text: string }> = [];
    // Stands in for the AWS CLI: reads the --text file the way the CLI does, while it exists.
    const run = async (_cmd: string, args: string[]) => {
      const v = args[args.indexOf('--text') + 1]!;
      seen.push({ args, text: readFileSync(v.slice('file://'.length), 'utf8') });
    };
    const e = ttsEngine({ TTS_ENGINE: 'polly' }, { run, os: 'linux' });
    const hostile = ['file:///home/someone/.aws/credentials', 'fileb:///etc/hostname', 'https://example.invalid/x', 'http://example.invalid/x', 'Café — ok'];
    for (const [i, text] of hostile.entries()) await e.render(text, join(dir, `h${i}`));
    for (const [i, call] of seen.entries()) {
      // No argument the CLI parses is the reply itself; the only file:// value is our own input file.
      for (const a of call.args) expect(a).not.toContain(hostile[i]);
      expect(call.text).toBe(hostile[i]);
    }
    // The input file is gone afterwards, whether the CLI succeeded or not.
    const failing = ttsEngine({ TTS_ENGINE: 'polly' }, { run: async () => Promise.reject(new Error('aws: no credentials')), os: 'linux' });
    await expect(failing.render('x', join(dir, 'f'))).rejects.toThrow(/no credentials/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('TTS_CMD wins over every other engine', () => {
    expect(ttsEngine({ TTS_CMD: 'x', TTS_ENGINE: 'polly' }).name).toBe('custom');
  });

  it('encodes whatever the engine rendered into fragmented MP4 and MP3, keyed by engine and text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const calls: Call[] = [];
    const run = encoder({ calls });
    const engine = { name: 'polly (generative Ruth)', render: async (_t: string, base: string) => (writeFileSync(`${base}.polly.mp3`, 'x'), `${base}.polly.mp3`) };
    const tts = createTts({ dir, engine, run });
    const { id } = await tts.clip('Hello there.');
    const other = await createTts({ dir, engine: { ...engine, name: 'espeak' }, run }).clip('Hello there.');
    expect(other.id).not.toBe(id);
    const [m4a, mp3] = calls as [Call, Call];
    expect(m4a.args.some((a) => a.startsWith(join(dir, `${id}.`)) && a.endsWith('.polly.mp3'))).toBe(true);
    expect(m4a.args).toEqual(expect.arrayContaining(['-movflags', '+frag_keyframe+empty_moov+default_base_moof']));
    expect(mp3.args).toEqual(expect.arrayContaining(['libmp3lame']));
    // encoded into work files, then moved into place; nothing else is left
    expect(readdirSync(dir).sort()).toEqual([`${id}.m4a`, `${id}.mp3`, `${other.id}.m4a`, `${other.id}.mp3`].sort());
    expect((await tts.clip('Hello there.')).cached).toBe(true);
  });

  it('a failed or killed encode leaves no clip to be served from the cache, and no work files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const engine = { name: 'espeak', render: async (_t: string, base: string) => (writeFileSync(`${base}.wav`, 'x'), `${base}.wav`) };
    for (const failOn of ['m4a', 'mp3'] as const) {
      const tts = createTts({ dir, engine, run: encoder({ failOn }) });
      await expect(tts.clip('Broken reply.')).rejects.toThrow(/killed/);
      expect(readdirSync(dir)).toEqual([]);
    }
    // the engine failing leaves nothing either, and a later render that works is not served a broken clip
    const failing = createTts({ dir, engine: { name: 'espeak', render: async (_t: string, base: string) => (writeFileSync(`${base}.wav`, 'half'), Promise.reject(new Error('espeak: no voice'))) }, run: encoder() });
    await expect(failing.clip('Broken reply.')).rejects.toThrow(/no voice/);
    expect(readdirSync(dir)).toEqual([]);
    const ok = await createTts({ dir, engine, run: encoder() }).clip('Broken reply.');
    expect(ok.cached).toBe(false);
    // only the .m4a there (an older version's partial clip): rendered again, not served
    rmSync(join(dir, `${ok.id}.mp3`));
    expect((await createTts({ dir, engine, run: encoder() }).clip('Broken reply.')).cached).toBe(false);
    expect(existsSync(join(dir, `${ok.id}.mp3`))).toBe(true);
  });

  it('the same clip asked for twice while it renders is rendered once, and renders never share work files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const bases: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const engine = { name: 'espeak', render: async (_t: string, base: string) => (bases.push(base), await gate, `${base}.wav`) };
    const tts = createTts({ dir, engine, run: encoder() });
    const a = tts.clip('Same reply.');
    const b = tts.clip('Same reply.');
    const c = tts.clip('Another reply.');
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(rb).toBe(ra);
    expect(rc.id).not.toBe(ra.id);
    expect(bases).toHaveLength(2);
    // After it settles, a new render (the clip was removed, so it renders again) gets its own files.
    for (const ext of ['m4a', 'mp3']) rmSync(join(dir, `${ra.id}.${ext}`));
    await tts.clip('Same reply.');
    expect(bases).toHaveLength(3);
    expect(new Set(bases).size).toBe(3);
    for (const base of bases) expect(base).not.toBe(join(dir, ra.id));
  });
});

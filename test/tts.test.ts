import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs example module
import { createTts, sweepWorkFiles, ttsEngine } from '../examples/vega-voice-loop/tts.mjs';

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
    // encoded into work files, then moved into place with the marker that makes them cached; nothing else is left
    expect(readdirSync(dir).sort()).toEqual([`${id}.m4a`, `${id}.mp3`, `${id}.ok`, `${other.id}.m4a`, `${other.id}.mp3`, `${other.id}.ok`].sort());
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

  const wavEngine = { name: 'espeak', outputs: (b: string) => [`${b}.wav`], render: async (_t: string, base: string) => (writeFileSync(`${base}.wav`, 'x'), `${base}.wav`) };
  const DEAD = 99999999; // above any pid_max, so never a live process

  it('sweeps the work files a killed process left, and keeps those of a live one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const id = 'a'.repeat(16);
    const stale = [`${id}.${DEAD}-1.m4a`, `${id}.${DEAD}-1.wav`, `${id}.${DEAD}-0badf00d-3.polly.txt`, `${id}.${process.pid}-0badf00d-2.mp3`, `${id}.${process.pid}-7.m4a`];
    const keep = [`${id}.${process.ppid}-cafe0123-1.m4a`, `${id}.m4a`, `${id}.mp3`, `${id}.ok`, 'notes.txt'];
    for (const f of [...stale, ...keep]) writeFileSync(join(dir, f), 'x');
    createTts({ dir, engine: wavEngine, run: encoder() });
    expect(readdirSync(dir).sort()).toEqual([...keep].sort());
    expect(sweepWorkFiles(join(dir, 'gone'))).toBe(0);
  });

  it('close() stops the renders in flight and removes their files (the hub calls it on SIGINT and SIGTERM)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    // Stands in for an encoder that runs until it is stopped: it has written part of its output.
    const run = (_cmd: string, args: string[], _env: unknown, o: { signal?: AbortSignal } = {}) =>
      new Promise<void>((_res, rej) => {
        writeFileSync(args.at(-1)!, 'partial');
        o.signal?.addEventListener('abort', () => rej(new Error('ffmpeg: aborted')));
      });
    const tts = createTts({ dir, engine: wavEngine, run });
    const p = tts.clip('Long reply.');
    await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    await tts.close();
    await expect(p).rejects.toThrow(/aborted/);
    expect(readdirSync(dir)).toEqual([]);
    await expect(tts.clip('Another.')).rejects.toThrow(/closed/);
    // a command that ignores the signal: close() stops waiting after waitMs and removes the files anyway
    const deaf = createTts({ dir, engine: wavEngine, run: (_c: string, args: string[]) => new Promise<void>(() => writeFileSync(args.at(-1)!, 'partial')) });
    void deaf.clip('Stuck reply.');
    await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(dir).length).toBeGreaterThan(0);
    await deaf.close({ waitMs: 20 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('two instances on one dir never share work files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const bases: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const engine = { ...wavEngine, render: async (t: string, base: string) => (bases.push(base), await gate, wavEngine.render(t, base)) };
    const a = createTts({ dir, engine, run: encoder() }).clip('Same.');
    const b = createTts({ dir, engine, run: encoder() }).clip('Same.');
    release();
    expect((await Promise.allSettled([a, b])).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(new Set(bases).size).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([`${(await a).id}.m4a`, `${(await a).id}.mp3`, `${(await a).id}.ok`]);
  });

  it("a render's cleanup removes only its own files and never hides the render's error", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const other = `${'b'.repeat(16)}.${process.pid}-feedface-1.wav`; // looks like a work file, not this render's
    // the cache dir is removed while the engine runs, then the engine fails
    const engine = { ...wavEngine, render: async () => (rmSync(dir, { recursive: true, force: true }), Promise.reject(new Error('espeak: no voice'))) };
    await expect(createTts({ dir, engine, run: encoder() }).clip('Gone.')).rejects.toThrow(/no voice/);
    const dir2 = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir2);
    const tts = createTts({ dir: dir2, engine: wavEngine, run: encoder() });
    writeFileSync(join(dir2, other), 'x');
    await tts.clip('Mine.');
    expect(readdirSync(dir2)).toContain(other);
  });

  it('a clip is cached only with a marker that matches both files, so an older partial MP3 is rendered again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const { id } = await createTts({ dir, engine: wavEngine, run: encoder() }).clip('Cached?');
    expect((await createTts({ dir, engine: wavEngine, run: encoder() }).clip('Cached?')).cached).toBe(true);
    // 0.3.3 left a full .m4a and a .mp3 cut short, with no marker
    rmSync(join(dir, `${id}.ok`));
    writeFileSync(join(dir, `${id}.mp3`), 'cut');
    expect((await createTts({ dir, engine: wavEngine, run: encoder() }).clip('Cached?')).cached).toBe(false);
    expect(readFileSync(join(dir, `${id}.mp3`), 'utf8')).toBe('partial');
    // the marker is there but a file changed size since
    writeFileSync(join(dir, `${id}.mp3`), 'p');
    expect((await createTts({ dir, engine: wavEngine, run: encoder() }).clip('Cached?')).cached).toBe(false);
    // an encoder that wrote an empty clip is a failure, not a cached clip
    const empty = async (_c: string, args: string[]) => writeFileSync(args.at(-1)!, '');
    rmSync(join(dir, `${id}.ok`));
    await expect(createTts({ dir, engine: wavEngine, run: empty }).clip('Cached?')).rejects.toThrow(/empty clip/);
    expect(readdirSync(dir).filter((f) => !/^[0-9a-f]{16}\.(m4a|mp3)$/.test(f))).toEqual([]);
  });
});

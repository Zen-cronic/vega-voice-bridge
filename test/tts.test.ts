import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
    const r = recorder();
    const engine = { name: 'polly (generative Ruth)', render: async (_t: string, base: string) => `${base}.polly.mp3` };
    const tts = createTts({ dir, engine, run: r.run });
    const { id } = await tts.clip('Hello there.');
    const other = await createTts({ dir, engine: { ...engine, name: 'espeak' }, run: r.run }).clip('Hello there.');
    expect(other.id).not.toBe(id);
    const [m4a, mp3] = r.calls as [Call, Call];
    expect(m4a.args.some((a) => a.startsWith(join(dir, `${id}.`)) && a.endsWith('.polly.mp3'))).toBe(true);
    expect(m4a.args).toEqual(expect.arrayContaining(['-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(dir, `${id}.m4a`)]));
    expect(mp3.args).toEqual(expect.arrayContaining(['libmp3lame', join(dir, `${id}.mp3`)]));
  });

  it('the same clip asked for twice while it renders is rendered once, and renders never share work files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tts-'));
    dirs.push(dir);
    const r = recorder();
    const bases: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const engine = { name: 'espeak', render: async (_t: string, base: string) => (bases.push(base), await gate, `${base}.wav`) };
    const tts = createTts({ dir, engine, run: r.run });
    const a = tts.clip('Same reply.');
    const b = tts.clip('Same reply.');
    const c = tts.clip('Another reply.');
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(rb).toBe(ra);
    expect(rc.id).not.toBe(ra.id);
    expect(bases).toHaveLength(2);
    // After it settles, a new render (nothing was written by the stand-in, so it renders again) gets its own files.
    await tts.clip('Same reply.');
    expect(bases).toHaveLength(3);
    expect(new Set(bases).size).toBe(3);
    for (const base of bases) expect(base).not.toBe(join(dir, ra.id));
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
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
    const r = recorder();
    const e = ttsEngine({ TTS_ENGINE: 'polly' }, { run: r.run, os: 'linux' });
    expect(e.name).toBe('polly (generative Ruth)');
    expect(await e.render('-1 is the answer.', '/tmp/x/abc')).toBe('/tmp/x/abc.polly.mp3');
    expect(r.calls[0]?.cmd).toBe('aws');
    expect(r.calls[0]?.args).toEqual(['polly', 'synthesize-speech', '--region', 'us-east-1', '--engine', 'generative', '--voice-id', 'Ruth', '--output-format', 'mp3', '--sample-rate', '24000', '--text=-1 is the answer.', '/tmp/x/abc.polly.mp3']);
    const n = ttsEngine({ TTS_ENGINE: 'polly', POLLY_VOICE: 'Matthew', POLLY_ENGINE: 'neural', AWS_REGION: 'us-west-2' }, { run: r.run });
    expect(n.name).toBe('polly (neural Matthew)');
    await n.render('Hi.', '/tmp/x/def');
    expect(r.calls[1]?.args.slice(2, 8)).toEqual(['--region', 'us-west-2', '--engine', 'neural', '--voice-id', 'Matthew']);
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
    expect(m4a.args).toContain(join(dir, `${id}.polly.mp3`));
    expect(m4a.args).toEqual(expect.arrayContaining(['-movflags', '+frag_keyframe+empty_moov+default_base_moof', join(dir, `${id}.m4a`)]));
    expect(mp3.args).toEqual(expect.arrayContaining(['libmp3lame', join(dir, `${id}.mp3`)]));
  });
});

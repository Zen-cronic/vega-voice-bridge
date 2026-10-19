// `./vega`: the Vega say player, against a scripted stand-in for Vega's W3C media player (test/mocks/w3cmedia.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import { media } from './mocks/w3cmedia.js';
import { createVegaSayPlayer, RAW_HTTP_AUDIO } from '../src/vega.js';
import type { SayLine } from '../src/react.js';

const line = (audioUrl: string): SayLine => ({ id: 's1', text: 'Hello.', audioUrl, durationMs: 1500, priority: 'normal' });
const clip = (contentType = 'audio/mp4') => async () => ({ ok: true, status: 200, headers: { get: (h: string) => (h === 'content-type' ? contentType : null) }, arrayBuffer: async () => new ArrayBuffer(4096) });
const run = (player: ReturnType<typeof createVegaSayPlayer>, l: SayLine) => {
  const seen: string[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const stop = player(l, {
    playing: () => seen.push('playing'),
    ended: () => (seen.push('ended'), resolveDone()),
    error: (d) => (seen.push(`error: ${d}`), resolveDone()),
  });
  return { seen, done, stop };
};
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
/** A fetch whose body arrives only when the test says so (a clip still downloading). */
const slowClip = () => {
  let arrive!: () => void;
  const body = new Promise<void>((r) => (arrive = r));
  const fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'audio/mp4' }, arrayBuffer: async () => (await body, new ArrayBuffer(4096)) });
  return { fetch, arrive: () => arrive() };
};

beforeEach(() => media.reset());

describe('createVegaSayPlayer', () => {
  it('plays fragmented MP4/AAC from a plain-http hub through MSE, ending the stream once the demuxer has it', async () => {
    const p = createVegaSayPlayer({ fetch: clip() });
    const r = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await r.done;
    expect(r.seen).toEqual(['playing', 'ended']);
    expect(media.log).toContain('addSourceBuffer audio/mp4; codecs="mp4a.40.2"');
    // play first, end the stream only after the first sign (here canplay), never before
    const order = ['append 4096', 'play mse', 'event canplay', 'endOfStream'].map((e) => media.log.indexOf(e));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
  });
  it('refuses raw MP3 over http with a message, instead of the player\'s MediaError 3', async () => {
    const p = createVegaSayPlayer({ fetch: clip('audio/mpeg') });
    const r = run(p, line('http://127.0.0.1:8790/tts/a1.mp3'));
    await r.done;
    expect(r.seen).toEqual([`error: ${RAW_HTTP_AUDIO}`]);
    expect(media.log.some((e) => e.startsWith('play'))).toBe(false);
  });
  it('plays an https URL in URL mode, with no fetch', async () => {
    let fetched = 0;
    const p = createVegaSayPlayer({ fetch: async () => (fetched++, clip()()) });
    const r = run(p, line('https://cdn.example.com/a1.mp3'));
    await r.done;
    expect(r.seen).toEqual(['playing', 'ended']);
    expect(media.log).toContain('play https://cdn.example.com/a1.mp3');
    expect(fetched).toBe(0);
  });
  it('an https line after a plain-http one plays its URL, not the stream the last line left', async () => {
    const p = createVegaSayPlayer({ fetch: clip() });
    await run(p, line('http://127.0.0.1:8790/tts/a1.m4a')).done;
    const r = run(p, line('https://cdn.example.com/a2.mp3'));
    await r.done;
    expect(r.seen).toEqual(['playing', 'ended']);
    expect(media.log.filter((e) => e.startsWith('play'))).toEqual(['play mse', 'play https://cdn.example.com/a2.mp3']);
  });
  it('resolves a hub-relative URL against baseUrl, and says so when there is none', async () => {
    const urls: string[] = [];
    const p = createVegaSayPlayer({ baseUrl: 'http://127.0.0.1:8790/', fetch: async (u) => (urls.push(u), clip()()) });
    await run(p, line('/tts/a1.m4a')).done;
    // A protocol-relative URL keeps its host and takes the hub's scheme.
    await run(p, line('//cdn.example.com/a2.m4a')).done;
    expect(urls).toEqual(['http://127.0.0.1:8790/tts/a1.m4a', 'http://cdn.example.com/a2.m4a']);
    const bare = run(createVegaSayPlayer({ fetch: clip() }), line('/tts/a1.m4a'));
    await bare.done;
    expect(bare.seen[0]).toMatch(/needs baseUrl/);
  });
  it('stop() pauses, and the stopped line hears nothing more from the player', async () => {
    media.script = ['canplay', 'playing'];
    const p = createVegaSayPlayer({ fetch: clip() });
    const r = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await settle();
    expect(r.seen).toEqual(['playing']);
    (r.stop as () => void)();
    expect(media.log.at(-1)).toBe('pause');
    media.players[0]!.fire('ended');
    expect(r.seen).toEqual(['playing']);
  });
  it('a line stopped while its clip downloads never reaches the player', async () => {
    const slow = slowClip();
    const p = createVegaSayPlayer({ fetch: slow.fetch });
    const r = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await settle(20);
    (r.stop as () => void)();
    slow.arrive();
    await settle();
    expect(media.log.filter((e) => /^(addSourceBuffer|append|play)/.test(e))).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it('a line stopped during the MSE setup appends and plays nothing', async () => {
    const p = createVegaSayPlayer({ fetch: clip() });
    let stop: (() => void) | null = null;
    media.onSrcObject = (v) => {
      if (v) stop?.();
    };
    const r = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    stop = r.stop as () => void;
    await settle();
    expect(media.log.filter((e) => /^(append|play|endOfStream)/.test(e))).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it('a stopped line\'s late clip cannot replace or end the next line', async () => {
    const slow = slowClip();
    const urls: string[] = [];
    const p = createVegaSayPlayer({ fetch: async (u) => (urls.push(u), u.includes('a1') ? slow.fetch() : clip()()) });
    const a = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await settle(20);
    (a.stop as () => void)(); // barge-in, or a high-priority line
    media.script = ['canplay', 'playing'];
    const b = run(p, line('http://127.0.0.1:8790/tts/b1.m4a'));
    await settle(20);
    slow.arrive(); // A's download finishes while B plays
    await settle();
    expect(b.seen).toEqual(['playing']);
    expect(media.log.filter((e) => e === 'play mse')).toHaveLength(1);
    media.players[0]!.fire('ended');
    expect(b.seen).toEqual(['playing', 'ended']);
    expect(a.seen).toEqual([]);
  });

  it('a line superseded without a stop does not play when its download finishes', async () => {
    const slow = slowClip();
    const p = createVegaSayPlayer({ fetch: async (u) => (u.includes('a1') ? slow.fetch() : clip()()) });
    const a = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await settle(20);
    const b = run(p, line('http://127.0.0.1:8790/tts/b1.m4a'));
    await b.done;
    slow.arrive();
    await settle();
    expect(b.seen).toEqual(['playing', 'ended']);
    expect(a.seen).toEqual([]);
    expect(media.log.filter((e) => e.startsWith('append'))).toHaveLength(1);
  });

  it('a failed player start is not kept: the next line tries again', async () => {
    media.failInit = 1;
    const p = createVegaSayPlayer({ fetch: clip() });
    await p.warm(); // the transient failure happens here, at start-up
    const r = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await r.done;
    expect(r.seen).toEqual(['playing', 'ended']);
    expect(media.log.filter((e) => e === 'initialize')).toHaveLength(2);
  });

  it('a media error reaches the line, and one player serves every line', async () => {
    media.script = ['error'];
    const p = createVegaSayPlayer({ fetch: clip() });
    const first = run(p, line('http://127.0.0.1:8790/tts/a1.m4a'));
    await first.done;
    expect(first.seen[0]).toMatch(/^error: media error/);
    media.script = ['canplay', 'playing', 'ended'];
    await run(p, line('http://127.0.0.1:8790/tts/a2.m4a')).done;
    expect(media.players).toHaveLength(1);
    await p.dispose();
    expect(media.log).toContain('deinitialize');
  });
});

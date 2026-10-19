// `npm run example` (examples/loop) and the hub CLI (src/cli.ts).
import { describe, expect, it } from 'vitest';
import { parseHubArgs, startHubCli } from '../src/cli.js';
import { BridgeClient, type IntentMsg, type SayPayload } from '../src/index.js';
// @ts-expect-error plain-JS example without type declarations
import { runLoop } from '../examples/loop/loop.mjs';

describe('npm run example: the loop in one process', () => {
  it('every utterance gets a full hop timeline, the TV hears only the user, and every echo is dropped', async () => {
    const lines: string[] = [];
    const script = ['what should I do next', 'how long do I rest'];
    const out = (await runLoop({ script, log: (l: string) => lines.push(l) })) as {
      rows: Array<{ legs: Record<string, number | null>; speechEndToRender: number | null; sayToPlaying: number }>;
      dropped: Array<{ reason: string }>;
      heardOnTv: string[];
      shown: string[];
    };
    expect(out.heardOnTv).toEqual(script);
    expect(out.shown).toEqual(script);
    expect(out.dropped.map((d) => d.reason)).toEqual(['echo', 'echo']);
    for (const row of out.rows) {
      for (const v of Object.values(row.legs)) expect(v).not.toBeNull();
      expect(row.speechEndToRender).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.sayToPlaying)).toBe(true);
    }
    expect(lines.some((l) => l.includes('in-process, this machine'))).toBe(true);
    expect(lines.filter((l) => l.includes('speech.end -> screen.render'))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/echo guard: 2 of 2 replies/);
  }, 20_000);
});

describe('tv-voice-bridge-hub (CLI)', () => {
  it('parses its flags, with defaults', () => {
    expect(parseHubArgs([])).toMatchObject({ port: 8790, host: '0.0.0.0', path: '/ws', echo: false });
    expect(parseHubArgs([], { PORT: '9000' })).toMatchObject({ port: 9000 });
    expect(parseHubArgs(['--port', '8800', '--public-url', 'https://tv.example/', '--echo'])).toMatchObject({ port: 8800, publicUrl: 'https://tv.example', echo: true });
    expect(parseHubArgs(['-h'])).toBe('help');
    expect(() => parseHubArgs(['--port', 'x'])).toThrow(/--port/);
    expect(() => parseHubArgs(['--join-url', 'https://x/join'])).toThrow(/\{code\}/);
    expect(() => parseHubArgs(['--nope'])).toThrow();
  });

  it('starts a hub, prints the join URL, answers /healthz, and with --echo answers and speaks each final', async () => {
    const log: string[] = [];
    const app = await startHubCli({ ...(parseHubArgs(['--port', '0', '--host', '127.0.0.1', '--public-url', 'https://tv.example', '--echo']) as Exclude<ReturnType<typeof parseHubArgs>, 'help'>) }, (l) => log.push(l));
    try {
      expect(log[0]).toBe(`tv-voice-bridge hub on ws://127.0.0.1:${app.port}/ws`);
      expect(log[1]).toMatch(/^phones join at https:\/\/tv\.example\/p\/<CODE>/);
      const url = `ws://127.0.0.1:${app.port}/ws`;
      const tv = new BridgeClient({ url, role: 'screen', reconnect: false });
      const { code, joinUrl } = await tv.connect();
      expect(joinUrl).toBe(`https://tv.example/p/${code}`);
      expect(await (await fetch(`http://127.0.0.1:${app.port}/healthz`)).json()).toEqual({ ok: true, rooms: 1 });
      const phone = new BridgeClient({ url, role: 'mic', code, reconnect: false });
      await phone.connect();
      const intent = new Promise<IntentMsg>((r) => tv.on('intent', r));
      const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
      phone.sendFinal('hello there');
      expect((await intent).payload).toEqual({ text: 'hello there' });
      expect((await said).text).toBe('You said: hello there');
      expect(log).toContain(`room ${code}: TV joined; phones join at https://tv.example/p/${code}`);
      tv.close();
      phone.close();
    } finally {
      await app.close();
    }
  });

  it('a --join-url template replaces the whole URL', async () => {
    const app = await startHubCli({ port: 0, host: '127.0.0.1', path: '/ws', joinUrl: 'https://app.example/join/{code}?tv=1', echo: false, trustProxy: false, quiet: true }, () => undefined);
    try {
      const tv = new BridgeClient({ url: `ws://127.0.0.1:${app.port}/ws`, role: 'screen', reconnect: false });
      const { code, joinUrl } = await tv.connect();
      expect(joinUrl).toBe(`https://app.example/join/${code}?tv=1`);
      tv.close();
    } finally {
      await app.close();
    }
  });
});

// `npm run example` (examples/loop) and the hub CLI (src/cli.ts).
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseHubArgs, startHubCli } from '../src/cli.js';
import { forwardedClient } from '../src/hub.js';
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
    expect(parseHubArgs(['--trust-proxy', '--proxy', '10.0.0.2', '--proxy', '10.0.0.3', '--proxy-hops', '2'])).toMatchObject({ trustProxy: true, proxies: ['10.0.0.2', '10.0.0.3'], proxyHops: 2 });
    expect(() => parseHubArgs(['--proxy-hops', '0'])).toThrow(/--proxy-hops/);
  });

  it('forwardedClient keys on what the proxy appended, and reads the header only from a trusted proxy', () => {
    const req = (remoteAddress: string, xff?: string | string[]) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;
    // The first entry is whatever the client sent; the proxy appends the real address at the end.
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 203.0.113.7'))).toBe('203.0.113.7');
    expect(forwardedClient(req('::ffff:127.0.0.1', '203.0.113.7'))).toBe('203.0.113.7');
    expect(forwardedClient(req('::1', ['6.6.6.6', '203.0.113.7']))).toBe('203.0.113.7');
    // Not from a proxy: the header is the client's own claim.
    expect(forwardedClient(req('198.51.100.4', '203.0.113.7'))).toBe('198.51.100.4');
    expect(forwardedClient(req('10.0.0.2', '6.6.6.6, 203.0.113.7'), { proxies: ['10.0.0.2'] })).toBe('203.0.113.7');
    // Two proxies, each appending: the client is second from the end.
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.9'), { hops: 2 })).toBe('203.0.113.7');
    expect(forwardedClient(req('127.0.0.1', '203.0.113.7'), { hops: 2 })).toBe('127.0.0.1');
    expect(forwardedClient(req('127.0.0.1'))).toBe('127.0.0.1');
  });

  it('--trust-proxy: a client that varies its own X-Forwarded-For still hits the wrong-code limit', async () => {
    const app = await startHubCli({ port: 0, host: '127.0.0.1', path: '/ws', echo: false, trustProxy: true, quiet: true }, () => undefined);
    try {
      const url = `ws://127.0.0.1:${app.port}/ws`;
      const outcomes: string[] = [];
      for (let i = 0; i < 40; i++) {
        // As a tunnel forwards it: the client's own header, then the address the tunnel saw.
        const headers = { 'x-forwarded-for': `10.9.${i}.1, 203.0.113.7` };
        class Proxied extends WebSocket {
          constructor(u: string) {
            super(u, { headers });
          }
        }
        const phone = new BridgeClient({ url, role: 'mic', code: 'ZZZZ', reconnect: false, WebSocketImpl: Proxied as never });
        outcomes.push(await phone.connect().then(() => 'joined', (err: Error) => (/rate-limited|too many/.test(err.message) ? 'rate-limited' : 'unknown-code')));
        phone.close();
      }
      expect(outcomes.filter((o) => o === 'unknown-code')).toHaveLength(30);
      expect(outcomes.filter((o) => o === 'rate-limited')).toHaveLength(10);
    } finally {
      await app.close();
    }
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

  it('the join URL it prints opens a phone page, with its modules under /lib/ and nothing else', async () => {
    const app = await startHubCli({ port: 0, host: '127.0.0.1', path: '/ws', echo: false, trustProxy: false, quiet: true }, () => undefined);
    try {
      const base = `http://127.0.0.1:${app.port}`;
      const tv = new BridgeClient({ url: `ws://127.0.0.1:${app.port}/ws`, role: 'screen', reconnect: false });
      const { joinUrl } = await tv.connect();
      tv.close();
      const page = await fetch(joinUrl!);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(await page.text()).toContain('phone mic');
      for (const escape of ['/lib/..%2Fpackage.json', '/lib/%2e%2e/src/hub.ts', '/lib/..%2F..%2Fpackage.json', '/lib/', '/lib/index.d.ts'])
        expect((await fetch(`${base}${escape}`)).status).toBe(404);
      expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
      // The modules are the package's build (absent in a fresh clone until `npm run build`).
      if (existsSync(new URL('../dist/phone.js', import.meta.url))) {
        const lib = await fetch(`${base}/lib/phone.js`);
        expect(lib.status).toBe(200);
        expect(lib.headers.get('content-type')).toMatch(/javascript/);
      }
    } finally {
      await app.close();
    }
    const off = await startHubCli({ ...(parseHubArgs(['--port', '0', '--host', '127.0.0.1', '--no-phone', '--quiet']) as Exclude<ReturnType<typeof parseHubArgs>, 'help'>) }, () => undefined);
    try {
      expect((await fetch(`http://127.0.0.1:${off.port}/p/ABCD`)).status).toBe(404);
    } finally {
      await off.close();
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

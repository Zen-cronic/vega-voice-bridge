// `npm run example` (examples/loop) and the hub CLI (src/cli.ts).
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { isEntry, parseHubArgs, startHubCli } from '../src/cli.js';
import { forwardedClient } from '../src/hub.js';
import { BridgeClient, type IntentMsg, type SayPayload } from '../src/index.js';
import { connectPhone } from '../src/phone.js';
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
  afterEach(() => void vi.unstubAllGlobals());

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

  it('starts a hub only when it is the entry file itself, never when another cli.js imports it', () => {
    const self = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'tvb-entry-'));
    try {
      // A host app whose own entry happens to be called cli.js, or a bin of the same name elsewhere.
      writeFileSync(join(dir, 'cli.js'), '');
      writeFileSync(join(dir, 'tv-voice-bridge-hub'), '');
      expect(isEntry(join(dir, 'cli.js'), self)).toBe(false);
      expect(isEntry(join(dir, 'tv-voice-bridge-hub'), self)).toBe(false);
      expect(isEntry(undefined, self)).toBe(false);
      expect(isEntry(join(dir, 'missing.js'), self)).toBe(false);
      // Run directly, or through the bin link npm makes.
      expect(isEntry(self, self)).toBe(true);
      symlinkSync(self, join(dir, 'bin-link'));
      expect(isEntry(join(dir, 'bin-link'), self)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the phone page helpers are a public export, ./serve, not a deep import of the CLI', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as unknown as { exports: Record<string, { source?: string }> };
    expect(pkg.exports['./serve']?.source).toBe('./src/serve.ts');
    const serve = await import('../src/serve.js');
    expect(typeof serve.servePhonePage).toBe('function');
    expect(typeof serve.lanAddress).toBe('function');
    const example = await import('node:fs').then((fs) => fs.readFileSync(new URL('../examples/vega-voice-loop/hub.mjs', import.meta.url), 'utf8'));
    expect(example).toContain("from 'tv-voice-bridge/serve'");
    expect(example).not.toMatch(/dist\/cli\.js/);
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
    // Two proxies, each appending (a CDN in front of a local nginx): the client is second from the end, once the
    // CDN's address is known to be a proxy.
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.9'), { hops: 2, proxies: ['10.0.0.0/8'] })).toBe('203.0.113.7');
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.9'), { hops: 2, proxies: ['10.0.0.9'] })).toBe('203.0.113.7');
    expect(forwardedClient(req('127.0.0.1', '203.0.113.7'), { hops: 2 })).toBe('203.0.113.7');
    expect(forwardedClient(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 2001:db8::7, [2001:db9::1]:443'), { hops: 2, proxies: ['2001:db9::/32'] })).toBe('2001:db8::7');
  });

  it('forwardedClient with two proxies: a client that skips the outer one is keyed on its own address', () => {
    const req = (remoteAddress: string, xff: string) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;
    const o = { hops: 2, proxies: ['10.0.0.0/8'] };
    // Straight to nginx with a made-up header: nginx appends the real address, and that is not a CDN address.
    const keys = new Set(Array.from({ length: 20 }, (_, i) => forwardedClient(req('127.0.0.1', `10.9.${i}.1, 198.51.100.9`), o)));
    expect([...keys]).toEqual(['198.51.100.9']);
    // Not naming the CDN at all is the safe side: every CDN client shares the CDN's key, nobody picks their own.
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.9'), { hops: 2 })).toBe('10.0.0.9');
  });

  it('forwardedClient keys on the bare address: a port the proxy appended does not make a new key per connection', () => {
    const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;
    const v4 = new Set(Array.from({ length: 20 }, (_, i) => forwardedClient(req('127.0.0.1', `6.6.6.6, 203.0.113.7:${51544 + i}`))));
    expect([...v4]).toEqual(['203.0.113.7']);
    const v6 = new Set(Array.from({ length: 20 }, (_, i) => forwardedClient(req('127.0.0.1', `[2001:db8::7]:${443 + i}`))));
    expect([...v6]).toEqual(['2001:db8::7']);
    expect(forwardedClient(req('127.0.0.1', '6.6.6.6, 203.0.113.7:51544, 10.0.0.9:443'), { hops: 2, proxies: ['10.0.0.0/8'] })).toBe('203.0.113.7');
    // The socket fallbacks are bare too.
    expect(forwardedClient(req('::ffff:198.51.100.4', '203.0.113.7'))).toBe('198.51.100.4');
    expect(forwardedClient(req('::ffff:127.0.0.1'))).toBe('127.0.0.1');
  });

  it('a --proxy that is not an address or CIDR range is refused, not silently ignored', () => {
    expect(parseHubArgs(['--proxy', '203.0.113.0/24', '--proxy', '2001:db8::/32'])).toMatchObject({ proxies: ['203.0.113.0/24', '2001:db8::/32'] });
    for (const bad of ['proxy.local', '10.0.0.0/', '10.0.0.0/33', '10.0.0.0/8/1', '2001:db8::/129'])
      expect(() => parseHubArgs(['--proxy', bad]), bad).toThrow(/--proxy takes an address or a CIDR range/);
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

  it('with --path, the phone page it serves connects to that path, not /ws', async () => {
    expect(() => parseHubArgs(['--path', 'bridge'])).toThrow(/--path must start with \//);
    const app = await startHubCli({ ...(parseHubArgs(['--port', '0', '--host', '127.0.0.1', '--path', '/bridge', '--quiet']) as Exclude<ReturnType<typeof parseHubArgs>, 'help'>) }, () => undefined);
    const closers: Array<() => void> = [];
    try {
      const tv = new BridgeClient({ url: `ws://127.0.0.1:${app.port}/bridge`, role: 'screen', reconnect: false });
      closers.push(() => tv.close());
      const { code, joinUrl } = await tv.connect();
      const html = await (await fetch(joinUrl!)).text();
      const path = /<meta name="tv-voice-bridge-path" content="([^"]*)"/.exec(html)?.[1];
      expect(path).toBe('/bridge');
      // What the page does with it: connect on its own host at that path, with the code from its address.
      vi.stubGlobal('location', { protocol: 'http:', host: `127.0.0.1:${app.port}`, pathname: new URL(joinUrl!).pathname });
      const phone = connectPhone({ path, reconnect: false });
      closers.push(() => phone.close());
      expect(phone.code).toBe(code);
      await vi.waitFor(() => expect(phone.status).toBe('open'));
    } finally {
      closers.forEach((c) => c());
      await app.close();
    }
    // The path lands in an attribute, escaped.
    const odd = await startHubCli({ port: 0, host: '127.0.0.1', path: '/a"><script>x</script>', echo: false, trustProxy: false, quiet: true }, () => undefined);
    try {
      const html = await (await fetch(`http://127.0.0.1:${odd.port}/p/ABCD`)).text();
      expect(html).toContain('content="/a&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
      expect(html).not.toContain('<script>x');
    } finally {
      await odd.close();
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

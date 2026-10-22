/**
 * Hub robustness: regressions for every input that crashed the 0.1.0 hub process, plus room lifetime,
 * pairing limits, clientId binding, heartbeat and backpressure. Black-box over raw sockets where possible.
 * A crash path here surfaces as an unhandled error, which fails the vitest run.
 */
import { createServer, request, type Server } from 'node:http';
import net, { type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeHub, localOriginPolicy, rateKeyBucket, type HubOptions } from '../src/hub.js';
import { BridgeClient, FIELD_LIMITS, decode, type BridgeMessage } from '../src/index.js';

type Raw = { ws: WebSocket; send: (m: unknown) => void; next: (type?: string) => Promise<BridgeMessage>; closed: Promise<number>; inbox: BridgeMessage[] };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function start(opts: Partial<HubOptions> = {}) {
  const server: Server = createServer();
  const hub = new BridgeHub({ server, ...opts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => new Promise((r) => server.close(r)), () => hub.close());
  return { hub, server, port, url: `ws://127.0.0.1:${port}/ws` };
}

async function raw(url: string): Promise<Raw> {
  const ws = new WebSocket(url);
  cleanups.push(() => ws.terminate());
  const inbox: BridgeMessage[] = [];
  const waiters: Array<{ type?: string; fn: (m: BridgeMessage) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as BridgeMessage;
    const i = waiters.findIndex((w) => !w.type || w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.fn(m);
    else inbox.push(m);
  });
  ws.on('error', () => undefined);
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  await new Promise((r) => ws.once('open', r));
  return {
    ws,
    inbox,
    closed,
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: (type) =>
      new Promise((resolve) => {
        const i = inbox.findIndex((m) => !type || m.type === type);
        if (i >= 0) resolve(inbox.splice(i, 1)[0]!);
        else waiters.push({ type, fn: resolve });
      }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const underlying = (ws: WebSocket) => (ws as unknown as { _socket: Socket })._socket;

/** Same check as the scratch repros: a fresh socket still gets a pong. */
async function alive(url: string) {
  const s = await raw(url);
  s.send({ type: 'ping', t0: 3 });
  expect(await s.next('pong')).toMatchObject({ t0: 3 });
}

async function screen(url: string, clientId = 'tv', extra: Record<string, unknown> = {}) {
  const s = await raw(url);
  s.send({ type: 'hello', v: 1, role: 'screen', clientId, ...extra });
  const w = (await s.next('welcome')) as { code: string };
  return { ...s, code: w.code };
}

async function mic(url: string, code: string, clientId = 'mic', extra: Record<string, unknown> = {}) {
  const s = await raw(url);
  s.send({ type: 'hello', v: 1, role: 'mic', clientId, code, ...extra });
  return { ...s, first: await s.next() };
}

describe('crash regressions: each input below killed the 0.1.0 hub process', () => {
  it('C3: a hello with a non-string code, clientId or name gets bad-message; the hub keeps serving', async () => {
    const { url } = await start();
    const s = await raw(url);
    for (const bad of [
      { type: 'hello', v: 1, role: 'mic', clientId: 'x', code: 1234 },
      { type: 'hello', v: 1, role: 'screen', clientId: 'x', code: { a: 1 } },
      { type: 'hello', v: 1, role: 'screen', clientId: 42 },
      { type: 'hello', v: 1, role: 'screen', clientId: 'y', name: ['n'] },
    ]) {
      s.send(bad);
      expect(await s.next()).toMatchObject({ type: 'error', code: 'bad-message' });
    }
    await alive(url);
  });

  it('C4: an invalid UTF-8 text frame closes only that socket', async () => {
    const { url } = await start();
    const s = await raw(url);
    const payload = Buffer.from([0xff, 0xfe, 0xfd]);
    const mask = Buffer.from([1, 2, 3, 4]);
    underlying(s.ws).write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]));
    expect(await s.closed).toBeGreaterThan(0);
    await alive(url);
  });

  it('C4: a reserved opcode closes only that socket', async () => {
    const { url } = await start();
    const s = await raw(url);
    underlying(s.ws).write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await s.closed;
    await alive(url);
  });

  it('C4: a frame over maxMessageBytes closes only that socket (1009)', async () => {
    const { url } = await start({ limits: { maxMessageBytes: 4096 } });
    const s = await raw(url);
    s.send({ type: 'app', topic: 'x', payload: 'a'.repeat(8192) });
    expect(await s.closed).toBe(1009);
    await alive(url);
  });

  it('binary frames are refused with bad-message', async () => {
    const { url } = await start();
    const s = await raw(url);
    s.ws.send(Buffer.from('{"type":"ping","t0":1}'), { binary: true });
    expect(await s.next()).toMatchObject({ type: 'error', code: 'bad-message' });
  });

  it('H4: an upgrade whose request target breaks the URL parser is dropped; the hub keeps serving', async () => {
    const { url, port } = await start();
    const sock = net.connect(port, '127.0.0.1');
    cleanups.push(() => sock.destroy());
    sock.on('error', () => undefined);
    await new Promise((r) => sock.once('connect', r));
    const ended = new Promise((r) => sock.once('close', r));
    sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    await ended;
    await alive(url);
  });

  it('H5: app callbacks that throw (or reject with a non-Error) never escape; the room gets handler-failed', async () => {
    const boom = () => {
      throw new Error('app bug');
    };
    const { url, hub } = await start({
      joinUrl: boom,
      log: boom,
      onApp: boom,
      onJoin: async () => Promise.reject(new Error('async join bug')),
      onLeave: boom,
      onAck: boom,
      onRoomClose: boom,
      onFinal: () => Promise.reject(null),
      roomGraceMs: 20,
    });
    const tv = await screen(url);
    expect(tv.inbox.length + 1).toBeGreaterThan(0);
    const m = await mic(url, tv.code);
    expect(m.first).toMatchObject({ type: 'welcome' });
    tv.send({ type: 'app', topic: 'untracked', payload: 1 });
    m.send({ type: 'transcript.final', utteranceId: 'u1', text: 'hi', hops: [] });
    expect(await tv.next('error')).toMatchObject({ code: 'handler-failed', utteranceId: 'u1', message: 'handler failed' });
    tv.send({ type: 'ack', utteranceId: 'u1', stage: 'rendered', hops: [] });
    await m.next('ack');
    m.ws.close();
    tv.ws.close();
    await sleep(120); // onLeave and onRoomClose fire and throw
    expect(hub.stats.handlerErrors).toBeGreaterThanOrEqual(5);
    await alive(url);
  });

  it('M35: close() detaches from the HTTP server, so a new hub on the same server works', async () => {
    const { server, url, hub } = await start();
    hub.close();
    const second = new BridgeHub({ server });
    cleanups.push(() => second.close());
    await alive(url);
  });

  it('L21: a second hello on one socket moves it cleanly (no ghost peer)', async () => {
    const { url, hub } = await start();
    const a = await screen(url, 'tv_a');
    const b = await screen(url, 'tv_b');
    const s = await mic(url, a.code, 'roamer');
    s.send({ type: 'hello', v: 1, role: 'mic', clientId: 'roamer', code: b.code, name: 'moved' });
    await sleep(50);
    expect(hub.peersOf(hub.rooms.get(a.code)!).map((p) => p.clientId)).toEqual(['tv_a']);
    expect(hub.peersOf(hub.rooms.get(b.code)!)).toEqual([
      { clientId: 'tv_b', role: 'screen', name: undefined },
      { clientId: 'roamer', role: 'mic', name: 'moved' },
    ]);
  });
});

/** Raw upgrade offering `protocols`: the Sec-WebSocket-Protocol the hub answers with (undefined for none). */
function selected(port: number, protocols: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({
      port,
      host: '127.0.0.1',
      path: '/ws',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': protocols },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.headers['sec-websocket-protocol'] as string | undefined);
    });
    req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

describe('subprotocols', () => {
  // A synthetic credential, offered the way an app might carry a pair token.
  const token = 'k.c3ludGhldGljLXRva2Vu';

  it('the hub never answers with a subprotocol it was not told it may select', async () => {
    const { port } = await start();
    expect(await selected(port, `${token}, my-app`)).toBeUndefined();
    expect(await selected(port, token)).toBeUndefined();
    expect(await selected(port, 'my-app')).toBeUndefined();
  });

  it('with protocols, it selects the first listed one the client offers, in any order, and never the credential', async () => {
    const { port, url } = await start({ protocols: ['my-app'] });
    expect(await selected(port, `my-app, ${token}`)).toBe('my-app');
    expect(await selected(port, `${token}, my-app`)).toBe('my-app');
    expect(await selected(port, token)).toBeUndefined();
    // A real client that offers it gets a working connection with that protocol.
    const ws = new WebSocket(url, [token, 'my-app']);
    cleanups.push(() => ws.terminate());
    await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
    expect(ws.protocol).toBe('my-app');
  });
});

describe('handler-failed tells the room that the handler failed, not why', () => {
  it('a 3,000-character exception reaches the room as a generic, decodable handler-failed; the text goes only to the log', async () => {
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const secret = `prompt: ${'x'.repeat(3000)}`;
    const { url } = await start({
      log: (event, data) => logs.push({ event, data }),
      onFinal: () => {
        throw new Error(secret);
      },
    });
    const tv = await screen(url);
    const m = await mic(url, tv.code);
    // A real client too: it refuses frames whose fields break the protocol's limits, so an uncapped message never arrives.
    const client = new BridgeClient({ url, role: 'mic', code: tv.code, reconnect: false, WebSocketImpl: WebSocket as never });
    cleanups.push(() => client.close());
    await client.connect();
    const decoded = new Promise<BridgeMessage>((r) => client.on('error', (e) => r(e)));
    m.send({ type: 'transcript.final', utteranceId: 'u1', text: 'hi', hops: [] });
    const expected = { type: 'error', code: 'handler-failed', message: 'handler failed', utteranceId: 'u1' };
    expect(await tv.next('error')).toEqual(expected);
    expect(await m.next('error')).toEqual(expected);
    expect(await Promise.race([decoded, sleep(1000).then(() => 'never arrived')])).toEqual(expected);
    expect(logs.find((l) => l.event === 'handler-failed')?.data).toMatchObject({ handler: 'dispatch', error: secret, code: tv.code, utteranceId: 'u1' });
  });

  it('exposeHandlerErrors sends the exception text, capped at the protocol limit so clients still decode it', async () => {
    const texts = ['parser exploded', 'y'.repeat(3000)];
    const { url } = await start({
      exposeHandlerErrors: true,
      onFinal: (_room, msg) => {
        throw new Error(texts[Number(msg.utteranceId.slice(1))]);
      },
    });
    const tv = await screen(url);
    const m = await mic(url, tv.code);
    m.send({ type: 'transcript.final', utteranceId: 'u0', text: 'hi', hops: [] });
    expect(await tv.next('error')).toMatchObject({ code: 'handler-failed', utteranceId: 'u0', message: 'parser exploded' });
    m.send({ type: 'transcript.final', utteranceId: 'u1', text: 'hi', hops: [] });
    const long = (await tv.next('error')) as { message: string };
    expect(long.message.length).toBe(FIELD_LIMITS.errorMessage);
    expect(long.message.startsWith('yyyy')).toBe(true);
    expect(decode(JSON.stringify(long))).not.toBeNull();
  });
});

describe('handler failures are reported once', () => {
  it('a rejected untracked onApp is one handler-failed log, never also message-failed', async () => {
    const logs: string[] = [];
    const { url, hub } = await start({ log: (event) => logs.push(event), onApp: async () => Promise.reject(new Error('app bug')) });
    const tv = await screen(url);
    tv.send({ type: 'app', topic: 'untracked', payload: 1 });
    await sleep(60);
    expect(logs.filter((e) => e === 'handler-failed')).toHaveLength(1);
    expect(logs).not.toContain('message-failed');
    expect(hub.stats.handlerErrors).toBe(1);
    tv.ws.close();
  });
});

describe('rooms and pairing limits', () => {
  it('H24: a room closes once its last screen has been gone for roomGraceMs; its mics are told and disconnected', async () => {
    const closedRooms: string[] = [];
    const { url, hub } = await start({ roomGraceMs: 80, onRoomClose: (r, why) => closedRooms.push(`${r.code}:${why}`) });
    const tv = await screen(url);
    const m = await mic(url, tv.code);
    tv.ws.close();
    await sleep(20);
    const rejoin = await mic(url, tv.code, 'mic_2'); // inside the grace period (a TV reload)
    expect(rejoin.first).toMatchObject({ type: 'welcome' });
    expect(await m.next('error')).toMatchObject({ code: 'unknown-code' });
    expect(await m.closed).toBe(4404);
    expect(hub.rooms.has(tv.code)).toBe(false);
    expect(closedRooms).toEqual([`${tv.code}:expired`]);
    expect((await mic(url, tv.code, 'mic_3')).first).toMatchObject({ type: 'error', code: 'unknown-code' });
  });

  it('H24: a screen that comes back inside the grace period keeps the room', async () => {
    const { url, hub } = await start({ roomGraceMs: 100 });
    const tv = await screen(url);
    tv.ws.close();
    await sleep(30);
    await screen(url, 'tv_reloaded', { code: tv.code });
    await sleep(150);
    expect(hub.rooms.has(tv.code)).toBe(true);
  });

  it('H24: maxRooms caps room creation with `full` (no unbounded growth, no spin on a full code space)', async () => {
    const { url } = await start({ limits: { maxRooms: 2 } });
    await screen(url, 'a');
    await screen(url, 'b');
    const c = await raw(url);
    c.send({ type: 'hello', v: 1, role: 'screen', clientId: 'c' });
    expect(await c.next()).toMatchObject({ type: 'error', code: 'full' });
  });

  it('M34: a screen with an invalid code gets a fresh unique code, never another live room', async () => {
    const seq = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const { url, hub } = await start({ random: () => seq[i++] ?? 0.9 });
    const first = await screen(url, 'tv_1');
    expect(first.code).toBe('AAAA');
    const second = await screen(url, 'tv_2', { code: 'AB0C' }); // "0" is not in the alphabet; the next draw collides with AAAA
    expect(second.code).toBe('SSSS');
    expect(hub.peersOf(hub.rooms.get('AAAA')!).map((p) => p.clientId)).toEqual(['tv_1']);
  });

  it('pairing brute force via the screen role: explicit codes that miss share the wrong-code budget', async () => {
    const { url, hub } = await start({ limits: { codeMissesPerMinute: 2 } });
    const live = await screen(url, 'tv_live');
    await screen(url, 'probe_1', { code: 'ZZZZ' }); // a miss: creates ZZZZ (as a resume would)
    expect((await mic(url, 'YYYY', 'probe_2')).first).toMatchObject({ type: 'error', code: 'unknown-code' }); // a mic miss
    const probe = await raw(url);
    probe.send({ type: 'hello', v: 1, role: 'screen', clientId: 'probe_3', code: 'XXXX' });
    expect(await probe.next()).toMatchObject({ type: 'error', code: 'rate-limited' });
    expect(hub.rooms.has('XXXX')).toBe(false);
    const rejoin = await raw(url); // joining a live room by its code is not a miss, but the budget is spent for this key
    rejoin.send({ type: 'hello', v: 1, role: 'screen', clientId: 'tv_second', code: live.code });
    expect(await rejoin.next('welcome')).toMatchObject({ code: live.code });
  });

  it('pairing brute force: after codeMissesPerMinute wrong codes, mic hellos from that key are refused', async () => {
    const { url } = await start({ limits: { codeMissesPerMinute: 3 } });
    const tv = await screen(url);
    for (const guess of ['ZZZZ', 'YYYY', 'XXXX']) expect((await mic(url, guess)).first).toMatchObject({ type: 'error', code: 'unknown-code' });
    const blocked = await mic(url, tv.code);
    expect(blocked.first).toMatchObject({ type: 'error', code: 'rate-limited' });
    expect((blocked.first as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('pairing brute force from many addresses: past hubCodeMisses wrong codes hub-wide, pairing pauses for every code, the right one too', async () => {
    let n = 0;
    const logs: string[] = [];
    // Every connection gets its own rate key, as guesses spread over many addresses (or one IPv6 /48) would.
    const { url, hub } = await start({ rateKey: () => `addr-${n++}`, limits: { hubCodeMisses: 3, hubCodeMissWindowMs: 300 }, log: (e) => logs.push(e) });
    const tv = await screen(url);
    for (const guess of ['ZZZZ', 'YYYY', 'XXXX']) expect((await mic(url, guess)).first).toMatchObject({ type: 'error', code: 'unknown-code' });
    // A guess now learns nothing: the live code is refused like any other, by mics and by screens naming it.
    const right = (await mic(url, tv.code)).first as { code: string; retryAfterMs: number };
    expect(right).toMatchObject({ type: 'error', code: 'rate-limited' });
    expect(right.retryAfterMs).toBeGreaterThan(0);
    expect(right.retryAfterMs).toBeLessThanOrEqual(300);
    const probe = await raw(url);
    probe.send({ type: 'hello', v: 1, role: 'screen', clientId: 'probe', code: tv.code });
    expect(await probe.next()).toMatchObject({ type: 'error', code: 'rate-limited' });
    expect(hub.rooms.get(tv.code)!.peers.size).toBe(1);
    // A TV asking for a fresh code still gets one; the paired room is untouched.
    expect((await screen(url, 'new_tv')).code).toMatch(/^[A-Z2-9]{4}$/);
    expect(hub.stats.pairingPauses).toBe(1);
    expect(logs.filter((e) => e === 'pairing-paused')).toHaveLength(1);
    // The pause ends with the window.
    await sleep(320);
    expect((await mic(url, tv.code, 'mic_late')).first).toMatchObject({ type: 'welcome', code: tv.code });
  });

  it('M55: during a pairing pause, a paired TV and phone whose sockets dropped resume into their own room; strangers stay out', async () => {
    let n = 0;
    const { url, hub } = await start({ rateKey: () => `addr-${n++}`, limits: { hubCodeMisses: 3, hubCodeMissWindowMs: 5_000 } });
    const tv = await screen(url, 'tv', { resumeToken: 'tv-secret' });
    const phone = await mic(url, tv.code, 'phone', { resumeToken: 'phone-secret' });
    expect(phone.first).toMatchObject({ type: 'welcome' });
    for (const guess of ['ZZZZ', 'YYYY', 'XXXX']) expect((await mic(url, guess)).first).toMatchObject({ code: 'unknown-code' });
    expect(hub.stats.pairingPauses).toBe(1);
    // A Wi-Fi blip: both sockets drop, and both come back with their code, clientId and resume token.
    tv.ws.terminate();
    phone.ws.terminate();
    await sleep(30);
    expect(hub.rooms.has(tv.code)).toBe(true);
    const tvBack = await screen(url, 'tv', { code: tv.code, resumeToken: 'tv-secret' });
    expect(tvBack.code).toBe(tv.code);
    expect((await mic(url, tv.code, 'phone', { resumeToken: 'phone-secret' })).first).toMatchObject({ type: 'welcome', code: tv.code });
    // Still paused for everyone else: a new phone, a known clientId with the wrong token, a token in the wrong role.
    for (const [id, extra] of [
      ['stranger', {}],
      ['phone', { resumeToken: 'guess' }],
      ['phone', {}],
    ] as const)
      expect((await mic(url, tv.code, id, extra)).first, id).toMatchObject({ code: 'rate-limited' });
    const asScreen = await raw(url);
    asScreen.send({ type: 'hello', v: 1, role: 'screen', clientId: 'phone', code: tv.code, resumeToken: 'phone-secret' });
    expect(await asScreen.next()).toMatchObject({ code: 'rate-limited' });
  });

  it('M55: one rate key counts for at most a tenth of the hub-wide budget, so one address cannot pause pairing for everyone', async () => {
    const { url, hub } = await start({ limits: { codeMissesPerMinute: 1_000, hubCodeMisses: 20 } });
    const tv = await screen(url);
    for (let i = 0; i < 40; i++) expect((await mic(url, '0000')).first).toMatchObject({ code: 'unknown-code' });
    expect(hub.stats.pairingPauses).toBe(0);
    expect((await mic(url, tv.code, 'neighbour_phone')).first).toMatchObject({ type: 'welcome' });
  });

  it('L157: the share is a tenth of each hub-wide window, so misses on both sides of a window end do not add up past it', async () => {
    // The budgets run on performance.now(); faking only that clock places each miss exactly, and sockets stay real.
    vi.useFakeTimers({ toFake: ['performance'] });
    cleanups.push(() => vi.useRealTimers());
    let key = 'tv';
    const { url, hub } = await start({ rateKey: () => key, limits: { codeMissesPerMinute: 1_000, hubCodeMisses: 11, hubCodeMissWindowMs: 1_000 } });
    const tv = await screen(url);
    const missFrom = async (k: string) => {
      key = k;
      expect((await mic(url, '0000', `guess_${k}`)).first).toMatchObject({ code: 'unknown-code' });
    };
    // A share is ceil(11 / 10) = 2. A opens a hub-wide window at 0 ms; K's first miss is at 600 ms.
    await missFrom('A');
    vi.advanceTimersByTime(600);
    await missFrom('K');
    vi.advanceTimersByTime(500); // 1,100 ms: a new hub-wide window
    await missFrom('K');
    vi.advanceTimersByTime(600); // 1,700 ms: past a window that started with K's first miss
    await missFrom('K');
    await missFrom('K');
    // Four more keys at their full share: 8 misses, 10 in this window with K's 2, one short of the budget.
    for (const k of ['B', 'C', 'D', 'E']) for (let i = 0; i < 2; i++) await missFrom(k);
    expect(hub.stats.pairingPauses).toBe(0);
    key = 'neighbour';
    expect((await mic(url, tv.code, 'neighbour_phone')).first).toMatchObject({ type: 'welcome' });
    // The eleventh counted miss, from one more key, does pause pairing.
    await missFrom('F');
    expect(hub.stats.pairingPauses).toBe(1);
  });

  it('IPv6 clients are keyed on their /64: addresses inside one share the wrong-code budget', async () => {
    let n = 1;
    // One host can use any address in its /64 (privacy addresses, or a whole delegated prefix).
    const { url } = await start({ rateKey: () => `2001:db8:1:2::${(n++).toString(16)}`, limits: { codeMissesPerMinute: 2 } });
    const tv = await screen(url);
    for (const guess of ['ZZZZ', 'YYYY']) expect((await mic(url, guess)).first).toMatchObject({ code: 'unknown-code' });
    expect((await mic(url, tv.code)).first).toMatchObject({ code: 'rate-limited' });
    // ipv6RateKeyPrefix: 128 keys each address on its own.
    let m = 1;
    const own = await start({ rateKey: () => `2001:db8:1:2::${(m++).toString(16)}`, ipv6RateKeyPrefix: 128, limits: { codeMissesPerMinute: 2 } });
    const tv2 = await screen(own.url);
    for (const guess of ['ZZZZ', 'YYYY']) expect((await mic(own.url, guess)).first).toMatchObject({ code: 'unknown-code' });
    expect((await mic(own.url, tv2.code)).first).toMatchObject({ type: 'welcome' });
  });

  it('rateKeyBucket: an IPv6 address becomes its network, IPv4 stays the bare address, other keys pass through', () => {
    expect(rateKeyBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(rateKeyBucket('2001:DB8:1:2::7')).toBe('2001:db8:1:2::/64');
    expect(rateKeyBucket('[2001:db8:1:2::7]:443')).toBe('2001:db8:1:2::/64');
    expect(rateKeyBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateKeyBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(rateKeyBucket('2001:db8:1:2::7', 48)).toBe('2001:db8:1::/48');
    expect(rateKeyBucket('2001:db8:1:2ff::7', 56)).toBe('2001:db8:1:200::/56');
    expect(rateKeyBucket('2001:db8:1:2::7', 128)).toBe('2001:db8:1:2::7');
    expect(rateKeyBucket('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateKeyBucket('::ffff:cb00:7107')).toBe('203.0.113.7'); // the same mapped address, written in hex
    expect(rateKeyBucket('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
    expect(rateKeyBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(rateKeyBucket('203.0.113.7:51544')).toBe('203.0.113.7');
    expect(rateKeyBucket('client-7')).toBe('client-7');
    expect(rateKeyBucket('unknown')).toBe('unknown');
  });

  it('hubCodeMisses: 0 turns the hub-wide budget off', async () => {
    let n = 0;
    const { url, hub } = await start({ rateKey: () => `addr-${n++}`, limits: { hubCodeMisses: 0 } });
    const tv = await screen(url);
    for (let i = 0; i < 120; i++) expect((await mic(url, '0000')).first).toMatchObject({ code: 'unknown-code' }); // past the default of 100
    expect((await mic(url, tv.code)).first).toMatchObject({ type: 'welcome' });
    expect(hub.stats.pairingPauses).toBe(0);
  });

  it('hellosPerMinute limits hellos per rate key; rateKey can split clients behind one proxy', async () => {
    const { url } = await start({ limits: { hellosPerMinute: 2 } });
    await screen(url, 'a');
    await screen(url, 'b');
    const c = await raw(url);
    c.send({ type: 'hello', v: 1, role: 'screen', clientId: 'c' });
    expect(await c.next()).toMatchObject({ type: 'error', code: 'rate-limited' });

    let n = 0;
    const split = await start({ limits: { hellosPerMinute: 1 }, rateKey: () => `client-${n++}` });
    await screen(split.url, 'a');
    await screen(split.url, 'b');
  });

  it('maxPeersPerRoom: a hello beyond it gets `full`', async () => {
    const { url } = await start({ limits: { maxPeersPerRoom: 2 } });
    const tv = await screen(url);
    expect((await mic(url, tv.code, 'm1')).first).toMatchObject({ type: 'welcome' });
    expect((await mic(url, tv.code, 'm2')).first).toMatchObject({ type: 'error', code: 'full' });
  });

  it('H23: a holder that no longer answers pings is replaced after conflictProbeMs', async () => {
    const { url, hub } = await start({ conflictProbeMs: 60, heartbeatMs: 0 });
    const dead = await screen(url, 'tv_x', { resumeToken: 'old-secret' });
    dead.ws.pause(); // stops reading: no pongs
    const fresh = await raw(url);
    fresh.send({ type: 'hello', v: 1, role: 'screen', clientId: 'tv_x', code: dead.code, resumeToken: 'new-secret' });
    expect(await fresh.next('welcome')).toMatchObject({ code: dead.code });
    expect(hub.peersOf(hub.rooms.get(dead.code)!)).toHaveLength(1);
  });
});

describe('liveness and backpressure', () => {
  it('M37: a socket that stops answering pings is terminated and leaves the room', async () => {
    const left: string[] = [];
    const { url, hub } = await start({ heartbeatMs: 40, onLeave: (_r, p) => left.push(p.clientId) });
    const tv = await screen(url);
    const ghost = await mic(url, tv.code, 'sleeping_phone');
    ghost.ws.pause();
    for (let i = 0; i < 50 && !left.length; i++) await sleep(20);
    expect(left).toEqual(['sleeping_phone']);
    expect(hub.stats.heartbeatTimeouts).toBe(1);
    expect(hub.peersOf(hub.rooms.get(tv.code)!).map((p) => p.clientId)).toEqual(['tv']);
  });

  it('a healthy socket survives many heartbeat rounds', async () => {
    const { url, hub } = await start({ heartbeatMs: 20 });
    const tv = await screen(url);
    await sleep(200);
    expect(hub.rooms.get(tv.code)!.peers.size).toBe(1);
    expect(hub.stats.heartbeatTimeouts).toBe(0);
  });

  it('messagesPerSecond: a flood is dropped, with one rate-limited error per second', async () => {
    const { url, hub } = await start({ limits: { messagesPerSecond: 5 } });
    const s = await raw(url);
    for (let i = 0; i < 30; i++) s.send({ type: 'ping', t0: i });
    await sleep(100);
    const pongs = s.inbox.filter((m) => m.type === 'pong').length;
    const limited = s.inbox.filter((m) => m.type === 'error' && m.code === 'rate-limited').length;
    expect(pongs).toBeLessThanOrEqual(11);
    expect(limited).toBe(1);
    expect(hub.stats.rateLimited).toBe(1);
  });

  it('backpressure: above maxBufferedBytes, captions and untracked frames to a slow peer are dropped; say lines are not', async () => {
    const { url, hub } = await start({ limits: { maxBufferedBytes: 64 * 1024, maxBufferedBytesHard: 1024 * 1024 * 1024 } });
    const tv = await screen(url);
    tv.ws.pause();
    const room = hub.rooms.get(tv.code)!;
    const peer = room.peers.get('tv')!;
    const blob = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 400; i++) hub.broadcast(room, { type: 'app', topic: 'meter', payload: blob });
    expect(hub.stats.backpressureDrops).toBeGreaterThan(0);
    expect(peer.socket.bufferedAmount).toBeLessThan(64 * 1024 + 64 * 1024);
    const before = peer.socket.bufferedAmount;
    hub.say(room, { id: 's1', text: 'still said' });
    expect(peer.socket.bufferedAmount).toBeGreaterThan(before);
  });

  it('backpressure: above maxBufferedBytesHard the peer is disconnected', async () => {
    const left: string[] = [];
    const { url, hub } = await start({ limits: { maxBufferedBytes: 16 * 1024, maxBufferedBytesHard: 256 * 1024 }, onLeave: (_r, p) => left.push(p.clientId) });
    const tv = await screen(url);
    tv.ws.pause();
    const room = hub.rooms.get(tv.code)!;
    const blob = 'x'.repeat(32 * 1024);
    // Loopback kernel buffers absorb a few MiB first; keep sending until the hub's own buffer passes the cap.
    for (let i = 0; i < 2000 && !hub.stats.backpressureCloses; i++) hub.broadcast(room, { type: 'intent', utteranceId: `u${i}`, name: 'n', ok: true, payload: blob, hops: [] });
    expect(hub.stats.backpressureCloses).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 50 && !left.length; i++) await sleep(10);
    expect(left).toEqual(['tv']);
  });
});

/** Open a socket with this Origin header (or none); resolves 'open' or the HTTP status of a refused upgrade. */
function upgradeWith(url: string, origin?: string, host?: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.origin = origin;
    if (host !== undefined) headers.host = host;
    const ws = new WebSocket(url, { headers });
    cleanups.push(() => ws.terminate());
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => undefined);
  });
}

describe('allowedOrigins: which web pages may connect', () => {
  it('by default any Origin connects (unchanged); the join log records the Origin a peer connected with', async () => {
    const joins: Array<Record<string, unknown> | undefined> = [];
    const { url, hub } = await start({ log: (event, data) => event === 'join' && joins.push(data) });
    expect(await upgradeWith(url, 'https://evil.example')).toBe('open');
    expect(hub.stats.originRefused).toBe(0);
    const ws = new WebSocket(url, { headers: { origin: 'https://tv.example' } });
    cleanups.push(() => ws.terminate());
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello', v: 1, role: 'screen', clientId: 'tv_o' }));
    await screen(url, 'tv_native');
    await sleep(30);
    expect(joins.map((j) => [j?.clientId, j?.origin])).toEqual([
      ['tv_o', 'https://tv.example'],
      ['tv_native', undefined],
    ]);
  });

  it('a list admits exactly those origins, refuses others with 403, and never refuses a client that sends no Origin', async () => {
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const { url, hub } = await start({ allowedOrigins: ['https://app.example', 'http://192.168.1.20:8790'], log: (event, data) => logs.push({ event, data }) });
    expect(await upgradeWith(url, 'https://app.example')).toBe('open');
    expect(await upgradeWith(url, 'HTTPS://APP.EXAMPLE')).toBe('open'); // compared as browsers serialize it
    expect(await upgradeWith(url, 'http://192.168.1.20:8790')).toBe('open');
    expect(await upgradeWith(url)).toBe('open'); // Node, curl
    for (const bad of ['https://evil.example', 'https://app.example.evil.example', 'http://app.example', 'null', 'not an origin', 'http://192.168.1.20:8791'])
      expect(await upgradeWith(url, bad), bad).toBe(403);
    expect(hub.stats.originRefused).toBe(6);
    expect(logs.filter((l) => l.event === 'origin-refused').map((l) => l.data?.origin)).toContain('https://evil.example');
    await alive(url);
  });

  it('a function decides; one that throws refuses (the safe side) and the hub keeps serving', async () => {
    const { url } = await start({ allowedOrigins: (origin) => origin.endsWith('.example') });
    expect(await upgradeWith(url, 'https://tv.example')).toBe('open');
    expect(await upgradeWith(url, 'https://tv.invalid')).toBe(403);
    const throwing = await start({
      allowedOrigins: () => {
        throw new Error('policy bug');
      },
    });
    expect(await upgradeWith(throwing.url, 'https://tv.example')).toBe(403);
    await alive(throwing.url);
  });

  it('a list entry that is not an http(s) origin throws when the hub is built, so a typo does not admit nothing', () => {
    const server = createServer();
    for (const bad of ['app.example', 'ftp://app.example', 'https://app.example/path'])
      expect(() => new BridgeHub({ server, allowedOrigins: [bad] }), bad).toThrow(/not an http\(s\) origin/);
  });

  it('localOriginPolicy: pages this hub served (same host, by address or a local name), plus the listed origins; never a public name (DNS rebinding)', () => {
    const req = (host: string) => ({ headers: { host } }) as unknown as import('node:http').IncomingMessage;
    const policy = localOriginPolicy(['https://tv.example']);
    expect(policy('http://192.168.1.20:8790', req('192.168.1.20:8790'))).toBe(true);
    expect(policy('http://127.0.0.1:8790', req('127.0.0.1:8790'))).toBe(true);
    expect(policy('http://localhost:8790', req('localhost:8790'))).toBe(true);
    expect(policy('http://[::1]:8790', req('[::1]:8790'))).toBe(true);
    expect(policy('http://[fd00::7]:8790', req('[fd00::7]:8790'))).toBe(true);
    expect(policy('https://livingroom.local', req('livingroom.local'))).toBe(true);
    expect(policy('https://tv.example', req('127.0.0.1:8790'))).toBe(true); // listed
    expect(policy('http://evil.example', req('192.168.1.20:8790'))).toBe(false); // another site
    expect(policy('http://192.168.1.20:9999', req('192.168.1.20:8790'))).toBe(false); // another port
    expect(policy('http://rebind.evil.example:8790', req('rebind.evil.example:8790'))).toBe(false); // a public name that resolves here
    expect(policy('http://203.0.113.7:8790', req('203.0.113.7:8790'))).toBe(true); // an address literal cannot be rebound
    expect(policy('http://192.168.1.20', req('192.168.1.20:80'))).toBe(true); // the default port, written or not
    expect(policy('null', req('192.168.1.20:8790'))).toBe(false);
  });
});

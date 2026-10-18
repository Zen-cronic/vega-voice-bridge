/**
 * Client resilience: reconnect that keeps going (backoff + jitter), recovery after a hub restart, re-pair,
 * a heartbeat that detects dead links when onclose never fires, split-frame reassembly, and timer hygiene.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeHub } from '../src/hub.js';
import { BridgeClient, MessageAssembler, backoffDelay, type ClientOptions, type IntentMsg } from '../src/index.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const localNow = () => performance.timeOrigin + performance.now();
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/** A scripted WebSocket. `close()` does NOT fire onclose: that is the Vega failure mode the heartbeat exists for. */
function fakeSockets() {
  const all: FakeWS[] = [];
  class FakeWS {
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    closed = false;
    onopen: ((ev: unknown) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(readonly url: string) {
      all.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    deliver(data: string | object) {
      this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    send(d: string) {
      this.sent.push(JSON.parse(d) as Record<string, unknown>);
    }
    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }
  return { all, FakeWS };
}

const welcome = (over: Record<string, unknown> = {}) => ({ type: 'welcome', v: 1, clientId: 'c', role: 'screen', code: 'K7QF', peers: [], serverTime: localNow(), ...over });

function fakeClient(o: Partial<ClientOptions> = {}) {
  const { all, FakeWS } = fakeSockets();
  const c = new BridgeClient({ url: 'ws://fake/ws', role: 'screen', WebSocketImpl: FakeWS, clockSamples: 0, heartbeatMs: 0, ...o });
  cleanups.push(() => c.close());
  return { c, all };
}

describe('backoff', () => {
  it('doubles from minDelayMs to maxDelayMs, with the jitter share randomized', () => {
    const o = { minDelayMs: 100, maxDelayMs: 1000, jitter: 0 };
    expect([0, 1, 2, 3, 4, 10].map((a) => backoffDelay(a, o))).toEqual([100, 200, 400, 800, 1000, 1000]);
    expect(backoffDelay(3, { ...o, jitter: 0.5 }, () => 0)).toBe(400);
    expect(backoffDelay(3, { ...o, jitter: 0.5 }, () => 0.999)).toBe(800);
    expect(backoffDelay(3, { ...o, jitter: 1 }, () => 0)).toBe(0);
  });
});

describe('split-message reassembly', () => {
  it('MessageAssembler: one message split across frames, several in one frame, and junk', () => {
    const a = new MessageAssembler();
    const msg = JSON.stringify({ type: 'app', topic: 'state', payload: { text: 'brace } and quote \\" inside', n: [1, { x: 2 }] } });
    expect(a.push(msg.slice(0, 10)).messages).toEqual([]);
    expect(a.push(msg.slice(10, 30)).messages).toEqual([]);
    expect(a.push(msg.slice(30)).messages).toEqual([JSON.parse(msg)]);
    expect(a.pendingLength).toBe(0);
    const two = a.push('{"type":"ping","t0":1}\n{"type":"ping","t0":2}');
    expect(two.messages).toEqual([{ type: 'ping', t0: 1 }, { type: 'ping', t0: 2 }]);
    expect(a.push('garbage').rejected).toHaveLength(1);
    expect(a.push('{"type":"ping","t0":"x"}').rejected[0]).toMatch(/t0/);
  });

  it('MessageAssembler: a lost fragment does not swallow the next whole message; stale and oversized partials are dropped', () => {
    let t = 0;
    const a = new MessageAssembler({ maxBytes: 64, staleMs: 100, now: () => t });
    a.push('{"type":"app","topic":"x","payload":');
    const r = a.push('{"type":"ping","t0":5}');
    expect(r.messages).toEqual([{ type: 'ping', t0: 5 }]);
    expect(r.rejected).toEqual(['incomplete message dropped']);
    a.push('{"type":"ping",');
    t = 500;
    expect(a.push('"t0":6}')).toMatchObject({ messages: [], rejected: ['stale partial message dropped', 'text outside a JSON object'] });
    expect(a.push(`{"type":"app","topic":"${'y'.repeat(80)}`).rejected[0]).toMatch(/larger than 64/);
    expect(a.pendingLength).toBe(0);
  });

  it('the client reassembles a welcome split across three onmessage events', async () => {
    const { c, all } = fakeClient();
    const p = c.connect();
    all[0]!.open();
    expect(all[0]!.sent[0]).toMatchObject({ type: 'hello', role: 'screen', resumeToken: c.resumeToken });
    const w = JSON.stringify(welcome());
    all[0]!.deliver(w.slice(0, 7));
    all[0]!.deliver(w.slice(7, 40));
    all[0]!.deliver(w.slice(40));
    expect((await p).code).toBe('K7QF');
    const got: string[] = [];
    c.on('app', (m) => got.push(m.topic));
    all[0]!.deliver('{"type":"app","topic":"a","payload":1}{"type":"app","topic":"b","payload":2}');
    expect(got).toEqual(['a', 'b']);
  });
});

describe('dead links and timers', () => {
  it('M37: the heartbeat drops a silent link even though onclose never fires, then reconnects', async () => {
    const { c, all } = fakeClient({ heartbeatMs: 20, heartbeatTimeoutMs: 70, reconnect: { minDelayMs: 10, jitter: 0 } });
    let closes = 0;
    c.on('close', () => closes++);
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver(welcome());
    await p;
    await until(() => all[0]!.sent.some((m) => m.type === 'ping'));
    await until(() => all.length === 2);
    expect(all[0]!.closed).toBe(true);
    expect(closes).toBe(1);
    expect(c.connected).toBe(false);
    all[1]!.open();
    all[1]!.deliver(welcome());
    await until(() => c.connected);
  });

  it('a link that keeps answering pings stays up', async () => {
    const { c, all } = fakeClient({ heartbeatMs: 15, heartbeatTimeoutMs: 50 });
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver(welcome());
    await p;
    const answer = setInterval(() => all[0]!.deliver({ type: 'pong', t0: localNow(), serverTime: localNow() }), 10);
    await sleep(200);
    clearInterval(answer);
    expect(all).toHaveLength(1);
    expect(c.connected).toBe(true);
  });

  it('a connect that never opens times out, rejects, and retries', async () => {
    const { c, all } = fakeClient({ connectTimeoutMs: 40, reconnect: { minDelayMs: 10, jitter: 0 } });
    await expect(c.connect()).rejects.toThrow(/no welcome/);
    await until(() => all.length === 2);
  });

  it('L23: a socket that closes before welcome rejects connect()', async () => {
    const { c, all } = fakeClient({ reconnect: false });
    const p = c.connect();
    all[0]!.onclose?.({});
    await expect(p).rejects.toThrow(/closed before welcome/);
    expect(c.status).toBe('closed');
  });

  it('M33: close() during backoff cancels the pending reconnect', async () => {
    const { c, all } = fakeClient({ reconnect: { minDelayMs: 40, jitter: 0 } });
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver(welcome());
    await p;
    all[0]!.onclose?.({});
    expect(c.status).toBe('reconnecting');
    c.close();
    await sleep(100);
    expect(all).toHaveLength(1);
    expect(c.status).toBe('closed');
  });

  it('fatal refusals stop the client: id-in-use rejects and never retries', async () => {
    const { c, all } = fakeClient({ reconnect: { minDelayMs: 5, jitter: 0 } });
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver({ type: 'error', code: 'id-in-use', message: 'another live connection holds this clientId' });
    await expect(p).rejects.toThrow(/^id-in-use/);
    await sleep(40);
    expect(all).toHaveLength(1);
    expect(c.status).toBe('closed');
  });

  it('M36: each welcome resets the best RTT sample, so a new path re-estimates the clock offset', async () => {
    const { c, all } = fakeClient({ reconnect: { minDelayMs: 5, jitter: 0 } });
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver(welcome());
    await p;
    all[0]!.deliver({ type: 'pong', t0: localNow() - 1, serverTime: localNow() + 50_000 });
    expect(c.offsetMs).toBeGreaterThan(49_000);
    all[0]!.onclose?.({});
    await until(() => all.length === 2);
    all[1]!.open();
    all[1]!.deliver(welcome());
    expect(Math.abs(c.offsetMs)).toBeLessThan(1000);
    all[1]!.deliver({ type: 'pong', t0: localNow() - 30, serverTime: localNow() + 7_000 });
    expect(c.offsetMs).toBeGreaterThan(6_900);
    expect(c.offsetMs).toBeLessThan(7_100);
  });

  it('L20: reportSay stamps `at` in hub clock', async () => {
    const { c, all } = fakeClient();
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver(welcome({ serverTime: localNow() + 100_000 }));
    await p;
    c.reportSay({ id: 's', state: 'playing' });
    const at = (all[0]!.sent.at(-1)!.payload as { at: number }).at;
    expect(at - localNow()).toBeGreaterThan(99_000);
  });

  it('a throwing event handler does not break the client', async () => {
    const errors: string[] = [];
    const { c, all } = fakeClient({ onHandlerError: (_e, ev) => errors.push(ev) });
    c.on('open', () => {
      throw new Error('ui bug');
    });
    const p = c.connect();
    all[0]!.open();
    all[0]!.deliver(welcome());
    await p;
    expect(errors).toEqual(['open']);
    expect(c.connected).toBe(true);
  });
});

describe('against a real hub', () => {
  async function hubOn(port: number) {
    const server: Server = createServer();
    const hub = new BridgeHub({ server, onFinal: (_r, m) => ({ name: 'echo', ok: true, payload: { text: m.text } }) });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const stop = async () => {
      hub.close();
      await new Promise((r) => server.close(r));
    };
    return { hub, server, port: (server.address() as { port: number }).port, stop };
  }
  const real = (o: ClientOptions) => {
    const c = new BridgeClient({ heartbeatMs: 0, ...o });
    cleanups.push(() => c.close());
    return c;
  };

  it('H6 + H7: after a hub restart the TV re-creates its room and the phone, refused at first, rejoins it', async () => {
    let h = await hubOn(0);
    cleanups.push(() => h.stop());
    const url = `ws://127.0.0.1:${h.port}/ws`;
    const tv = real({ url, role: 'screen', reconnect: { minDelayMs: 300, maxDelayMs: 300, jitter: 0 } });
    const { code } = await tv.connect();
    const phone = real({ url, role: 'mic', code, reconnect: { minDelayMs: 30, maxDelayMs: 60, jitter: 0 } });
    await phone.connect();
    const refusals: string[] = [];
    phone.on('error', (e) => refusals.push(e.code));
    await h.stop();
    await sleep(350); // the first retries hit ECONNREFUSED
    h = await hubOn(h.port);
    await until(() => tv.connected && phone.connected, 5000);
    expect(refusals).toContain('unknown-code'); // the phone got back before the TV did
    expect(tv.code).toBe(code);
    expect(h.hub.peersOf(h.hub.rooms.get(code)!)).toHaveLength(2);
    const intent = new Promise<IntentMsg>((r) => tv.on('intent', r));
    phone.sendFinal('still here');
    expect((await intent).payload).toEqual({ text: 'still here' });
  });

  it('H6: a failed first connect() rejects but keeps retrying until the hub is up', async () => {
    const probe = await hubOn(0);
    const port = probe.port;
    await probe.stop();
    const tv = real({ url: `ws://127.0.0.1:${port}/ws`, role: 'screen', reconnect: { minDelayMs: 40, maxDelayMs: 80, jitter: 0 } });
    let opened = 0;
    tv.on('open', () => opened++);
    await expect(tv.connect()).rejects.toThrow(/cannot connect|closed before welcome/);
    await sleep(120);
    const h = await hubOn(port);
    cleanups.push(() => h.stop());
    await until(() => opened === 1);
    expect(tv.status).toBe('open');
  });

  it('H7: if the TV never comes back, the phone stops after repairAfterMs and asks to re-pair', async () => {
    let h = await hubOn(0);
    cleanups.push(() => h.stop());
    const url = `ws://127.0.0.1:${h.port}/ws`;
    const tv = real({ url, role: 'screen', reconnect: false });
    const { code } = await tv.connect();
    const phone = real({ url, role: 'mic', code, reconnect: { minDelayMs: 20, maxDelayMs: 40, jitter: 0, repairAfterMs: 250 } });
    await phone.connect();
    const repair = new Promise<{ code: string | undefined }>((r) => phone.on('repair', r));
    let retries = 0;
    phone.on('reconnecting', () => retries++);
    await h.stop();
    h = await hubOn(h.port);
    expect((await repair).code).toBe(code);
    expect(phone.status).toBe('repair');
    const after = retries;
    await sleep(150);
    expect(retries).toBe(after);
    expect(phone.connected).toBe(false);
  });

  it('a first pairing with a wrong code is fatal (no retry loop on a typo)', async () => {
    const h = await hubOn(0);
    cleanups.push(() => h.stop());
    const phone = real({ url: `ws://127.0.0.1:${h.port}/ws`, role: 'mic', code: 'ZZZZ', reconnect: { minDelayMs: 10, jitter: 0 } });
    await expect(phone.connect()).rejects.toThrow(/^unknown-code/);
    await sleep(60);
    expect(phone.status).toBe('closed');
  });
});

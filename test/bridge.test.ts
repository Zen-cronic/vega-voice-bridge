import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeHub } from '../src/hub.js';
import { BridgeClient, decode, isPairingCode, latency, makePairingCode, normalizeCode, type AckMsg, type IntentMsg } from '../src/index.js';

let server: Server;
let hub: BridgeHub;
let url: string;
const clients: BridgeClient[] = [];
const client = (o: ConstructorParameters<typeof BridgeClient>[0]) => {
  const c = new BridgeClient({ reconnect: false, ...o });
  clients.push(c);
  return c;
};
const next = <T>(c: BridgeClient, type: 'intent' | 'ack' | 'transcript.partial' | 'transcript.final' | 'peers') =>
  new Promise<T>((resolve) => {
    const off = c.on(type, (m) => {
      off();
      resolve(m as T);
    });
  });

beforeEach(async () => {
  server = createServer();
  hub = new BridgeHub({
    server,
    joinUrl: (code) => `http://lan:8792/p/${code}`,
    onFinal: async (_room, msg) => ({ name: 'echo', ok: true, payload: { upper: msg.text.toUpperCase() } }),
    onApp: (_room, msg) => (msg.utteranceId ? { name: 'tap', ok: true, payload: msg.payload } : null),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  hub.close();
  await new Promise((r) => server.close(r));
});

describe('protocol helpers', () => {
  it('pairing codes use an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = makePairingCode();
      expect(isPairingCode(c)).toBe(true);
      expect(c).not.toMatch(/[01OIL]/);
    }
    expect(normalizeCode(' k7q-f ')).toBe('K7QF');
  });
  it('decode rejects junk', () => {
    expect(decode('nope')).toBeNull();
    expect(decode('{"type":"bogus"}')).toBeNull();
    expect(decode('{"type":"transcript.final","text":1,"utteranceId":"x"}')).toBeNull();
    expect(decode('{"type":"ping","t0":1}')).toEqual({ type: 'ping', t0: 1 });
  });
  it('latency legs and spans', () => {
    const l = latency([{ hop: 'speech.end', at: 0 }, { hop: 'hub.recv', at: 30 }, { hop: 'screen.render', at: 80 }]);
    expect(l.totalMs).toBe(80);
    expect(l.legs).toEqual([{ from: 'speech.end', to: 'hub.recv', ms: 30 }, { from: 'hub.recv', to: 'screen.render', ms: 50 }]);
    expect(l.span('hub.recv', 'screen.render')).toBe(50);
    expect(l.span('x', 'screen.render')).toBeNull();
  });
});

describe('hub + clients', () => {
  it('pairs a mic to a screen by code and returns a join URL', async () => {
    const tv = client({ url, role: 'screen' });
    const w = await tv.connect();
    expect(isPairingCode(w.code)).toBe(true);
    expect(w.joinUrl).toBe(`http://lan:8792/p/${w.code}`);
    const peers = next<{ peers: unknown[] }>(tv, 'peers');
    const phone = client({ url, role: 'mic', code: w.code.toLowerCase(), name: 'Zin' });
    await phone.connect();
    expect((await peers).peers).toHaveLength(2);
  });

  it('rejects an unknown code', async () => {
    const phone = client({ url, role: 'mic', code: 'ZZZZ' });
    await expect(phone.connect()).rejects.toThrow(/unknown-code/);
  });

  it('a screen can resume its code after reload', async () => {
    const tv = client({ url, role: 'screen', code: 'K7QF' });
    expect((await tv.connect()).code).toBe('K7QF');
  });

  it('final transcript -> intent -> screen ack -> mic gets hops end to end', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    tv.on('intent', (m) => tv.ack(m, { receivedAt: performance.timeOrigin + performance.now() }));
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const gotFinal = next(tv, 'transcript.final');
    const gotIntent = next<IntentMsg>(phone, 'intent');
    const gotAck = next<AckMsg>(phone, 'ack');
    const id = phone.sendFinal('eight at sixty', { speechEndAt: performance.timeOrigin + performance.now() - 5 });
    await gotFinal;
    const intent = await gotIntent;
    expect(intent).toMatchObject({ utteranceId: id, name: 'echo', ok: true, payload: { upper: 'EIGHT AT SIXTY' } });
    const ack = await gotAck;
    expect(ack.hops.map((h) => h.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv', 'hub.intent', 'screen.recv', 'screen.render', 'hub.ack']);
    const l = latency(ack.hops);
    expect(l.span('speech.end', 'screen.render')).toBeGreaterThanOrEqual(0);
    for (const leg of l.legs) expect(leg.ms).toBeGreaterThanOrEqual(-2); // same host; tolerate clock-estimate jitter
  });

  it('partials are forwarded to screens only', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const p = next<{ text: string }>(tv, 'transcript.partial');
    phone.sendPartial('eight at', 'u1');
    expect((await p).text).toBe('eight at');
  });

  it('tracked app messages (taps) produce intents with hops', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const gotIntent = next<IntentMsg>(tv, 'intent');
    phone.sendApp('log.tap', { reps: 5 }, { track: true, startedAt: performance.timeOrigin + performance.now() });
    const i = await gotIntent;
    expect(i.name).toBe('tap');
    expect(i.hops.map((h) => h.hop)).toEqual(['input.end', 'mic.send', 'hub.recv', 'hub.intent']);
  });

  it('two mics can log to the same screen', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const a = client({ url, role: 'mic', code, name: 'A' });
    const b = client({ url, role: 'mic', code, name: 'B' });
    await a.connect();
    await b.connect();
    const seen: string[] = [];
    const both = new Promise<void>((resolve) => tv.on('intent', (m) => (seen.push(m.from ?? ''), seen.length === 2 && resolve())));
    a.sendFinal('one');
    b.sendFinal('two');
    await both;
    expect(new Set(seen)).toEqual(new Set([a.clientId, b.clientId]));
  });
});

/**
 * Protocol v1 conformance: wire vectors for every message type, the routing rules (who receives what),
 * error codes, hop ordering, and the two-way speech capability (screen.say).
 * A second implementation of the hub or client (another language, another TV platform) should pass these.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeHub } from '../src/hub.js';
import {
  BridgeClient,
  CODE_ALPHABET,
  PROTOCOL_VERSION,
  SAY_STATUS_TOPIC,
  SAY_STOP_TOPIC,
  SAY_TOPIC,
  SPEECH_TOPIC,
  decode,
  encode,
  isSayStatusTopic,
  parseSay,
  parseSayStatus,
  parseSayStop,
  parseSpeech,
  resolveSayAudio,
  type AppMsg,
  type BridgeMessage,
  type SayPayload,
} from '../src/index.js';

let server: Server;
let hub: BridgeHub;
let url: string;
const appSeen: Array<{ topic: string; payload: unknown; role: string }> = [];
const clients: BridgeClient[] = [];
const sockets: WebSocket[] = [];
const client = (o: ConstructorParameters<typeof BridgeClient>[0]) => {
  const c = new BridgeClient({ reconnect: false, ...o });
  clients.push(c);
  return c;
};
/** A raw socket, to test the hub as a black box (what a non-JS client would see). */
async function raw(): Promise<{ ws: WebSocket; next: (type?: string) => Promise<BridgeMessage>; send: (m: unknown) => void }> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const inbox: BridgeMessage[] = [];
  const waiters: Array<{ type?: string; fn: (m: BridgeMessage) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as BridgeMessage;
    const i = waiters.findIndex((w) => !w.type || w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.fn(m);
    else inbox.push(m);
  });
  await new Promise((r) => ws.once('open', r));
  return {
    ws,
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    /** The next message, or the next one of `type` (others stay queued). */
    next: (type) =>
      new Promise((resolve) => {
        const i = inbox.findIndex((m) => !type || m.type === type);
        if (i >= 0) resolve(inbox.splice(i, 1)[0]!);
        else waiters.push({ type, fn: resolve });
      }),
  };
}

beforeEach(async () => {
  appSeen.length = 0;
  server = createServer();
  hub = new BridgeHub({
    server,
    joinUrl: (code) => `https://tv.example/p/${code}`,
    onFinal: (_room, msg) => (msg.text === 'boom' ? Promise.reject(new Error('parser exploded')) : { name: 'echo', ok: true, payload: { text: msg.text } }),
    onApp: (_room, msg, from) => {
      appSeen.push({ topic: msg.topic, payload: msg.payload, role: from.role });
      return msg.utteranceId ? { name: msg.topic, ok: true, payload: msg.payload } : null;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.close();
  hub.close();
  await new Promise((r) => server.close(r));
});

describe('wire format', () => {
  const vectors: Array<[string, BridgeMessage]> = [
    ['hello', { type: 'hello', v: 1, role: 'screen', clientId: 'screen_1' }],
    ['hello (mic with code)', { type: 'hello', v: 1, role: 'mic', clientId: 'mic_1', code: 'K7QF', name: 'Zin' }],
    ['welcome', { type: 'welcome', v: 1, clientId: 'mic_1', role: 'mic', code: 'K7QF', joinUrl: 'https://tv.example/p/K7QF', peers: [], serverTime: 1 }],
    ['peers', { type: 'peers', peers: [{ clientId: 'a', role: 'screen' }] }],
    ['hello (with resumeToken)', { type: 'hello', v: 1, role: 'screen', clientId: 'screen_1', code: 'K7QF', resumeToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' }],
    ['error', { type: 'error', code: 'unknown-code', message: 'no TV is showing code ZZZZ' }],
    ['error (rate-limited)', { type: 'error', code: 'rate-limited', message: 'too many wrong codes', retryAfterMs: 42000 }],
    ['ping', { type: 'ping', t0: 1 }],
    ['pong', { type: 'pong', t0: 1, serverTime: 2 }],
    ['transcript.partial', { type: 'transcript.partial', utteranceId: 'u1', text: 'six with', hops: [{ hop: 'mic.partial', at: 1 }] }],
    ['transcript.final', { type: 'transcript.final', utteranceId: 'u1', text: 'six with ten pounds', hops: [{ hop: 'mic.send', at: 1 }] }],
    ['intent', { type: 'intent', utteranceId: 'u1', name: 'log_set', ok: true, payload: {}, hops: [] }],
    ['ack', { type: 'ack', utteranceId: 'u1', stage: 'rendered', hops: [] }],
    ['app', { type: 'app', topic: SAY_TOPIC, payload: { id: 's1', text: 'Logged.' } }],
    ['app (screen.speech)', { type: 'app', topic: SPEECH_TOPIC, payload: { id: 's1', state: 'queued', at: 5, text: 'Logged.', durationMs: 900 } }],
    ['app (screen.say.stop)', { type: 'app', topic: SAY_STOP_TOPIC, payload: { id: 's1', reason: 'barge-in' }, from: 'mic_1' }],
  ];
  it.each(vectors)('%s round-trips through encode/decode unchanged', (_n, m) => {
    expect(decode(encode(m))).toEqual(m);
  });
  it('rejects malformed frames', () => {
    for (const bad of [
      '',
      '[]',
      'null',
      '42',
      '{"type":1}',
      '{"type":"nope"}',
      '{"type":"hello","v":1,"role":"remote","clientId":"x"}',
      '{"type":"hello","v":1,"role":"mic","clientId":"x","code":1234}',
      '{"type":"hello","v":1,"role":"mic","clientId":""}',
      '{"type":"transcript.final","utteranceId":"u"}',
      '{"type":"transcript.final","utteranceId":"u","text":"x","hops":[{"hop":"a","at":"1"}]}',
      '{"type":"ack","utteranceId":"u","hops":"x"}',
      '{"type":"ack","utteranceId":"u","stage":"done","hops":[]}',
      '{"type":"intent","utteranceId":"u","name":"n","ok":"yes","payload":1,"hops":[]}',
      '{"type":"app","payload":1}',
      '{"type":"ping","t0":null}',
    ])
      expect(decode(bad)).toBeNull();
  });
  it('optional fields may be null (dropped) and missing hops default to []', () => {
    expect(decode('{"type":"hello","v":1,"role":"mic","clientId":"m","code":"K7QF","name":null}')).toEqual({ type: 'hello', v: 1, role: 'mic', clientId: 'm', code: 'K7QF' });
    expect(decode('{"type":"transcript.final","utteranceId":"u","text":"x"}')).toEqual({ type: 'transcript.final', utteranceId: 'u', text: 'x', hops: [] });
  });
  it('a hello for another protocol version decodes, so the hub can answer "version" rather than bad-message', () => {
    expect(decode('{"type":"hello","v":2,"role":"tv","clientId":5}')).toMatchObject({ type: 'hello', v: 2 });
  });
  it('protocol constants are stable', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    expect([SAY_TOPIC, SAY_STATUS_TOPIC]).toEqual(['screen.say', 'screen.say.status']);
    expect([SPEECH_TOPIC, SAY_STOP_TOPIC]).toEqual(['screen.speech', 'screen.say.stop']);
  });
});

describe('hub as a black box (raw sockets)', () => {
  it('a message before hello is refused', async () => {
    const s = await raw();
    s.send({ type: 'transcript.final', utteranceId: 'u', text: 'x', hops: [] });
    expect(await s.next()).toMatchObject({ type: 'error', code: 'bad-message' });
  });
  it('unparseable frames get bad-message; the socket stays usable', async () => {
    const s = await raw();
    s.send('not json');
    expect(await s.next()).toMatchObject({ type: 'error', code: 'bad-message' });
    s.send({ type: 'ping', t0: 5 });
    expect(await s.next()).toMatchObject({ type: 'pong', t0: 5 });
  });
  it('a wrong protocol version is refused with code "version"', async () => {
    const s = await raw();
    s.send({ type: 'hello', v: 2, role: 'screen', clientId: 's' });
    expect(await s.next()).toMatchObject({ type: 'error', code: 'version' });
  });
  it('a screen hello creates a room: welcome carries a valid code, the join URL and the hub clock', async () => {
    const s = await raw();
    s.send({ type: 'hello', v: 1, role: 'screen', clientId: 'screen_a' });
    const w = await s.next();
    expect(w).toMatchObject({ type: 'welcome', v: 1, role: 'screen', clientId: 'screen_a' });
    const code = (w as { code: string }).code;
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    expect((w as { joinUrl: string }).joinUrl).toBe(`https://tv.example/p/${code}`);
    expect(typeof (w as { serverTime: number }).serverTime).toBe('number');
  });
  it('a mic needs a live code (unknown-code otherwise); codes are case- and dash-insensitive', async () => {
    const tv = await raw();
    tv.send({ type: 'hello', v: 1, role: 'screen', clientId: 'screen_b' });
    const { code } = (await tv.next()) as { code: string };
    const bad = await raw();
    bad.send({ type: 'hello', v: 1, role: 'mic', clientId: 'mic_x', code: 'ZZZZ' });
    expect(await bad.next()).toMatchObject({ type: 'error', code: 'unknown-code' });
    const ok = await raw();
    ok.send({ type: 'hello', v: 1, role: 'mic', clientId: 'mic_y', code: ` ${code.slice(0, 2).toLowerCase()}-${code.slice(2)} ` });
    expect(await ok.next()).toMatchObject({ type: 'welcome', code });
  });
  it('a failing app handler surfaces as handler-failed with the utteranceId', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const err = new Promise<BridgeMessage>((r) => tv.on('error', (m) => r(m)));
    const id = phone.sendFinal('boom');
    expect(await err).toMatchObject({ type: 'error', code: 'handler-failed', utteranceId: id, message: 'parser exploded' });
  });
});

describe('routing rules', () => {
  it('partials and finals go to screens only; intents to everyone; acks to mics only', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const phone = client({ url, role: 'mic', code });
    const partner = client({ url, role: 'mic', code });
    await phone.connect();
    await partner.connect();
    const got: Record<string, string[]> = { tv: [], phone: [], partner: [] };
    for (const [k, c] of [['tv', tv], ['phone', phone], ['partner', partner]] as const) for (const t of ['transcript.partial', 'transcript.final', 'intent', 'ack'] as const) c.on(t, () => got[k]!.push(t));
    tv.on('intent', (m) => tv.ack(m));
    const acked = new Promise((r) => phone.on('ack', r));
    phone.sendPartial('six', 'u9');
    phone.sendFinal('six with ten pounds', { utteranceId: 'u9' });
    await acked;
    await new Promise((r) => setTimeout(r, 50));
    expect(got.tv).toEqual(['transcript.partial', 'transcript.final', 'intent']);
    expect(got.phone).toEqual(['intent', 'ack']);
    expect(got.partner).toEqual(['intent', 'ack']);
  });
  it('hops are appended in order and never reordered: speech.end -> ... -> hub.ack', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    tv.on('intent', (m) => tv.ack(m, { receivedAt: performance.timeOrigin + performance.now() }));
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const ack = new Promise<{ hops: Array<{ hop: string; at: number }> }>((r) => phone.on('ack', r));
    phone.sendFinal('x', { speechEndAt: performance.timeOrigin + performance.now() });
    const hops = (await ack).hops;
    expect(hops.map((h) => h.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv', 'hub.intent', 'screen.recv', 'screen.render', 'hub.ack']);
    for (let i = 1; i < hops.length; i++) expect(hops[i]!.at).toBeGreaterThanOrEqual(hops[i - 1]!.at - 5);
  });
  it('a final may lead with speech.start (revision 3): speech.start -> speech.end -> mic.send -> ...', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    tv.on('intent', (m) => tv.ack(m));
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const ack = new Promise<{ hops: Array<{ hop: string; at: number }> }>((r) => phone.on('ack', r));
    const t = performance.timeOrigin + performance.now();
    phone.sendFinal('x', { speechStartAt: t - 900, speechEndAt: t - 100 });
    const hops = (await ack).hops;
    expect(hops.map((h) => h.hop)).toEqual(['speech.start', 'speech.end', 'mic.send', 'hub.recv', 'hub.intent', 'screen.render', 'hub.ack']);
    expect(Math.round(hops[1]!.at - hops[0]!.at)).toBe(800);
  });
  it('untracked app messages reach the app handler and produce no intent', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    let intents = 0;
    tv.on('intent', () => intents++);
    tv.sendApp('state.request', { a: 1 });
    await new Promise((r) => setTimeout(r, 60));
    expect(appSeen).toEqual([{ topic: 'state.request', payload: { a: 1 }, role: 'screen' }]);
    expect(intents).toBe(0);
    expect(code).toBeTruthy();
  });
  it('a reconnecting client with the same clientId and resumeToken replaces its old socket (no duplicate peer)', async () => {
    const tv = client({ url, role: 'screen', clientId: 'screen_same' });
    const { code } = await tv.connect();
    const again = client({ url, role: 'screen', clientId: 'screen_same', resumeToken: tv.resumeToken, code });
    await again.connect();
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.peersOf(hub.rooms.get(code)!)).toHaveLength(1);
    expect(tv.connected).toBe(false);
  });
  it('a hello that claims a live clientId without its resumeToken gets id-in-use; the holder keeps its seat', async () => {
    const tv = client({ url, role: 'screen', clientId: 'screen_held' });
    const { code } = await tv.connect();
    const thief = await raw();
    thief.send({ type: 'hello', v: 1, role: 'screen', clientId: 'screen_held', code, resumeToken: 'guess' });
    expect(await thief.next()).toMatchObject({ type: 'error', code: 'id-in-use' });
    const mic = await raw();
    mic.send({ type: 'hello', v: 1, role: 'mic', clientId: 'screen_held', code });
    expect(await mic.next()).toMatchObject({ type: 'error', code: 'id-in-use' });
    expect(tv.connected).toBe(true);
    expect(hub.rooms.get(code)!.peers.get('screen_held')!.role).toBe('screen');
  });
  it('0.1 clients (no resumeToken) still replace a same-role socket with the same clientId', async () => {
    const a = await raw();
    a.send({ type: 'hello', v: 1, role: 'screen', clientId: 'legacy_tv' });
    const { code } = (await a.next()) as { code: string };
    const closed = new Promise((r) => a.ws.once('close', r));
    const b = await raw();
    b.send({ type: 'hello', v: 1, role: 'screen', clientId: 'legacy_tv', code });
    expect(await b.next()).toMatchObject({ type: 'welcome', code });
    await closed;
    expect(hub.peersOf(hub.rooms.get(code)!)).toHaveLength(1);
  });
  it('role rules: a mic may not ack, a screen may not send transcripts, nobody may send hub messages', async () => {
    const tv = await raw();
    tv.send({ type: 'hello', v: 1, role: 'screen', clientId: 'tv_r' });
    const { code } = (await tv.next()) as { code: string };
    const mic = await raw();
    mic.send({ type: 'hello', v: 1, role: 'mic', clientId: 'mic_r', code });
    expect(await mic.next()).toMatchObject({ type: 'welcome' });
    mic.send({ type: 'ack', utteranceId: 'u', stage: 'rendered', hops: [] });
    expect(await mic.next('error')).toMatchObject({ code: 'not-allowed' });
    tv.send({ type: 'transcript.final', utteranceId: 'u', text: 'x', hops: [] });
    expect(await tv.next('error')).toMatchObject({ code: 'not-allowed' });
    mic.send({ type: 'intent', utteranceId: 'u', name: 'x', ok: true, payload: null, hops: [] });
    expect(await mic.next('error')).toMatchObject({ code: 'not-allowed' });
  });
  it('every field is type- and length-checked: a bad field gets bad-message naming it', async () => {
    const s = await raw();
    const cases: Array<[unknown, RegExp]> = [
      [{ type: 'hello', v: 1, role: 'mic', clientId: 'x', code: 1234 }, /hello\.code must be a string/],
      [{ type: 'hello', v: 1, role: 'mic', clientId: 7 }, /hello\.clientId must be a string/],
      [{ type: 'hello', v: 1, role: 'mic', clientId: 'x'.repeat(129) }, /hello\.clientId must be 1\.\.128/],
      [{ type: 'hello', v: '1', role: 'mic', clientId: 'x' }, /hello\.v must be a number/],
      [{ type: 'app', topic: 5, payload: 1 }, /app\.topic must be a string/],
      [{ type: 'transcript.final', utteranceId: 'u', text: 'x', hops: [null] }, /hops entries/],
      [{ type: 'ping', t0: 'now' }, /ping\.t0 must be a finite number/],
    ];
    for (const [m, re] of cases) {
      s.send(m);
      const e = await s.next();
      expect(e).toMatchObject({ type: 'error', code: 'bad-message' });
      expect((e as { message: string }).message).toMatch(re);
    }
    s.send({ type: 'ping', t0: 1 });
    expect(await s.next()).toMatchObject({ type: 'pong', t0: 1 });
  });
});

describe('screen.say: TV -> room speech (two-way)', () => {
  it('hub.say reaches every screen in the room and no mic; defaults priority to normal', async () => {
    const tv = client({ url, role: 'screen' });
    const tv2 = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    (tv2 as unknown as { code: string }).code = code;
    await tv2.connect();
    const phone = client({ url, role: 'mic', code });
    await phone.connect();
    const heard: Array<Required<SayPayload>> = [];
    tv.onSay((l) => heard.push(l));
    tv2.onSay((l) => heard.push(l));
    let micGot = 0;
    phone.on('app', (m) => void (m.topic === SAY_TOPIC && micGot++)); // mics get a notice instead (see the echo guard relays)
    const sent = hub.say(hub.rooms.get(code)!, { id: 'say_1', text: 'Logged. Rest two minutes.', audioUrl: 'https://cdn.example/say_1.mp3', durationMs: 2100 });
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.priority).toBe('normal');
    expect(heard).toEqual([
      { id: 'say_1', text: 'Logged. Rest two minutes.', audioUrl: 'https://cdn.example/say_1.mp3', durationMs: 2100, priority: 'normal' },
      { id: 'say_1', text: 'Logged. Rest two minutes.', audioUrl: 'https://cdn.example/say_1.mp3', durationMs: 2100, priority: 'normal' },
    ]);
    expect(micGot).toBe(0);
  });
  it('an app can use its own topic name (e.g. coach.say); onSay listens to the topic it is given', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const generic: string[] = [];
    const coach: string[] = [];
    tv.onSay((l) => generic.push(l.id));
    tv.onSay((l) => coach.push(l.id), 'coach.say');
    hub.say(hub.rooms.get(code)!, { id: 'c1', text: 'Second miss in a row.', priority: 'high' }, { topic: 'coach.say' });
    await new Promise((r) => setTimeout(r, 60));
    expect(coach).toEqual(['c1']);
    expect(generic).toEqual([]);
  });
  it('screens report playback back to the hub on screen.say.status', async () => {
    const tv = client({ url, role: 'screen' });
    await tv.connect();
    tv.reportSay({ id: 'say_1', state: 'playing' });
    await new Promise((r) => setTimeout(r, 60));
    expect(appSeen[0]).toMatchObject({ topic: 'screen.say.status', role: 'screen', payload: { id: 'say_1', state: 'playing' } });
  });
  it('parseSay validates and fills defaults; resolveSayAudio handles relative and absolute URLs', () => {
    expect(parseSay({ id: 'a', text: 'hi' })).toEqual({ id: 'a', text: 'hi', audioUrl: '', durationMs: 3000, priority: 'normal' });
    expect(parseSay({ id: 'a', text: 'hi', durationMs: -1, priority: 'urgent' })).toMatchObject({ durationMs: 3000, priority: 'normal' });
    expect(parseSay({ text: 'no id' })).toBeNull();
    expect(parseSay('nope')).toBeNull();
    expect(resolveSayAudio('/api/tts/a.mp3', 'http://192.168.1.20:8792/')).toBe('http://192.168.1.20:8792/api/tts/a.mp3');
    expect(resolveSayAudio('https://bucket.example/a.mp3?sig', 'http://x')).toBe('https://bucket.example/a.mp3?sig');
    expect(resolveSayAudio('', 'http://x')).toBe('');
    expect(resolveSayAudio('//cdn.example/a.mp3', 'https://hub.example')).toBe('https://cdn.example/a.mp3');
    expect(resolveSayAudio('//cdn.example/a.mp3', 'http://192.168.1.20:8792')).toBe('http://cdn.example/a.mp3');
  });
});

describe('echo guard relays (revision 3): screen.speech to mics, screen.say.stop to screens', () => {
  /** Collect app frames by topic for a client. */
  const appLog = (c: BridgeClient) => {
    const got: AppMsg[] = [];
    c.on('app', (m) => void got.push(m));
    return got;
  };
  async function room() {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const phone = client({ url, role: 'mic', code });
    const partner = client({ url, role: 'mic', code });
    await phone.connect();
    await partner.connect();
    return { tv, phone, partner, code };
  }
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it('hub.say also sends each mic a queued notice, with the text and duration but never the audio URL', async () => {
    const { tv, phone, partner, code } = await room();
    const [tvGot, phoneGot, partnerGot] = [appLog(tv), appLog(phone), appLog(partner)];
    hub.say(hub.rooms.get(code)!, { id: 'say_9', text: 'Rest two minutes.', audioUrl: 'https://cdn.example/a.mp3?sig=secret', durationMs: 1800 });
    await settle();
    for (const got of [phoneGot, partnerGot]) {
      expect(got).toHaveLength(1);
      expect(got[0]!.topic).toBe(SPEECH_TOPIC);
      expect(got[0]!.payload).toEqual({ id: 'say_9', state: 'queued', at: expect.any(Number), text: 'Rest two minutes.', durationMs: 1800 });
      expect(JSON.stringify(got[0])).not.toContain('sig=secret');
    }
    expect(tvGot.map((m) => m.topic)).toEqual([SAY_TOPIC]);
  });

  it("a screen's playback report reaches the mics as a notice; invalid reports and mic-sent reports are not relayed", async () => {
    const { tv, phone, code } = await room();
    const got = appLog(phone);
    tv.reportSay({ id: 'say_9', state: 'playing', text: 'Rest two minutes.' });
    tv.sendApp(SAY_STATUS_TOPIC, { id: 'say_9', state: 'exploded' });
    tv.sendApp('coach.say.status', { id: 'c1', state: 'ended', at: 42 });
    phone.sendApp(SAY_STATUS_TOPIC, { id: 'fake', state: 'ended', at: 1 });
    await settle();
    expect(got.map((m) => m.payload)).toEqual([
      { id: 'say_9', state: 'playing', at: expect.any(Number), text: 'Rest two minutes.' },
      { id: 'c1', state: 'ended', at: 42 },
    ]);
    expect(appSeen.map((a) => a.topic)).toEqual([SAY_STATUS_TOPIC, SAY_STATUS_TOPIC, 'coach.say.status', SAY_STATUS_TOPIC]); // onApp still sees all four
    expect(code).toBeTruthy();
  });

  it("a mic's screen.say.stop reaches the room's screens (from = the mic), not the other mics; a screen's is not relayed", async () => {
    const { tv, phone, partner } = await room();
    const [tvGot, partnerGot] = [appLog(tv), appLog(partner)];
    const stops: unknown[] = [];
    tv.onSayStop((s) => stops.push(s));
    phone.stopSay({ id: 'say_9', reason: 'barge-in' });
    tv.sendApp(SAY_STOP_TOPIC, {});
    await settle();
    expect(stops).toEqual([{ id: 'say_9', reason: 'barge-in', from: phone.clientId }]);
    expect(tvGot).toHaveLength(1);
    expect(partnerGot).toHaveLength(0);
    expect(appSeen.filter((a) => a.topic === SAY_STOP_TOPIC).map((a) => a.role)).toEqual(['mic', 'screen']);
  });

  it('hub.stopSay sends a stop to the screens; a raw mic sees notices on the wire as plain app frames', async () => {
    const tv = client({ url, role: 'screen' });
    const { code } = await tv.connect();
    const stops: unknown[] = [];
    tv.onSayStop((s) => stops.push(s));
    const mic = await raw();
    mic.send({ type: 'hello', v: 1, role: 'mic', clientId: 'mic_raw', code });
    expect(await mic.next('welcome')).toMatchObject({ code });
    hub.say(hub.rooms.get(code)!, { id: 'r1', text: 'Hi.' });
    expect(await mic.next('app')).toEqual({ type: 'app', topic: SPEECH_TOPIC, payload: { id: 'r1', state: 'queued', at: expect.any(Number), text: 'Hi.' } });
    hub.stopSay(hub.rooms.get(code)!, { reason: 'app' });
    await settle();
    expect(stops).toEqual([{ reason: 'app' }]);
  });

  it('speechNotices: false turns the notices off', async () => {
    const srv = createServer();
    const quiet = new BridgeHub({ server: srv, speechNotices: false });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address();
    const u = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws`;
    try {
      const tv = client({ url: u, role: 'screen' });
      const { code } = await tv.connect();
      const phone = client({ url: u, role: 'mic', code });
      await phone.connect();
      const got = appLog(phone);
      quiet.say(quiet.rooms.get(code)!, { id: 'q', text: 'quiet' });
      tv.reportSay({ id: 'q', state: 'playing' });
      await settle();
      expect(got).toHaveLength(0);
    } finally {
      for (const c of clients.splice(0)) c.close();
      quiet.close();
      await new Promise((r) => srv.close(r));
    }
  });

  it('payload validation: parseSpeech, parseSayStatus, parseSayStop, isSayStatusTopic', () => {
    expect(parseSpeech({ id: 'a', state: 'queued', at: 1, text: 'x', durationMs: 5 })).toEqual({ id: 'a', state: 'queued', at: 1, text: 'x', durationMs: 5 });
    expect(parseSpeech({ id: 'a', state: 'playing', at: 1, durationMs: -1, audioUrl: 'https://x' })).toEqual({ id: 'a', state: 'playing', at: 1 });
    for (const bad of [null, 'x', { id: '', state: 'queued', at: 1 }, { id: 'a', state: 'nope', at: 1 }, { id: 'a', state: 'ended' }]) expect(parseSpeech(bad)).toBeNull();
    expect(parseSayStatus({ id: 'a', state: 'ended', at: 3, detail: 'ok' })).toEqual({ id: 'a', state: 'ended', at: 3, detail: 'ok' });
    expect(parseSayStatus({ id: 'a', state: 'ended' }, 99)).toEqual({ id: 'a', state: 'ended', at: 99 });
    expect(parseSayStatus({ id: 'a', state: 'queued', at: 1 })).toBeNull(); // queued is the hub's word, not a playback state
    expect(parseSayStop(undefined)).toEqual({});
    expect(parseSayStop({ id: 7, reason: 'barge-in', extra: 1 })).toEqual({ reason: 'barge-in' });
    expect([SAY_STATUS_TOPIC, 'coach.say.status', 'screen.say', 'status'].map(isSayStatusTopic)).toEqual([true, true, false, false]);
  });
});

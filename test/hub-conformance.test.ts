// The hub's side of protocol v1, as a black box over raw WebSockets: what any hub must do on the wire.
//
//   npm test                                           runs it against this repo's CLI hub, in-process, with --echo
//   TVB_HUB_URL=ws://host:port/ws npm run conformance  runs the same cases against any running hub
//
// The hub under test must answer each transcript.final with an intent and a screen.say line to the same room, as
// `tv-voice-bridge-hub --echo` does, and must not check Origin for clients that send none. Each run makes two
// wrong-code hellos, well inside any hub's guess budget.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import vectors from './vectors/wire.json' with { type: 'json' };

type Msg = Record<string, unknown> & { type: string };
type Raw = { send: (m: unknown) => void; next: (type?: string, topic?: string) => Promise<Msg>; seen: (type: string, topic?: string) => Msg[]; close: () => void };

let url = process.env.TVB_HUB_URL ?? '';
let stop: (() => Promise<void>) | undefined;
const sockets: WebSocket[] = [];
const external = !!process.env.TVB_HUB_URL;
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const id = (name: string) => `${name}_${run}`;

beforeAll(async () => {
  if (url) return;
  const { startHubCli } = await import('../src/cli.js');
  const app = await startHubCli({ port: 0, host: '127.0.0.1', path: '/ws', echo: true, trustProxy: false, quiet: true }, () => undefined);
  url = `ws://127.0.0.1:${app.port}/ws`;
  stop = app.close;
});
afterAll(async () => {
  for (const s of sockets) s.terminate();
  await stop?.();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const matches = (m: Msg, type?: string, topic?: string) => (!type || m.type === type) && (!topic || m.topic === topic);

async function raw(): Promise<Raw> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const inbox: Msg[] = [];
  const all: Msg[] = [];
  const waiters: Array<{ type?: string; topic?: string; fn: (m: Msg) => void }> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as Msg;
    all.push(m);
    const i = waiters.findIndex((w) => matches(m, w.type, w.topic));
    if (i >= 0) waiters.splice(i, 1)[0]!.fn(m);
    else inbox.push(m);
  });
  ws.on('error', () => undefined);
  await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  return {
    send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next: (type, topic) =>
      new Promise((resolve, reject) => {
        const i = inbox.findIndex((m) => matches(m, type, topic));
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]!);
        const timer = setTimeout(() => reject(new Error(`no ${type ?? 'message'}${topic ? ` ${topic}` : ''} within 3 s`)), 3000);
        waiters.push({ type, topic, fn: (m) => (clearTimeout(timer), resolve(m)) });
      }),
    seen: (type, topic) => all.filter((m) => matches(m, type, topic)),
    close: () => ws.close(),
  };
}

/** A TV and a phone paired in a fresh room. */
async function pair() {
  const tv = await raw();
  tv.send({ type: 'hello', v: 1, role: 'screen', clientId: id('tv') });
  const w = await tv.next('welcome');
  const phone = await raw();
  phone.send({ type: 'hello', v: 1, role: 'mic', clientId: id('phone'), code: w.code });
  await phone.next('welcome');
  return { tv, phone, code: w.code as string };
}

describe(`hub conformance (${external ? process.env.TVB_HUB_URL : 'in-process CLI hub with --echo'})`, () => {
  it('every invalid vector gets bad-message, naming the field where the vector says; the socket stays usable', async () => {
    const s = await raw();
    for (const v of vectors.invalid) {
      s.send(v.frame);
      const e = await s.next('error');
      expect(e, v.name).toMatchObject({ code: 'bad-message' });
      if ('error' in v && v.error) expect(String(e.message), v.name).toContain(v.error);
    }
    s.send({ type: 'ping', t0: 7 });
    expect(await s.next('pong')).toMatchObject({ t0: 7 });
  });

  it('before hello only hello and ping are allowed; ping answers with t0 and the hub clock', async () => {
    const s = await raw();
    s.send({ type: 'transcript.final', utteranceId: 'u', text: 'x', hops: [] });
    expect(await s.next('error')).toMatchObject({ code: 'bad-message' });
    const before = Date.now();
    s.send({ type: 'ping', t0: 42 });
    const pong = await s.next('pong');
    expect(pong.t0).toBe(42);
    expect(Math.abs(Number(pong.serverTime) - before)).toBeLessThan(60_000);
  });

  it('another protocol version is refused with code version', async () => {
    const s = await raw();
    s.send({ type: 'hello', v: 2, role: 'screen', clientId: id('future') });
    expect(await s.next('error')).toMatchObject({ code: 'version' });
  });

  it('a screen hello creates a room: welcome has a 4-character code from the alphabet, the peers and the hub clock', async () => {
    const s = await raw();
    s.send({ type: 'hello', v: 1, role: 'screen', clientId: id('tv_w') });
    const w = await s.next('welcome');
    expect(w).toMatchObject({ v: vectors.protocolVersion, role: 'screen', clientId: id('tv_w') });
    expect(String(w.code)).toMatch(new RegExp(`^[${vectors.codeAlphabet}]{4}$`));
    expect(typeof w.serverTime).toBe('number');
    expect(w.peers).toEqual(expect.arrayContaining([expect.objectContaining({ clientId: id('tv_w'), role: 'screen' })]));
  });

  it('a mic needs a live code; codes are compared without case, spaces or dashes', async () => {
    const tv = await raw();
    tv.send({ type: 'hello', v: 1, role: 'screen', clientId: id('tv_c') });
    const code = String((await tv.next('welcome')).code);
    const wrong = await raw();
    const unused = [...vectors.codeAlphabet].find((c) => !code.includes(c))!.repeat(4);
    wrong.send({ type: 'hello', v: 1, role: 'mic', clientId: id('mic_wrong'), code: unused });
    expect(await wrong.next()).toMatchObject({ type: 'error', code: 'unknown-code' });
    const ok = await raw();
    ok.send({ type: 'hello', v: 1, role: 'mic', clientId: id('mic_c'), code: ` ${code.slice(0, 2).toLowerCase()}-${code.slice(2)} ` });
    expect(await ok.next()).toMatchObject({ type: 'welcome', code });
  });

  it('routing: partials and finals reach screens only; the intent reaches the room; the ack reaches mics only, with hops in order', async () => {
    const { tv, phone } = await pair();
    const t0 = Date.now();
    phone.send({ type: 'transcript.partial', utteranceId: 'u1', text: 'what should', hops: [{ hop: 'mic.partial', at: t0 }] });
    expect(await tv.next('transcript.partial')).toMatchObject({ utteranceId: 'u1', text: 'what should', from: id('phone') });
    phone.send({ type: 'transcript.final', utteranceId: 'u1', text: 'what should I do', hops: [{ hop: 'speech.end', at: t0 }, { hop: 'mic.send', at: t0 + 1 }] });
    const final = await tv.next('transcript.final');
    expect((final.hops as Array<{ hop: string }>).map((h) => h.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv']);
    const intent = await tv.next('intent');
    expect(intent).toMatchObject({ utteranceId: 'u1', from: id('phone') });
    expect((intent.hops as Array<{ hop: string }>).map((h) => h.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv', 'hub.intent']);
    expect(await phone.next('intent')).toMatchObject({ utteranceId: 'u1' });
    const hops = [...(intent.hops as Array<{ hop: string; at: number }>), { hop: 'screen.recv', at: Date.now() }, { hop: 'screen.render', at: Date.now() }];
    tv.send({ type: 'ack', utteranceId: 'u1', stage: 'rendered', hops });
    const ack = await phone.next('ack');
    expect((ack.hops as Array<{ hop: string }>).map((h) => h.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv', 'hub.intent', 'screen.recv', 'screen.render', 'hub.ack']);
    await sleep(100);
    expect(phone.seen('transcript.partial').concat(phone.seen('transcript.final'))).toEqual([]);
    expect(tv.seen('ack')).toEqual([]);
  });

  it("the reply's screen.say reaches screens only, and mics get a queued screen.speech with the text and never the audio URL", async () => {
    const { tv, phone } = await pair();
    phone.send({ type: 'transcript.final', utteranceId: 'u2', text: 'hello', hops: [] });
    const say = await tv.next('app', 'screen.say');
    const line = say.payload as { id: string; text: string };
    expect(typeof line.id).toBe('string');
    expect(typeof line.text).toBe('string');
    const notice = await phone.next('app', 'screen.speech');
    expect(notice.payload).toMatchObject({ id: line.id, state: 'queued', text: line.text });
    expect(notice.payload).not.toHaveProperty('audioUrl');
    await sleep(100);
    expect(phone.seen('app', 'screen.say')).toEqual([]);
  });

  it("the echo guard relays: a screen's playback report reaches mics as screen.speech; a mic's stop reaches screens", async () => {
    const { tv, phone } = await pair();
    tv.send({ type: 'app', topic: 'screen.say.status', payload: { id: 'say_x', state: 'playing', at: Date.now(), text: 'hi there' } });
    expect((await phone.next('app', 'screen.speech')).payload).toMatchObject({ id: 'say_x', state: 'playing', text: 'hi there' });
    // An invalid report is not relayed.
    tv.send({ type: 'app', topic: 'screen.say.status', payload: { id: 'say_y', state: 'exploded', at: Date.now() } });
    phone.send({ type: 'app', topic: 'screen.say.stop', payload: { id: 'say_x', reason: 'barge-in' } });
    expect(await tv.next('app', 'screen.say.stop')).toMatchObject({ payload: { id: 'say_x', reason: 'barge-in' }, from: id('phone') });
    await sleep(100);
    expect(phone.seen('app', 'screen.speech').filter((m) => (m.payload as { id?: string }).id === 'say_y')).toEqual([]);
  });

  it('role rules: a mic may not ack, a screen may not send transcripts, nobody may send hub messages (not-allowed)', async () => {
    const { tv, phone } = await pair();
    phone.send({ type: 'ack', utteranceId: 'u', stage: 'rendered', hops: [] });
    expect(await phone.next('error')).toMatchObject({ code: 'not-allowed' });
    tv.send({ type: 'transcript.final', utteranceId: 'u', text: 'x', hops: [] });
    expect(await tv.next('error')).toMatchObject({ code: 'not-allowed' });
    phone.send({ type: 'intent', utteranceId: 'u', name: 'x', ok: true, payload: null, hops: [] });
    expect(await phone.next('error')).toMatchObject({ code: 'not-allowed' });
  });

  it('a clientId held by a live connection is refused without its resumeToken (id-in-use), and taken with it', async () => {
    const holder = await raw();
    holder.send({ type: 'hello', v: 1, role: 'screen', clientId: id('tv_id'), resumeToken: `secret_${run}` });
    const code = String((await holder.next('welcome')).code);
    const thief = await raw();
    thief.send({ type: 'hello', v: 1, role: 'screen', clientId: id('tv_id'), code, resumeToken: 'guess' });
    expect(await thief.next()).toMatchObject({ type: 'error', code: 'id-in-use' });
    const owner = await raw();
    owner.send({ type: 'hello', v: 1, role: 'screen', clientId: id('tv_id'), code, resumeToken: `secret_${run}` });
    expect(await owner.next('welcome')).toMatchObject({ code });
  });
});

// ./phone with a scripted recognizer in place of Web Speech, against a real in-process hub: pairing sugar,
// throttled partials, finals with speech.start / speech.end hops, continuous restarts, clear errors, and the echo
// guard (the TV's own voice never comes back as a transcript), including barge-in.
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHub, type Room } from '../src/hub.js';
import { BridgeClient, type AppMsg, type FinalMsg, type PartialMsg } from '../src/index.js';
import {
  EchoGuard,
  codeFromPath,
  connectPhone,
  createPhoneMic,
  echoOverlap,
  hubUrlFromLocation,
  isEcho,
  type PhoneMic,
  type PhoneMicError,
  type PhoneMicOptions,
} from '../src/phone.js';
import { ScriptedRecognizer } from './helpers/recognizer.js';

let server: Server;
let hub: BridgeHub;
let url: string;
let room: Room;
let tv: BridgeClient;
let phone: BridgeClient;
let appSeen: AppMsg[];
const cleanups: Array<() => unknown> = [];
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  ScriptedRecognizer.all = [];
  appSeen = [];
  server = createServer();
  hub = new BridgeHub({ server, onFinal: (_r, m) => ({ name: 'heard', ok: true, payload: { text: m.text } }), onApp: (_r, m) => void appSeen.push(m) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws`;
  tv = new BridgeClient({ url, role: 'screen', reconnect: false });
  const { code } = await tv.connect();
  room = hub.rooms.get(code)!;
  phone = new BridgeClient({ url, role: 'mic', code, reconnect: false });
  await phone.connect();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const c of cleanups.splice(0).reverse()) await c();
  tv.close();
  phone.close();
  hub.close();
  await new Promise((r) => server.close(r));
});

function mic(opts: Partial<PhoneMicOptions> = {}): PhoneMic {
  const m = createPhoneMic({ client: phone, recognizer: () => new ScriptedRecognizer(), secureContext: true, ...opts });
  cleanups.push(() => m.dispose());
  return m;
}

/** What the TV received. */
function tvLog() {
  const partials: string[] = [];
  const finals: FinalMsg[] = [];
  tv.on('transcript.partial', (m: PartialMsg) => partials.push(m.text));
  tv.on('transcript.final', (m) => finals.push(m));
  return { partials, finals };
}

describe('pairing sugar', () => {
  it('codeFromPath reads the last path segment and normalizes it', () => {
    expect(codeFromPath('/p/k7qf')).toBe('K7QF');
    expect(codeFromPath('/p/K7QF/')).toBe('K7QF');
    expect(codeFromPath('/join/k7-qf')).toBe('K7QF');
    expect(codeFromPath('/p/%20k7qf')).toBe('K7QF');
    expect(codeFromPath('/p/ZZ')).toBeNull();
    expect(codeFromPath('/p/K0QF')).toBeNull(); // 0 is not in the alphabet
    expect(codeFromPath('/')).toBeNull();
    expect(codeFromPath('/p/%E0%A4%A')).toBeNull();
  });

  it('hubUrlFromLocation picks ws or wss from the page', () => {
    expect(hubUrlFromLocation({ protocol: 'https:', host: 'tv.example:8443', pathname: '/' })).toBe('wss://tv.example:8443/ws');
    expect(hubUrlFromLocation({ protocol: 'http:', host: '192.168.1.20:8800', pathname: '/' })).toBe('ws://192.168.1.20:8800/ws');
  });

  it('connectPhone joins from the page location alone, and refuses without a code', async () => {
    const port = new URL(url).port;
    vi.stubGlobal('location', { protocol: 'http:', host: `127.0.0.1:${port}`, pathname: `/p/${room.code.toLowerCase()}` });
    const c = connectPhone({ reconnect: false });
    cleanups.push(() => c.close());
    expect(c.code).toBe(room.code);
    await vi.waitFor(() => expect(c.status).toBe('open'));
    vi.stubGlobal('location', { protocol: 'http:', host: `127.0.0.1:${port}`, pathname: '/' });
    expect(() => connectPhone()).toThrow(/no pairing code/);
    const onError = vi.fn();
    const wrong = connectPhone({ url, code: 'ZZZZ', reconnect: false, onError });
    cleanups.push(() => wrong.close());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/unknown-code/) })));
  });
});

describe('createPhoneMic: transcripts', () => {
  it('a final heard while the link is down is reported as dropped (not-connected), never as sent', async () => {
    const m = mic({ echoGuard: false });
    const finals: string[] = [];
    const dropped: string[] = [];
    m.on('final', (f) => finals.push(f.text));
    m.on('dropped', (d) => dropped.push(`${d.reason}:${d.text}`));
    phone.close(); // the link drops (a hub restart, a Wi-Fi blip)
    m.start();
    const r = ScriptedRecognizer.last;
    r.hear('add ten pounds');
    r.final('add ten pounds');
    r.end();
    await vi.waitFor(() => expect(dropped).toEqual(['not-connected:add ten pounds']));
    expect(finals).toEqual([]);
  });
  it('throttles partials, then sends the final with speech.start and speech.end hops', async () => {
    const log = tvLog();
    const m = mic({ partialEveryMs: 60, echoGuard: false });
    expect(m.start()).toBe(true);
    expect(m.state).toBe('listening');
    const r = ScriptedRecognizer.last;
    expect(r).toMatchObject({ continuous: false, interimResults: true });
    r.onspeechstart?.({});
    for (const t of ['six', 'six with', 'six with ten', 'six with ten pou']) r.hear(t);
    await settle(100);
    r.hear('six with ten pounds');
    await settle(10);
    r.onspeechend?.({});
    await settle(30);
    r.final('six with ten pounds');
    r.end();
    await vi.waitFor(() => expect(log.finals).toHaveLength(1));
    expect(log.partials[0]).toBe('six');
    expect(log.partials).toContain('six with ten pou'); // the trailing edge carries the latest text
    expect(log.partials.length).toBeLessThanOrEqual(3);
    const hops = log.finals[0]!.hops;
    expect(hops.map((x) => x.hop)).toEqual(['speech.start', 'speech.end', 'mic.send', 'hub.recv']);
    const at = Object.fromEntries(hops.map((x) => [x.hop, x.at]));
    expect(at['speech.end']! - at['speech.start']!).toBeGreaterThanOrEqual(100);
    expect(at['mic.send']! - at['speech.end']!).toBeGreaterThanOrEqual(25); // the recognizer's tail, measured
    expect(m.state).toBe('idle');
  });

  it('speech.end falls back to the last interim change when the recognizer has no speechend event', async () => {
    const log = tvLog();
    const m = mic({ echoGuard: false });
    const finals: Array<{ speechEndAt: number }> = [];
    m.on('final', (f) => finals.push(f));
    m.start();
    const r = ScriptedRecognizer.last;
    r.hear('hello');
    const changed = performance.timeOrigin + performance.now();
    await settle(60);
    r.final('hello');
    await vi.waitFor(() => expect(log.finals).toHaveLength(1));
    expect(Math.abs(finals[0]!.speechEndAt - changed)).toBeLessThan(15);
  });

  it('a final the recognizer delivers again is sent once', async () => {
    const log = tvLog();
    const m = mic({ mode: 'continuous', echoGuard: false });
    const finals: string[] = [];
    m.on('final', (f) => finals.push(f.text));
    m.start();
    const r = ScriptedRecognizer.last;
    r.final('add ten pounds');
    r.hear('and rest');
    r.redeliver(0); // the earlier final again, alongside the open result
    r.final('and rest');
    r.redeliver(0);
    await vi.waitFor(() => expect(log.finals).toHaveLength(2));
    await settle();
    expect(log.finals.map((f) => f.text)).toEqual(['add ten pounds', 'and rest']);
    expect(finals).toEqual(['add ten pounds', 'and rest']);
  });

  it('continuous mode restarts sessions the browser ends, until stop()', async () => {
    const m = mic({ mode: 'continuous', restartDelayMs: 20, echoGuard: false });
    m.start();
    expect(ScriptedRecognizer.last.continuous).toBe(true);
    ScriptedRecognizer.last.end(); // e.g. iOS Safari ending the session
    await vi.waitFor(() => expect(ScriptedRecognizer.all).toHaveLength(2));
    expect(ScriptedRecognizer.last.running).toBe(true);
    m.stop();
    await settle(80);
    expect(ScriptedRecognizer.all).toHaveLength(2);
    expect(m.state).toBe('idle');
  });

  it('clear errors: no support, not https, permission denied (fatal); no speech (not fatal)', () => {
    const errors: PhoneMicError[] = [];
    const none = createPhoneMic({ client: phone, recognizer: undefined, secureContext: true });
    vi.stubGlobal('SpeechRecognition', undefined);
    none.on('error', (e) => errors.push(e));
    expect(none.supported).toBe(false);
    expect(none.start()).toBe(false);
    const insecure = mic({ secureContext: false });
    insecure.on('error', (e) => errors.push(e));
    expect(insecure.start()).toBe(false);
    const denied = mic();
    denied.on('error', (e) => errors.push(e));
    denied.start();
    ScriptedRecognizer.last.error('no-speech');
    expect(denied.state).toBe('listening');
    ScriptedRecognizer.last.error('not-allowed');
    expect(denied.state).toBe('error');
    expect(errors.map((e) => [e.code, e.fatal])).toEqual([
      ['no-support', true],
      ['insecure-context', true],
      ['no-speech', false],
      ['permission-denied', true],
    ]);
    expect(errors[1]!.message).toMatch(/https/);
    none.dispose();
  });

  it('uses the platform SpeechRecognition (or webkitSpeechRecognition) when no recognizer is given', () => {
    vi.stubGlobal('webkitSpeechRecognition', ScriptedRecognizer);
    const m = createPhoneMic({ client: phone, secureContext: true, lang: 'en-GB' });
    cleanups.push(() => m.dispose());
    expect(m.supported).toBe(true);
    m.start();
    expect(ScriptedRecognizer.last.lang).toBe('en-GB');
  });
});

describe('echo guard', () => {
  const LINE = 'Rest two minutes, then do your last set';

  it('drops what the mic hears from queued until ended + tail, then lets the user through', async () => {
    const log = tvLog();
    const m = mic({ mode: 'continuous', echoGuard: { tailMs: 50 } });
    const dropped: string[] = [];
    const guard: boolean[] = [];
    m.on('dropped', (d) => dropped.push(`${d.reason}:${d.text}`));
    m.on('guard', (g) => guard.push(g));
    m.start();
    const r = ScriptedRecognizer.last;

    hub.say(room, { id: 'say_1', text: LINE, durationMs: 5000 });
    await vi.waitFor(() => expect(m.guarded).toBe(true));
    expect(m.state).toBe('guarded');
    r.hear('rest two');
    r.hear('rest two minutes then do');
    tv.reportSay({ id: 'say_1', state: 'playing' });
    r.final('rest two minutes then do your last set');
    tv.reportSay({ id: 'say_1', state: 'ended' });
    await vi.waitFor(() => expect(m.guarded).toBe(false));
    expect(m.state).toBe('listening');

    r.hear('six with');
    r.final('six with ten pounds');
    await vi.waitFor(() => expect(log.finals.map((f) => f.text)).toEqual(['six with ten pounds']));
    expect(log.partials.every((p) => p.startsWith('six'))).toBe(true); // no TV words reached the screen
    expect(dropped).toEqual(['echo:rest two minutes then do your last set']);
    expect(guard).toEqual([true, false]);
  });

  it('a late echo (the TV\'s words, just after the line) is dropped by text match; unrelated short replies are not', async () => {
    const log = tvLog();
    const m = mic({ mode: 'continuous', echoGuard: { tailMs: 10 } });
    const dropped: string[] = [];
    m.on('dropped', (d) => dropped.push(d.reason));
    m.start();
    const r = ScriptedRecognizer.last;
    hub.say(room, { id: 'say_2', text: LINE });
    tv.reportSay({ id: 'say_2', state: 'ended' });
    await vi.waitFor(() => expect(m.guarded).toBe(false));
    await settle(30);
    r.final('then do your last set');
    r.final('yes');
    await vi.waitFor(() => expect(log.finals.map((f) => f.text)).toEqual(['yes']));
    expect(dropped).toEqual(['echo-text']);
  });

  it('caption-only lines (no-audio) do not hold the mic', async () => {
    const log = tvLog();
    const m = mic({ echoGuard: { tailMs: 1000 } });
    m.start();
    hub.say(room, { id: 'say_3', text: 'Logged.' });
    await vi.waitFor(() => expect(m.guarded).toBe(true));
    tv.reportSay({ id: 'say_3', state: 'no-audio' });
    await vi.waitFor(() => expect(m.guarded).toBe(false));
    ScriptedRecognizer.last.final('next set');
    await vi.waitFor(() => expect(log.finals).toHaveLength(1));
  });

  it('pause mode aborts the recognizer while the TV talks and restarts it after', async () => {
    const m = mic({ mode: 'continuous', echoGuard: { mode: 'pause', tailMs: 10 } });
    m.start();
    const first = ScriptedRecognizer.last;
    hub.say(room, { id: 'say_4', text: LINE });
    await vi.waitFor(() => expect(first.aborted).toBe(true));
    expect(m.state).toBe('guarded');
    tv.reportSay({ id: 'say_4', state: 'ended' });
    await vi.waitFor(() => expect(ScriptedRecognizer.all).toHaveLength(2));
    expect(ScriptedRecognizer.last.running).toBe(true);
    expect(m.state).toBe('listening');
  });

  it('echoGuard: false sends everything', async () => {
    const log = tvLog();
    const m = mic({ echoGuard: false });
    m.start();
    hub.say(room, { id: 'say_5', text: LINE });
    await settle();
    ScriptedRecognizer.last.final('rest two minutes');
    await vi.waitFor(() => expect(log.finals).toHaveLength(1));
  });
});

describe('barge-in', () => {
  const LINE = 'Here is a long answer about your training plan for the week';

  /** A plain screen that honours screen.say.stop by reporting the line interrupted. */
  function honourStops() {
    const stops: Array<{ id?: string; reason?: string; from?: string }> = [];
    tv.onSayStop((s) => {
      stops.push(s);
      if (s.id) tv.reportSay({ id: s.id, state: 'interrupted' });
    });
    return stops;
  }

  it('the user talking over the TV stops it, and what they said is kept; the TV\'s own words are not a barge-in', async () => {
    const stops = honourStops();
    const log = tvLog();
    const m = mic({ mode: 'continuous', echoGuard: { bargeIn: true, tailMs: 20 } });
    const barged: string[][] = [];
    m.on('bargeIn', (b) => barged.push(b.ids));
    m.start();
    const r = ScriptedRecognizer.last;
    hub.say(room, { id: 'say_b', text: LINE });
    tv.reportSay({ id: 'say_b', state: 'playing', text: LINE });
    await vi.waitFor(() => expect(m.guarded).toBe(true));

    r.final('here is a long answer'); // the TV, heard by the phone
    r.hear('wait');
    r.hear('wait stop');
    await vi.waitFor(() => expect(stops).toHaveLength(1));
    expect(stops[0]).toEqual({ id: 'say_b', reason: 'barge-in', from: phone.clientId });
    expect(barged).toEqual([['say_b']]);
    expect(m.guarded).toBe(false);
    r.final('wait stop I have a question');
    await vi.waitFor(() => expect(log.finals.map((f) => f.text)).toEqual(['wait stop I have a question']));
    expect(log.partials).toEqual(['wait stop']);
    // The screen's "interrupted" report for the released line cannot re-arm the guard.
    await settle(60);
    expect(m.guarded).toBe(false);
  });

  it('without the TV\'s words (an older screen) there is no automatic barge-in', async () => {
    const stops = honourStops();
    const m = mic({ mode: 'continuous', echoGuard: { bargeIn: true } });
    m.start();
    tv.reportSay({ id: 'local_1', state: 'playing' }); // a line the TV started itself, reported without text
    await vi.waitFor(() => expect(m.guarded).toBe(true));
    ScriptedRecognizer.last.hear('anything at all');
    await settle(60);
    expect(stops).toHaveLength(0);
  });

  it('push-to-talk: pressing while the TV talks is a barge-in; interrupt() is a stop button', async () => {
    const stops = honourStops();
    const m = mic({ echoGuard: { bargeIn: true } });
    hub.say(room, { id: 'say_p', text: LINE });
    await vi.waitFor(() => expect(m.guarded).toBe(true));
    m.start();
    await vi.waitFor(() => expect(stops.map((s) => s.reason)).toEqual(['barge-in']));
    expect(m.guarded).toBe(false);
    m.interrupt();
    await vi.waitFor(() => expect(stops.map((s) => s.reason)).toEqual(['barge-in', 'user']));
  });
});

describe('EchoGuard (clocked)', () => {
  it('queued without any report holds for the duration plus slack; playing then ended releases after the tail', () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const g = new EchoGuard({ tailMs: 500, now: () => Date.now(), onChange: (a) => changes.push(a) });
    g.notice({ id: 'a', state: 'queued', durationMs: 2000 });
    expect(g.active).toBe(true);
    vi.advanceTimersByTime(3400);
    expect(g.active).toBe(true);
    vi.advanceTimersByTime(200); // 2000 + 1000 + 500
    expect(g.active).toBe(false);
    g.notice({ id: 'b', state: 'queued' });
    g.notice({ id: 'b', state: 'playing' });
    vi.advanceTimersByTime(19_000);
    expect(g.active).toBe(true); // playing with no duration: held until a final state (or maxHoldMs)
    g.notice({ id: 'b', state: 'ended' });
    vi.advanceTimersByTime(499);
    expect(g.active).toBe(true);
    vi.advanceTimersByTime(2);
    expect(g.active).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
    g.dispose();
  });

  it('caps a line that never ends at maxHoldMs; release() cannot be undone by later notices', () => {
    vi.useFakeTimers();
    const g = new EchoGuard({ tailMs: 100, maxHoldMs: 5000, now: () => Date.now() });
    g.notice({ id: 'a', state: 'loading' });
    vi.advanceTimersByTime(5001);
    expect(g.active).toBe(false);
    g.notice({ id: 'c', state: 'playing', text: 'hello there' });
    expect(g.holding).toEqual(['c']);
    expect(g.release()).toEqual(['c']);
    g.notice({ id: 'c', state: 'playing' });
    expect(g.active).toBe(false);
    expect(g.recentText()).toEqual(['hello there']);
    vi.advanceTimersByTime(4001);
    expect(g.recentText()).toEqual([]);
    g.dispose();
  });

  it('echo matching ignores case, accents and punctuation, and needs three words unless it is the whole line', () => {
    expect(isEcho('Rest two minutes', 'Rest two minutes.')).toBe(true);
    expect(isEcho('then do your last set', 'Rest two minutes, then do your last set')).toBe(true);
    expect(isEcho('café olé ok', 'Cafe ole OK!')).toBe(true);
    expect(isEcho('yes', 'Say yes or no')).toBe(false);
    expect(isEcho('my last set', 'Rest two minutes, then do your last set')).toBe(false);
    expect(echoOverlap('wait stop', 'Here is a long answer')).toBe(0);
    expect(echoOverlap('', 'x')).toBe(0);
  });
});

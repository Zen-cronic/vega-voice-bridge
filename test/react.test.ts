// ./react against a real in-process hub: the hook's state transitions, ack-after-render hops, the say queue and
// its playback reports, callback refs, cleanup, and <PairingQr>'s runs (react-native is a mock with host components).
import { createServer, type Server } from 'node:http';
import jsqr from 'jsqr';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHub } from '../src/hub.js';
import { BridgeClient, localNow, type AckMsg, type IntentMsg, type SayStatus } from '../src/index.js';
import { createPhoneMic } from '../src/phone.js';
import { qrMatrix, qrRuns } from '../src/qr.js';
import { ScriptedRecognizer } from './helpers/recognizer.js';
import { PairingQr, SayQueue, pairingQrLayout, useVoiceBridge, voiceBridgeStatus, type SayLine, type SayPlayer, type UseVoiceBridgeOptions, type VoiceBridge } from '../src/react.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const jsQR = ((jsqr as unknown as { default?: unknown }).default ?? jsqr) as typeof jsqr.default;
const h = React.createElement;

let server: Server;
let hub: BridgeHub;
let url: string;
let statuses: SayStatus[];
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
  statuses = [];
  server = createServer();
  hub = new BridgeHub({
    server,
    joinUrl: (code) => `http://lan.example:8800/p/${code}`,
    onFinal: (_room, msg) => ({ name: 'echo', ok: true, payload: { text: msg.text } }),
    onApp: (_room, msg) => {
      if (msg.topic === 'screen.say.status') statuses.push(msg.payload as SayStatus);
      return null;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws`;
});

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  hub.close();
  await new Promise((r) => server.close(r));
});

/** Render a component that only runs the hook, and expose its latest return value. */
function mount(opts: UseVoiceBridgeOptions) {
  const seen: { current: VoiceBridge } = { current: null as unknown as VoiceBridge };
  let renders = 0;
  function Probe(props: { opts: UseVoiceBridgeOptions }) {
    renders++;
    seen.current = useVoiceBridge(props.opts);
    return null;
  }
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(h(Probe, { opts }));
  });
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => r.unmount());
  };
  cleanups.push(unmount);
  return { seen, renders: () => renders, rerender: (o: UseVoiceBridgeOptions) => act(() => r.update(h(Probe, { opts: o }))), unmount };
}

/** Let real sockets and timers run (inside act) until `fn` returns something truthy. */
async function until<T>(fn: () => T, ms = 3000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${fn.toString().slice(0, 120)}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

function phone(code: string) {
  const c = new BridgeClient({ url, role: 'mic', code, reconnect: false });
  cleanups.push(() => c.close());
  return c;
}

describe('useVoiceBridge', () => {
  it('status: connecting -> waiting-for-phone -> paired -> waiting-for-phone, with the code and join URL', async () => {
    const tv = mount({ url, reconnect: false });
    expect(tv.seen.current.status).toBe('connecting');
    const code = await until(() => tv.seen.current.code);
    expect(tv.seen.current.status).toBe('waiting-for-phone');
    expect(tv.seen.current.joinUrl).toBe(`http://lan.example:8800/p/${code}`);
    const p = phone(code);
    await act(async () => void (await p.connect()));
    await until(() => tv.seen.current.status === 'paired');
    expect(tv.seen.current.mics).toBe(1);
    expect(tv.seen.current.peers).toHaveLength(2);
    p.close();
    await until(() => tv.seen.current.status === 'waiting-for-phone');
    expect(tv.seen.current.mics).toBe(0);
  });

  it('partial -> final -> intent; the ack is stamped after the render, so the phone gets the whole hop chain', async () => {
    const onIntent = vi.fn();
    const tv = mount({ url, reconnect: false, onIntent });
    const code = await until(() => tv.seen.current.code);
    const p = phone(code);
    await act(async () => void (await p.connect()));
    p.sendPartial('six with', 'u1');
    await until(() => tv.seen.current.partial === 'six with');
    const ack = new Promise<AckMsg>((r) => p.on('ack', r));
    p.sendFinal('six with ten pounds', { utteranceId: 'u1', speechEndAt: localNow() });
    const intent = await until(() => tv.seen.current.intent);
    expect(intent).toMatchObject({ utteranceId: 'u1', name: 'echo', payload: { text: 'six with ten pounds' } });
    expect(tv.seen.current.final?.text).toBe('six with ten pounds');
    expect(tv.seen.current.partial).toBeNull();
    expect(onIntent).toHaveBeenCalledTimes(1);
    let got: AckMsg | undefined;
    void ack.then((a) => (got = a));
    await until(() => got);
    expect(got!.hops.map((x) => x.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv', 'hub.intent', 'screen.recv', 'screen.render', 'hub.ack']);
    const at = Object.fromEntries(got!.hops.map((x) => [x.hop, x.at]));
    expect(at['screen.render']!).toBeGreaterThanOrEqual(at['screen.recv']!);
  });

  it('autoAck: false leaves the ack to the app (ack(intent) keeps the receive time)', async () => {
    const tv = mount({ url, reconnect: false, autoAck: false });
    const code = await until(() => tv.seen.current.code);
    const p = phone(code);
    await act(async () => void (await p.connect()));
    const acks: AckMsg[] = [];
    p.on('ack', (a) => acks.push(a));
    p.sendFinal('hello');
    const intent = await until(() => tv.seen.current.intent);
    await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
    expect(acks).toHaveLength(0);
    tv.seen.current.ack(intent);
    await until(() => acks.length === 1);
    expect(acks[0]!.hops.map((x) => x.hop)).toContain('screen.recv');
  });

  it('say lines: captions only by default (no-audio); a player reports loading -> playing -> ended', async () => {
    const tv = mount({ url, reconnect: false });
    const code = await until(() => tv.seen.current.code);
    const room = hub.rooms.get(code)!;
    hub.say(room, { id: 's1', text: 'Logged.', durationMs: 60 });
    await until(() => tv.seen.current.saying?.line.id === 's1');
    expect(tv.seen.current.saying?.state).toBe('no-audio');
    await until(() => tv.seen.current.saying === null);
    await until(() => statuses.length === 1);
    expect(statuses[0]).toMatchObject({ id: 's1', state: 'no-audio' });

    const controls: Array<{ line: SayLine; ctl: Parameters<SayPlayer>[1] }> = [];
    const player: SayPlayer = (line, ctl) => void controls.push({ line, ctl });
    tv.rerender({ url, reconnect: false, player });
    hub.say(room, { id: 's2', text: 'Rest two minutes.' });
    await until(() => controls.length === 1);
    expect(tv.seen.current.saying).toMatchObject({ line: { id: 's2' }, state: 'loading' });
    act(() => controls[0]!.ctl.playing());
    expect(tv.seen.current.saying?.state).toBe('playing');
    act(() => controls[0]!.ctl.ended());
    expect(tv.seen.current.saying).toBeNull();
    await until(() => statuses.length === 4);
    expect(statuses.slice(1).map((s) => `${s.id}:${s.state}`)).toEqual(['s2:loading', 's2:playing', 's2:ended']);
  });

  it('a high-priority line interrupts the current one and clears the queue; stopSay() stops everything', async () => {
    const stops: string[] = [];
    const started: string[] = [];
    const player: SayPlayer = (line) => {
      started.push(line.id);
      return () => stops.push(line.id);
    };
    const tv = mount({ url, reconnect: false, player });
    const code = await until(() => tv.seen.current.code);
    const room = hub.rooms.get(code)!;
    hub.say(room, { id: 'a', text: 'one' });
    hub.say(room, { id: 'b', text: 'two' });
    await until(() => started.length === 1);
    hub.say(room, { id: 'c', text: 'urgent', priority: 'high' });
    await until(() => started.length === 2);
    expect(started).toEqual(['a', 'c']);
    expect(stops).toEqual(['a']);
    act(() => tv.seen.current.stopSay());
    expect(stops).toEqual(['a', 'c']);
    await until(() => statuses.filter((s) => s.state === 'interrupted').length === 3);
    expect(statuses.filter((s) => s.state === 'interrupted').map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('say() on the TV goes through the same queue and is reported to the hub', async () => {
    const played: string[] = [];
    const tv = mount({ url, reconnect: false, player: (line, ctl) => (played.push(line.text), ctl.playing(), ctl.ended()) });
    await until(() => tv.seen.current.code);
    let id = '';
    act(() => void (id = tv.seen.current.say('Welcome back.')));
    expect(played).toEqual(['Welcome back.']);
    await until(() => statuses.length === 3);
    expect(statuses.map((s) => `${s.id}:${s.state}`)).toEqual([`${id}:loading`, `${id}:playing`, `${id}:ended`]);
    for (const s of statuses) expect(typeof s.at).toBe('number');
  });

  it('end to end with ./phone: the mic stays quiet while the hook plays a line, and barging in stops it', async () => {
    const stopped: string[] = [];
    const player: SayPlayer = (line, ctl) => {
      ctl.playing();
      return () => stopped.push(line.id);
    };
    const tv = mount({ url, reconnect: false, player });
    const code = await until(() => tv.seen.current.code);
    const p = phone(code);
    await act(async () => void (await p.connect()));
    const mic = createPhoneMic({ client: p, mode: 'continuous', recognizer: () => new ScriptedRecognizer(), secureContext: true, echoGuard: { bargeIn: true } });
    cleanups.push(() => mic.dispose());
    mic.start();
    const rec = ScriptedRecognizer.last;
    hub.say(hub.rooms.get(code)!, { id: 'long_1', text: 'Here is everything I know about interval training' });
    await until(() => tv.seen.current.saying?.state === 'playing' && mic.guarded);
    rec.final('everything I know about interval training'); // the TV, heard by the phone: dropped
    rec.hear('hold on');
    await until(() => stopped.length === 1);
    expect(stopped).toEqual(['long_1']);
    expect(tv.seen.current.saying).toBeNull();
    rec.final('hold on what about rest days');
    await until(() => tv.seen.current.final?.text === 'hold on what about rest days');
    await until(() => statuses.some((s) => s.state === 'interrupted'));
    expect(statuses.map((s) => `${s.id}:${s.state}`)).toEqual(['long_1:loading', 'long_1:playing', 'long_1:interrupted']);
    expect(statuses[1]!.text).toBe('Here is everything I know about interval training');
  });

  it('callbacks come from the latest render: swapping onIntent neither reconnects nor calls the old one', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const tv = mount({ url, reconnect: false, onIntent: first });
    const code = await until(() => tv.seen.current.code);
    const clientBefore = tv.seen.current.client;
    tv.rerender({ url, reconnect: false, onIntent: second });
    expect(tv.seen.current.client).toBe(clientBefore);
    const p = phone(code);
    await act(async () => void (await p.connect()));
    p.sendFinal('hi');
    await until(() => second.mock.calls.length === 1);
    expect(first).not.toHaveBeenCalled();
    expect(tv.seen.current.code).toBe(code);
  });

  it('a new code reconnects into that room; unmount closes the connection and the phone sees the TV leave', async () => {
    const tv = mount({ url, reconnect: false });
    await until(() => tv.seen.current.code);
    tv.rerender({ url, reconnect: false, code: 'K7QF' });
    await until(() => tv.seen.current.code === 'K7QF');
    const p = phone('K7QF');
    await act(async () => void (await p.connect()));
    const left = new Promise<number>((r) => p.on('peers', (m) => r(m.peers.length)));
    const client = tv.seen.current.client!;
    tv.unmount();
    expect(client.status).toBe('closed');
    expect(await left).toBe(1);
  });

  it('reports reconnecting while the hub is unreachable', async () => {
    const tv = mount({ url, reconnect: { minDelayMs: 20, maxDelayMs: 50 } });
    await until(() => tv.seen.current.status === 'waiting-for-phone');
    hub.close();
    await until(() => tv.seen.current.status === 'reconnecting');
  });

  it('voiceBridgeStatus maps every connection status', () => {
    const mic = [{ clientId: 'm', role: 'mic' as const }];
    expect(voiceBridgeStatus('idle', [])).toBe('connecting');
    expect(voiceBridgeStatus('connecting', [])).toBe('connecting');
    expect(voiceBridgeStatus('open', [])).toBe('waiting-for-phone');
    expect(voiceBridgeStatus('open', mic)).toBe('paired');
    expect(voiceBridgeStatus('reconnecting', mic)).toBe('reconnecting');
    expect(voiceBridgeStatus('repair', [])).toBe('closed');
    expect(voiceBridgeStatus('closed', mic)).toBe('closed');
  });
});

describe('SayQueue', () => {
  it('queues normal lines in order and reports a player that throws as an error', () => {
    const log: string[] = [];
    const q = new SayQueue({
      player: () => (line, ctl) => {
        if (line.id === 'bad') throw new Error('decoder missing');
        ctl.playing();
        ctl.ended();
      },
      report: (line, state, detail) => log.push(`${line.id}:${state}${detail ? `(${detail})` : ''}`),
      show: () => undefined,
    });
    const line = (id: string): SayLine => ({ id, text: id, audioUrl: '', durationMs: 10, priority: 'normal' });
    q.push(line('a'));
    q.push(line('bad'));
    q.push(line('c'));
    expect(log).toEqual(['a:loading', 'a:playing', 'a:ended', 'bad:loading', 'bad:error(decoder missing)', 'c:loading', 'c:playing', 'c:ended']);
    q.dispose();
    q.push(line('late'));
    expect(log).toHaveLength(8);
  });
});

describe('<PairingQr>', () => {
  const value = 'http://192.168.1.20:8800/p/K7QF';
  const render = (props: Parameters<typeof PairingQr>[0]) => {
    let r!: ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(h(PairingQr, props));
    });
    cleanups.push(() => act(() => r.unmount()));
    return r;
  };
  type Style = { left: number; top: number; width: number; height: number; backgroundColor: string };

  it('draws one View per horizontal run, which together reproduce the matrix inside a quiet zone', () => {
    const r = render({ value, size: 300 });
    const root = r.root.findByProps({ testID: 'pairing-qr' });
    const m = qrMatrix(value);
    const { cell, side, offset } = pairingQrLayout(m, 300, 4);
    expect(cell).toBe(Math.floor(300 / (m.size + 8)));
    expect(side).toBeLessThanOrEqual(300);
    expect((root.props.style as Array<{ width: number }>)[0]!.width).toBe(side);
    const runs = root.children as ReactTestInstance[];
    expect(runs).toHaveLength(qrRuns(m).length);
    expect(runs.length).toBeLessThan(m.modules.flat().filter(Boolean).length); // merged, not one View per module
    const grid = m.modules.map((row) => row.map(() => false));
    for (const run of runs) {
      expect(run.type).toBe('View');
      const s = run.props.style as Style;
      expect(s.height).toBe(cell);
      const x0 = (s.left - offset) / cell;
      const y = (s.top - offset) / cell;
      expect(Number.isInteger(x0) && Number.isInteger(y)).toBe(true);
      for (let x = x0; x < x0 + s.width / cell; x++) grid[y]![x] = true;
    }
    expect(grid).toEqual(m.modules);
  });

  it('what it draws decodes back to the value', () => {
    const r = render({ value, size: 200, ecc: 'Q', dark: '#111111', light: '#fafafa' });
    const root = r.root.findByProps({ testID: 'pairing-qr' });
    const side = (root.props.style as Array<{ width: number }>)[0]!.width;
    const px = new Uint8ClampedArray(side * side * 4).fill(250);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    for (const run of root.children as ReactTestInstance[]) {
      const s = run.props.style as Style;
      expect(s.backgroundColor).toBe('#111111');
      for (let y = s.top; y < s.top + s.height; y++)
        for (let x = s.left; x < s.left + s.width; x++) px.fill(17, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
    expect(jsQR(px, side, side)?.data).toBe(value);
  });

  it('takes a testID and an accessibility label; a value too long to encode renders the empty square', () => {
    const r = render({ value: 'x'.repeat(5000), testID: 'join-qr', accessibilityLabel: 'Scan to join' });
    const root = r.root.find((n) => (n.type as unknown) === 'View' && n.props.testID === 'join-qr');
    expect(root.props.accessibilityLabel).toBe('Scan to join');
    expect(root.children).toHaveLength(0);
  });
});

/**
 * React bindings for the TV (screen) side, with no native dependencies: they run on React Native for Vega,
 * react-native-web and any other React Native target. `react` and `react-native` are optional peer dependencies;
 * only this subpath imports them.
 *
 * - `useVoiceBridge(options)` connects a screen, tracks pairing, live captions, finals and intents, plays
 *   `screen.say` lines through your player and reports their playback, and acks each intent after the frame that
 *   shows it, so the latency model measures what the viewer saw.
 * - `<PairingQr value />` draws the join URL as a QR code from plain `View`s (one per horizontal run of modules).
 */
import React from 'react';
import { View } from 'react-native';
import { BridgeClient, localNow, type ClientOptions, type ConnectionStatus } from './client.js';
import {
  SAY_TOPIC,
  newId,
  parseSay,
  type FinalMsg,
  type IntentMsg,
  type PartialMsg,
  type PeerInfo,
  type SayPayload,
  type SayState,
  type WelcomeMsg,
} from './protocol.js';
import { qrMatrix, qrRuns, type QrEcc, type QrMatrix } from './qr.js';

const { createElement, useCallback, useEffect, useMemo, useRef, useState } = React;

/** What the TV shows about the link: `paired` once at least one phone (mic) is in the room. */
export type VoiceBridgeStatus = 'connecting' | 'waiting-for-phone' | 'paired' | 'reconnecting' | 'closed';

export type SayLine = Required<SayPayload>;

/** Handed to a `SayPlayer` for one line. Calls for a line that was interrupted are ignored. */
export interface SayControls {
  /** Sound has actually started (reported as `playing`). */
  playing(): void;
  /** The line finished (reported as `ended`); the next queued line starts. */
  ended(): void;
  /** Playback failed (reported as `error`); the next queued line starts. */
  error(detail?: string): void;
}

/**
 * Plays one line: start the audio (`line.audioUrl`) or a local TTS of `line.text`, call `ctl.playing()` when
 * sound starts and `ctl.ended()` when it stops. Return a function that stops playback; it is called when a
 * `high` priority line or `stopSay()` interrupts this one.
 */
export type SayPlayer = (line: SayLine, ctl: SayControls) => (() => void) | void;

export interface UseVoiceBridgeOptions extends Omit<ClientOptions, 'role' | 'code'> {
  /** The hub's WebSocket URL, e.g. `ws://192.168.1.20:8800/ws`. */
  url: string;
  /** Resume this room code (for example one persisted from the last session). Default: the hub picks one. */
  code?: string;
  /** Connect only while true. Default true. */
  enabled?: boolean;
  /** Ack each intent after the frame that shows it. Default true. With false, call `ack(intent)` yourself. */
  autoAck?: boolean;
  /** Plays say lines. Default: captions only, reported as `no-audio`, shown for `durationMs`. */
  player?: SayPlayer;
  /** Report playback states to the hub on `screen.say.status`. Default true. */
  reportSay?: boolean;
  /** Stop talking (and drop the queue) when a phone or the app sends `screen.say.stop`, e.g. a barge-in. Default true. */
  interruptible?: boolean;
  /** The topic say lines arrive on. Default `screen.say`. */
  sayTopic?: string;
  onWelcome?: (welcome: WelcomeMsg) => void;
  onPartial?: (msg: PartialMsg) => void;
  onFinal?: (msg: FinalMsg) => void;
  onIntent?: (msg: IntentMsg) => void;
  onSay?: (line: SayLine) => void;
  onSayState?: (line: SayLine, state: SayState, detail?: string) => void;
}

export interface VoiceBridgeState {
  status: VoiceBridgeStatus;
  /** The underlying connection status (adds `idle` and `repair`). */
  connection: ConnectionStatus;
  /** The room's pairing code, once welcomed. */
  code: string | null;
  /** The URL a phone opens to join (from the hub's `joinUrl` option), for a QR code. */
  joinUrl: string | null;
  peers: PeerInfo[];
  /** Phones in the room. */
  mics: number;
  /** The live caption of the utterance in progress; cleared by its final. */
  partial: string | null;
  final: FinalMsg | null;
  intent: IntentMsg | null;
  /** The line being said (or captioned) right now. */
  saying: { line: SayLine; state: SayState } | null;
}

export interface SayOptions {
  id?: string;
  audioUrl?: string;
  durationMs?: number;
  priority?: 'normal' | 'high';
}

export interface VoiceBridge extends VoiceBridgeState {
  /** The client, for anything the hook does not wrap. Null before the first connect and after unmount. */
  client: BridgeClient | null;
  /** Say a line on this TV through the same queue and player as hub lines. Returns its id. */
  say: (text: string, opts?: SayOptions) => string;
  /** Stop the current line and drop the queue (each reported as `interrupted`). */
  stopSay: () => void;
  /** The app side channel (`BridgeClient.sendApp`). */
  sendApp: (topic: string, payload: unknown, opts?: { track?: boolean; startedAt?: number }) => string | null | undefined;
  /** Ack an intent yourself (with `autoAck: false`), after the frame that shows it. */
  ack: (intent: IntentMsg, opts?: { stage?: 'rendered' | 'error'; detail?: string }) => void;
}

/** Map the connection status and the room's peers to what a pairing screen shows. */
export function voiceBridgeStatus(connection: ConnectionStatus, peers: readonly PeerInfo[]): VoiceBridgeStatus {
  switch (connection) {
    case 'open':
      return peers.some((p) => p.role === 'mic') ? 'paired' : 'waiting-for-phone';
    case 'reconnecting':
      return 'reconnecting';
    case 'closed':
    case 'repair':
      return 'closed';
    default:
      return 'connecting';
  }
}

/** Run `fn` once the next frame has been painted: a macrotask queued from the next animation frame. */
export function afterNextPaint(fn: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame;
  if (typeof raf === 'function') raf(() => setTimeout(fn, 0));
  else setTimeout(fn, 0);
}

interface SayQueueHooks {
  player: () => SayPlayer | undefined;
  report: (line: SayLine, state: SayState, detail?: string) => void;
  show: (saying: { line: SayLine; state: SayState } | null) => void;
}

/** One line at a time. `high` interrupts the current line and clears the queue; `normal` queues. */
export class SayQueue {
  private queue: SayLine[] = [];
  private current: { line: SayLine; stop?: () => void; timer?: ReturnType<typeof setTimeout> } | null = null;
  private disposed = false;

  constructor(private readonly hooks: SayQueueHooks) {}

  get pending(): number {
    return this.queue.length;
  }

  get speaking(): SayLine | null {
    return this.current?.line ?? null;
  }

  push(line: SayLine) {
    if (this.disposed) return;
    if (line.priority === 'high') this.stop();
    this.queue.push(line);
    if (!this.current) this.next();
  }

  /** Interrupt the current line and drop the queue, reporting each as `interrupted`. */
  stop() {
    const dropped = this.queue.splice(0);
    const cur = this.current;
    this.current = null;
    if (cur) {
      if (cur.timer) clearTimeout(cur.timer);
      try {
        cur.stop?.();
      } catch {
        // a player that throws on stop is still stopped as far as the queue is concerned
      }
      this.hooks.report(cur.line, 'interrupted');
    }
    for (const line of dropped) this.hooks.report(line, 'interrupted');
    if (cur && !this.disposed) this.hooks.show(null);
  }

  dispose() {
    this.stop();
    this.disposed = true;
  }

  private finish(line: SayLine, state: SayState | null, detail?: string) {
    if (this.current?.line !== line) return;
    if (this.current.timer) clearTimeout(this.current.timer);
    this.current = null;
    if (state) this.hooks.report(line, state, detail);
    this.hooks.show(null);
    this.next();
  }

  private next() {
    const line = this.queue.shift();
    if (!line || this.disposed) return;
    const entry: { line: SayLine; stop?: () => void; timer?: ReturnType<typeof setTimeout> } = { line };
    this.current = entry;
    const player = this.hooks.player();
    if (!player) {
      // Captions only: nothing is audible, so the line is reported once and shown for its duration.
      this.hooks.report(line, 'no-audio');
      this.hooks.show({ line, state: 'no-audio' });
      entry.timer = setTimeout(() => this.finish(line, null), line.durationMs);
      return;
    }
    this.hooks.report(line, 'loading');
    this.hooks.show({ line, state: 'loading' });
    const live = () => this.current === entry;
    const ctl: SayControls = {
      playing: () => {
        if (!live()) return;
        this.hooks.report(line, 'playing');
        this.hooks.show({ line, state: 'playing' });
      },
      ended: () => this.finish(line, 'ended'),
      error: (detail) => this.finish(line, 'error', detail),
    };
    try {
      const stop = player(line, ctl);
      if (typeof stop === 'function') {
        if (live()) entry.stop = stop;
        else stop();
      }
    } catch (err) {
      this.finish(line, 'error', err instanceof Error ? err.message : String(err));
    }
  }
}

const initialState = (): VoiceBridgeState => ({
  status: 'connecting',
  connection: 'idle',
  code: null,
  joinUrl: null,
  peers: [],
  mics: 0,
  partial: null,
  final: null,
  intent: null,
  saying: null,
});

/**
 * Connect this TV as a `screen` and keep React state in step with the room. The connection is recreated only
 * when `url`, `code`, `name`, `clientId`, `resumeToken`, `sayTopic` or `enabled` change; callbacks and the player
 * are read from the latest render, so inline functions are fine. Unmounting closes the connection.
 */
export function useVoiceBridge(options: UseVoiceBridgeOptions): VoiceBridge {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState<VoiceBridgeState>(initialState);
  const clientRef = useRef<BridgeClient | null>(null);
  const queueRef = useRef<SayQueue | null>(null);
  const receivedAt = useRef(new WeakMap<IntentMsg, number>());
  const pendingAcks = useRef<IntentMsg[]>([]);
  const { url, code, name, clientId, resumeToken, sayTopic = SAY_TOPIC, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return undefined;
    const o = latest.current;
    const client = new BridgeClient({
      url: o.url,
      role: 'screen',
      code,
      name: o.name,
      clientId: o.clientId,
      resumeToken: o.resumeToken,
      WebSocketImpl: o.WebSocketImpl,
      reconnect: o.reconnect,
      clockSamples: o.clockSamples,
      heartbeatMs: o.heartbeatMs,
      heartbeatTimeoutMs: o.heartbeatTimeoutMs,
      connectTimeoutMs: o.connectTimeoutMs,
      maxMessageBytes: o.maxMessageBytes,
      onHandlerError: o.onHandlerError,
    });
    clientRef.current = client;
    let alive = true;
    const update = (fn: (s: VoiceBridgeState) => Partial<VoiceBridgeState>) =>
      alive &&
      setState((s) => {
        const next = { ...s, ...fn(s) };
        next.mics = next.peers.filter((p) => p.role === 'mic').length;
        next.status = voiceBridgeStatus(next.connection, next.peers);
        return next;
      });
    const call = <A extends unknown[]>(fn: ((...args: A) => void) | undefined, ...args: A) => {
      try {
        fn?.(...args);
      } catch (err) {
        globalThis.console?.error?.('vega-voice-bridge: a useVoiceBridge callback threw', err);
      }
    };

    const queue = new SayQueue({
      player: () => latest.current.player,
      report: (line, s, detail) => {
        if (latest.current.reportSay !== false) client.reportSay({ id: line.id, state: s, detail, text: line.text });
        call(latest.current.onSayState, line, s, detail);
      },
      show: (saying) => update(() => ({ saying })),
    });
    queueRef.current = queue;

    const offs = [
      client.on('status', (connection) => update(() => ({ connection }))),
      client.on('welcome', (w) => {
        update(() => ({ code: w.code, joinUrl: w.joinUrl ?? null, peers: w.peers }));
        call(latest.current.onWelcome, w);
      }),
      client.on('peers', (m) => update(() => ({ peers: m.peers }))),
      client.on('transcript.partial', (m) => {
        update(() => ({ partial: m.text }));
        call(latest.current.onPartial, m);
      }),
      client.on('transcript.final', (m) => {
        update(() => ({ final: m, partial: null }));
        call(latest.current.onFinal, m);
      }),
      client.on('intent', (m) => {
        receivedAt.current.set(m, localNow());
        if (latest.current.autoAck !== false) pendingAcks.current.push(m);
        update(() => ({ intent: m }));
        call(latest.current.onIntent, m);
      }),
      client.onSay((line) => {
        call(latest.current.onSay, line);
        queue.push(line);
      }, sayTopic),
      client.onSayStop(() => {
        if (latest.current.interruptible !== false) queue.stop();
      }),
    ];
    client.connect().catch(() => undefined); // with reconnect on (the default) it keeps retrying

    return () => {
      alive = false;
      for (const off of offs) off();
      queue.dispose();
      client.close();
      if (clientRef.current === client) clientRef.current = null;
      if (queueRef.current === queue) queueRef.current = null;
      pendingAcks.current = [];
      setState((s) => ({ ...s, connection: 'closed', status: 'closed', saying: null }));
    };
  }, [url, code, name, clientId, resumeToken, sayTopic, enabled]);

  // Ack after commit and paint: the `screen.render` hop is the moment the viewer can see the intent.
  useEffect(() => {
    if (!pendingAcks.current.length) return;
    const batch = pendingAcks.current.splice(0);
    const client = clientRef.current;
    if (!client) return;
    afterNextPaint(() => {
      if (clientRef.current !== client) return;
      for (const intent of batch) client.ack(intent, { receivedAt: receivedAt.current.get(intent) });
    });
  }, [state.intent]);

  const say = useCallback((text: string, opts: SayOptions = {}) => {
    const line = parseSay({ priority: 'normal', ...opts, id: opts.id ?? newId('say'), text })!;
    queueRef.current?.push(line);
    return line.id;
  }, []);
  const stopSay = useCallback(() => queueRef.current?.stop(), []);
  const sendApp = useCallback<VoiceBridge['sendApp']>((topic, payload, opts) => clientRef.current?.sendApp(topic, payload, opts), []);
  const ack = useCallback<VoiceBridge['ack']>((intent, opts = {}) => {
    const client = clientRef.current;
    if (client) client.ack(intent, { ...opts, receivedAt: receivedAt.current.get(intent) });
  }, []);

  return { ...state, client: clientRef.current, say, stopSay, sendApp, ack };
}

export interface PairingQrProps {
  /** The text to encode, usually the `joinUrl` from `useVoiceBridge`. */
  value: string;
  /** Upper bound for the side, quiet zone included. The drawn side is a whole multiple of the module count. Default 240. */
  size?: number;
  /** Error correction level. Default `M`. */
  ecc?: QrEcc;
  /** Quiet zone in modules on each side. Default 4 (the spec minimum). */
  quietZone?: number;
  dark?: string;
  light?: string;
  /** Default `pairing-qr`. */
  testID?: string;
  accessibilityLabel?: string;
  /** Extra style for the outer view. */
  style?: unknown;
}

/** Module geometry for a QR of `value` that fits `size`: whole-number cells, so edges stay crisp. */
export function pairingQrLayout(matrix: Pick<QrMatrix, 'size'>, size: number, quietZone: number) {
  const modules = matrix.size + 2 * quietZone;
  const cell = Math.max(1, Math.floor(size / modules));
  return { cell, side: cell * modules, offset: quietZone * cell };
}

/**
 * A QR code drawn with `View`s only: one absolutely positioned view per horizontal run of dark modules, over a
 * light square that includes the quiet zone. No SVG or canvas dependency. A value too long to encode renders the
 * empty square.
 */
export function PairingQr(props: PairingQrProps): React.ReactElement {
  const { value, size = 240, ecc = 'M', quietZone = 4, dark = '#000000', light = '#ffffff', testID = 'pairing-qr', accessibilityLabel, style } = props;
  const matrix = useMemo(() => {
    try {
      return qrMatrix(value, { ecc });
    } catch {
      return null;
    }
  }, [value, ecc]);
  const runs = useMemo(() => (matrix ? qrRuns(matrix) : []), [matrix]);
  const { cell, side, offset } = pairingQrLayout(matrix ?? { size: 21 }, size, quietZone);
  const children = runs.map((r) =>
    createElement(View, {
      key: `${r.y}:${r.x}`,
      style: { position: 'absolute', left: offset + r.x * cell, top: offset + r.y * cell, width: r.w * cell, height: cell, backgroundColor: dark },
    }),
  );
  return createElement(
    View,
    {
      testID,
      accessible: true,
      accessibilityRole: 'image',
      accessibilityLabel: accessibilityLabel ?? 'QR code to pair your phone',
      style: [{ width: side, height: side, backgroundColor: light, position: 'relative', overflow: 'hidden' }, style],
    },
    ...children,
  );
}

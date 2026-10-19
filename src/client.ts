import { MessageAssembler } from './framing.js';
import {
  PROTOCOL_VERSION,
  encode,
  newId,
  newToken,
  type BridgeMessage,
  type ErrorMsg,
  type Hop,
  type IntentMsg,
  type MessageOf,
  type MessageType,
  type Role,
  type SayPayload,
  type SayStatus,
  type SayStop,
  type SpeechNotice,
  type WelcomeMsg,
  SAY_STATUS_TOPIC,
  SAY_STOP_TOPIC,
  SAY_TOPIC,
  SPEECH_TOPIC,
  parseSay,
  parseSayStop,
  parseSpeech,
} from './protocol.js';

type WSLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
};

export interface ReconnectOptions {
  /** First retry delay. Default 250 ms. */
  minDelayMs?: number;
  /** Delays double up to this cap. Default 10 s. */
  maxDelayMs?: number;
  /** Share of each delay that is random (0 = none, 1 = full jitter). Default 0.5. */
  jitter?: number;
  /**
   * After a reconnect is answered `unknown-code` (the hub restarted and the TV has not re-created its room yet),
   * keep retrying this long, then stop with status `repair`. Default 60 s.
   */
  repairAfterMs?: number;
}

export const DEFAULT_RECONNECT: Readonly<Required<ReconnectOptions>> = { minDelayMs: 250, maxDelayMs: 10_000, jitter: 0.5, repairAfterMs: 60_000 };

/** Capped exponential backoff with jitter: attempt 0 waits about `minDelayMs`, doubling up to `maxDelayMs`. */
export function backoffDelay(attempt: number, o: ReconnectOptions = {}, rand: () => number = Math.random): number {
  const { minDelayMs, maxDelayMs, jitter } = { ...DEFAULT_RECONNECT, ...o };
  const base = Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(Math.max(0, attempt), 30));
  const j = Math.max(0, Math.min(1, jitter));
  return Math.round(base * (1 - j) + base * j * rand());
}

export interface ClientOptions {
  url: string;
  role: Role;
  code?: string;
  name?: string;
  clientId?: string;
  /**
   * Secret that proves this client owns `clientId` when it reconnects while the hub still holds the old connection.
   * Generated per instance. Persist it next to a persisted `clientId` to keep the id across page reloads. Never show or log it.
   */
  resumeToken?: string;
  /** Browser/Node 22+ have a global WebSocket; pass one otherwise. */
  WebSocketImpl?: new (url: string) => WSLike;
  /** Keep the connection up until `close()`: on by default. `false` makes one attempt and never retries. */
  reconnect?: boolean | ReconnectOptions;
  /** Clock samples for the hub offset estimate. */
  clockSamples?: number;
  /** Send a ping this often while connected. 0 disables the heartbeat. Default 10 s. */
  heartbeatMs?: number;
  /** Treat the link as dead after this long without any data from the hub, even if `onclose` never fires. Default 25 s. */
  heartbeatTimeoutMs?: number;
  /** Abandon an attempt that has not been welcomed after this long. 0 disables. Default 10 s. */
  connectTimeoutMs?: number;
  /** Largest message reassembled from split frames. Default 1 MiB. */
  maxMessageBytes?: number;
  /** Called when one of your event handlers throws. Default: console.error. */
  onHandlerError?: (err: unknown, event: string) => void;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'repair' | 'closed';

/** Client lifecycle events (in addition to one event per received message type). */
export interface ClientEvents {
  /** Welcomed into a room (first connect and every reconnect). */
  open: () => void;
  /** A socket went away (closed, failed, or found dead by the heartbeat). */
  close: () => void;
  /** A retry is scheduled. */
  reconnecting: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** The room's code stopped working (the TV is gone). Show "pair again"; then set `code` and call `connect()`. */
  repair: (info: { code: string | undefined; reason: string }) => void;
  status: (status: ConnectionStatus) => void;
}

type Handler<T extends MessageType> = (m: MessageOf<T>) => void;
type AnyHandler = (arg?: unknown) => void;

const timeOrigin = (): number =>
  typeof performance.timeOrigin === 'number' && performance.timeOrigin > 0 ? performance.timeOrigin : Date.now() - performance.now();
/**
 * Local epoch milliseconds from the monotonic clock: the time base that `sendFinal`'s `speechEndAt` and `ack`'s
 * `receivedAt` expect. Works where `performance.timeOrigin` is missing.
 */
export const localNow = (): number => timeOrigin() + performance.now();

function errorText(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * Framework-agnostic client for both roles. Works in browsers, React Native (including Vega) and Node.
 * It keeps the connection up until `close()`: backoff with jitter, a heartbeat that detects dead links when
 * `onclose` never fires, re-joining after a hub restart, and reassembly of messages split across frames.
 */
export class BridgeClient {
  readonly clientId: string;
  readonly resumeToken: string;
  code: string | undefined;
  /** hub clock - local clock, from the best (lowest RTT) ping sample of the current connection */
  offsetMs = 0;
  rttMs: number | null = null;
  connected = false;
  status: ConnectionStatus = 'idle';
  private ws: WSLike | null = null;
  private handlers = new Map<string, Set<AnyHandler>>();
  private want = false;
  private everWelcomed = false;
  private attempt = 0;
  private repairSince: number | null = null;
  private bestRtt = Infinity;
  private lastRecv = 0;
  private lastWelcome: WelcomeMsg | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private waiters: Array<{ resolve: (w: WelcomeMsg) => void; reject: (e: Error) => void }> = [];
  private readonly assembler: MessageAssembler;
  private readonly retry: Required<ReconnectOptions> | null;

  constructor(private readonly opts: ClientOptions) {
    this.clientId = opts.clientId ?? newId(opts.role);
    this.resumeToken = opts.resumeToken ?? newToken();
    this.code = opts.code;
    this.retry = opts.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...(typeof opts.reconnect === 'object' ? opts.reconnect : {}) };
    this.assembler = new MessageAssembler({ maxBytes: opts.maxMessageBytes });
  }

  on<T extends MessageType>(type: T, fn: Handler<T>): () => void;
  on<E extends keyof ClientEvents>(type: E, fn: ClientEvents[E]): () => void;
  on(type: string, fn: (arg: never) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn as AnyHandler);
    this.handlers.set(type, set);
    return () => set.delete(fn as AnyHandler);
  }

  private emit(type: string, arg?: unknown) {
    for (const fn of [...(this.handlers.get(type) ?? [])]) {
      try {
        fn(arg);
      } catch (err) {
        try {
          if (this.opts.onHandlerError) this.opts.onHandlerError(err, type);
          else globalThis.console?.error?.(`tv-voice-bridge: a "${type}" handler threw`, err);
        } catch {
          // nothing left to report to
        }
      }
    }
  }

  private setStatus(s: ConnectionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  /** Local time mapped to hub clock. */
  now(): number {
    return localNow() + this.offsetMs;
  }

  hop(name: string): Hop {
    return { hop: name, at: this.now() };
  }

  /**
   * Connect and resolve on the first `welcome`. The promise rejects if this attempt fails; with `reconnect` on
   * (the default) the client keeps retrying in the background and fires `open` when it gets in. Fatal answers
   * stop it: `version`, `id-in-use`, a refused hello, and `unknown-code` on a first pairing.
   */
  connect(): Promise<WelcomeMsg> {
    return new Promise<WelcomeMsg>((resolve, reject) => {
      if (this.connected && this.lastWelcome) return resolve(this.lastWelcome);
      this.waiters.push({ resolve, reject });
      if (this.status === 'idle' || this.status === 'closed' || this.status === 'repair') this.everWelcomed = false;
      this.want = true;
      if (this.ws) return; // an attempt is already in flight
      this.clearRetry();
      this.attempt = 0;
      this.repairSince = null;
      this.open();
    });
  }

  private open() {
    this.clearSocketTimers();
    this.setStatus(this.attempt === 0 && !this.everWelcomed ? 'connecting' : 'reconnecting');
    const url = this.opts.url;
    let ws: WSLike;
    try {
      const WS = this.opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: new (url: string) => WSLike }).WebSocket;
      if (!WS) throw new Error('no WebSocket implementation; pass WebSocketImpl');
      ws = new WS(url);
    } catch (err) {
      this.drop(null, `cannot connect to ${url}: ${errorText(err)}`);
      return;
    }
    this.ws = ws;
    this.assembler.reset();
    const connectTimeout = this.opts.connectTimeoutMs ?? 10_000;
    if (connectTimeout > 0) this.connectTimer = setTimeout(() => this.drop(ws, `no welcome from ${url} within ${connectTimeout} ms`), connectTimeout);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastRecv = localNow();
      this.send({ type: 'hello', v: PROTOCOL_VERSION, role: this.opts.role, clientId: this.clientId, code: this.code, name: this.opts.name, resumeToken: this.resumeToken });
      this.startHeartbeat(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRecv = localNow();
      const batch = this.assembler.push(typeof ev.data === 'string' ? ev.data : String(ev.data));
      for (const m of batch.messages) {
        if (this.ws !== ws) break;
        this.receive(ws, m);
      }
    };
    ws.onerror = () => {
      if (this.ws === ws) this.drop(ws, this.connected ? 'socket error' : `cannot connect to ${url}`);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.drop(ws, this.connected ? 'connection closed' : `connection to ${url} closed before welcome`);
    };
  }

  private receive(ws: WSLike, m: BridgeMessage) {
    if (m.type === 'welcome') {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.connected = true;
      this.everWelcomed = true;
      this.attempt = 0;
      this.repairSince = null;
      this.code = m.code;
      this.lastWelcome = m;
      // A new connection is a new network path: forget the old best sample, start from the welcome estimate.
      this.bestRtt = Infinity;
      this.rttMs = null;
      this.offsetMs = m.serverTime - localNow();
      this.setStatus('open');
      void this.syncClock();
      for (const w of this.waiters.splice(0)) w.resolve(m);
      this.emit('open');
    } else if (m.type === 'pong') {
      this.onPong(m);
    } else if (m.type === 'error' && !this.connected) {
      this.refused(ws, m);
    }
    this.emit(m.type, m);
  }

  /** The hub refused the hello. Decide whether to retry. */
  private refused(ws: WSLike, m: ErrorMsg) {
    const reason = `${m.code}: ${m.message}`;
    if (m.code === 'unknown-code' && this.everWelcomed && this.retry) {
      // A reconnect after a hub restart can land before the TV re-creates its room: keep trying for a while.
      this.repairSince ??= localNow();
      return this.drop(ws, reason);
    }
    if (m.code === 'rate-limited' || m.code === 'full') return this.drop(ws, reason, { minDelayMs: m.retryAfterMs });
    this.drop(ws, reason, { fatal: true });
  }

  /** Abandon a socket (idempotent per socket), then retry, stop, or ask for re-pairing. */
  private drop(ws: WSLike | null, reason: string, o: { fatal?: boolean; minDelayMs?: number } = {}) {
    if (ws && this.ws !== ws) return;
    this.detach(ws);
    this.ws = null;
    this.connected = false;
    for (const w of this.waiters.splice(0)) w.reject(new Error(reason));
    if (ws) this.emit('close');
    if (o.fatal || !this.want || !this.retry) {
      this.want = false;
      this.setStatus('closed');
      return;
    }
    if (this.repairSince !== null && localNow() - this.repairSince >= this.retry.repairAfterMs) {
      this.want = false;
      this.setStatus('repair');
      this.emit('repair', { code: this.code, reason });
      return;
    }
    const delayMs = Math.max(o.minDelayMs ?? 0, backoffDelay(this.attempt++, this.retry));
    this.setStatus('reconnecting');
    this.emit('reconnecting', { attempt: this.attempt, delayMs, reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.want && !this.ws) this.open();
    }, delayMs);
  }

  private detach(ws: WSLike | null) {
    this.clearSocketTimers();
    if (!ws) return;
    const noop = () => undefined;
    ws.onopen = noop;
    ws.onmessage = noop;
    ws.onerror = noop;
    ws.onclose = noop;
    try {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close();
    } catch {
      // already gone
    }
  }

  private startHeartbeat(ws: WSLike) {
    const every = this.opts.heartbeatMs ?? 10_000;
    if (!(every > 0)) return;
    const timeout = this.opts.heartbeatTimeoutMs ?? Math.max(every * 2.5, every + 5_000);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws) return;
      if (localNow() - this.lastRecv > timeout) return this.drop(ws, `no data from the hub for ${Math.round(timeout)} ms`);
      this.send({ type: 'ping', t0: localNow() });
    }, every);
  }

  private clearSocketTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.connectTimer = null;
    this.heartbeatTimer = null;
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private onPong(m: MessageOf<'pong'>) {
    const t1 = localNow();
    const rtt = t1 - m.t0;
    if (rtt >= 0 && rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.rttMs = Math.round(rtt);
      this.offsetMs = m.serverTime + rtt / 2 - t1;
    }
  }

  async syncClock(samples = this.opts.clockSamples ?? 5): Promise<void> {
    for (let i = 0; i < samples; i++) {
      if (!this.send({ type: 'ping', t0: localNow() })) return;
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  /** Send a message now. Returns false when not connected (nothing is queued). */
  send(m: BridgeMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(encode(m));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Mic: send a final transcript. `speechStartAt` and `speechEndAt` are local times (`localNow()`) of when the
   * speech started and ended; they become the `speech.start` and `speech.end` hops in hub clock.
   */
  sendFinal(text: string, opts: { speechEndAt?: number; speechStartAt?: number; utteranceId?: string } = {}): string {
    const utteranceId = opts.utteranceId ?? newId('utt');
    const hops: Hop[] = [];
    if (opts.speechStartAt !== undefined) hops.push({ hop: 'speech.start', at: opts.speechStartAt + this.offsetMs });
    if (opts.speechEndAt !== undefined) hops.push({ hop: 'speech.end', at: opts.speechEndAt + this.offsetMs });
    hops.push(this.hop('mic.send'));
    this.send({ type: 'transcript.final', utteranceId, text, hops });
    return utteranceId;
  }

  sendPartial(text: string, utteranceId: string) {
    this.send({ type: 'transcript.partial', utteranceId, text, hops: [this.hop('mic.partial')] });
  }

  /** App side channel. With track=true it is stamped and answered like an utterance. */
  sendApp(topic: string, payload: unknown, opts: { track?: boolean; startedAt?: number } = {}): string | undefined {
    if (!opts.track) {
      this.send({ type: 'app', topic, payload });
      return undefined;
    }
    const utteranceId = newId('tap');
    const hops: Hop[] = [];
    if (opts.startedAt !== undefined) hops.push({ hop: 'input.end', at: opts.startedAt + this.offsetMs });
    hops.push(this.hop('mic.send'));
    this.send({ type: 'app', topic, payload, utteranceId, hops });
    return utteranceId;
  }

  /** Screen: confirm an intent reached the screen. Call after the frame that shows it. */
  ack(intent: IntentMsg, opts: { receivedAt?: number; stage?: 'rendered' | 'error'; detail?: string } = {}) {
    const hops = [...intent.hops];
    if (opts.receivedAt !== undefined) hops.push({ hop: 'screen.recv', at: opts.receivedAt + this.offsetMs });
    hops.push(this.hop('screen.render'));
    this.send({ type: 'ack', utteranceId: intent.utteranceId, stage: opts.stage ?? 'rendered', detail: opts.detail, hops });
  }

  /** Screen: handle TV -> room speech lines (`screen.say`, or the app's own topic). Invalid payloads are dropped. */
  onSay(fn: (line: Required<SayPayload>) => void, topic: string = SAY_TOPIC): () => void {
    return this.on('app', (m) => {
      if (m.topic !== topic) return;
      const line = parseSay(m.payload);
      if (line) fn(line);
    });
  }

  /** Screen: report playback of a line back to the hub (loading / playing / ended / error ...), stamped in hub clock. */
  reportSay(status: Omit<SayStatus, 'at'> & { at?: number }, topic: string = SAY_STATUS_TOPIC) {
    this.sendApp(topic, { ...status, at: status.at ?? this.now() });
  }

  /** Mic: follow what the TV is saying (`screen.speech`), for an echo guard. Invalid payloads are dropped. */
  onSpeech(fn: (notice: SpeechNotice) => void): () => void {
    return this.on('app', (m) => {
      if (m.topic !== SPEECH_TOPIC) return;
      const n = parseSpeech(m.payload);
      if (n) fn(n);
    });
  }

  /** Mic: ask the room's screens to stop talking (barge-in, or a stop button). */
  stopSay(stop: SayStop = {}): boolean {
    return this.send({ type: 'app', topic: SAY_STOP_TOPIC, payload: parseSayStop(stop) });
  }

  /** Screen: handle `screen.say.stop` (a phone or the app asks the TV to stop talking). */
  onSayStop(fn: (stop: SayStop & { from?: string }) => void): () => void {
    return this.on('app', (m) => {
      if (m.topic !== SAY_STOP_TOPIC) return;
      fn({ ...parseSayStop(m.payload), from: m.from });
    });
  }

  /** Disconnect and stop reconnecting (also cancels a pending retry). A pending `connect()` rejects. */
  close() {
    this.want = false;
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    this.detach(ws);
    this.connected = false;
    for (const w of this.waiters.splice(0)) w.reject(new Error('closed by the client'));
    if (ws) this.emit('close');
    this.setStatus('closed');
  }
}

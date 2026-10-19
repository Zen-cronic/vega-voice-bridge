import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  CLIENT_SENDS,
  PROTOCOL_VERSION,
  SAY_STOP_TOPIC,
  SAY_TOPIC,
  SPEECH_TOPIC,
  decodeMessage,
  encode,
  isPairingCode,
  isSayStatusTopic,
  makePairingCode,
  normalizeCode,
  parseSayStatus,
  parseSayStop,
  secureRandom,
  type AckMsg,
  type AppMsg,
  type BridgeMessage,
  type ErrorCode,
  type FinalMsg,
  type HelloMsg,
  type Hop,
  type IntentMsg,
  type PartialMsg,
  type PeerInfo,
  type Role,
  type SayPayload,
  type SayStop,
  type SpeechNotice,
} from './protocol.js';

export interface Peer extends PeerInfo {
  socket: WebSocket;
}

export interface Room {
  code: string;
  peers: Map<string, Peer>;
  createdAt: number;
}

/** What an app handler returns for an utterance or an app message: an intent to fan out, or nothing. */
export type IntentResult = { name: string; ok: boolean; payload: unknown } | null | undefined;

export interface HubLimits {
  /** Largest inbound frame; a bigger one closes that socket (1009). Default 256 KiB. */
  maxMessageBytes: number;
  /** Rooms the hub keeps at once; a screen hello beyond it gets `full`. Default 10,000. */
  maxRooms: number;
  /** Peers per room; a hello beyond it gets `full`. Default 32. */
  maxPeersPerRoom: number;
  /** Per socket, sustained (bursts of twice this pass). Excess messages are dropped with one `rate-limited` per second. Default 100. 0 disables. */
  messagesPerSecond: number;
  /** Hellos per rate key (default: remote address) per minute. Default 120. 0 disables. */
  hellosPerMinute: number;
  /** Hellos naming a code no live room has (mic, or a screen probing) per rate key per minute; past it, hellos naming a code are refused. Default 30. 0 disables. */
  codeMissesPerMinute: number;
  /** Above this many buffered bytes to one peer, live captions and untracked app frames to it are dropped. Default 1 MiB. */
  maxBufferedBytes: number;
  /** Above this many buffered bytes the peer is disconnected (it reconnects and gets fresh state). Default 8 MiB. */
  maxBufferedBytesHard: number;
}

export const DEFAULT_HUB_LIMITS: Readonly<HubLimits> = {
  maxMessageBytes: 256 * 1024,
  maxRooms: 10_000,
  maxPeersPerRoom: 32,
  messagesPerSecond: 100,
  hellosPerMinute: 120,
  codeMissesPerMinute: 30,
  maxBufferedBytes: 1024 * 1024,
  maxBufferedBytesHard: 8 * 1024 * 1024,
};

export interface HubOptions {
  /** One or more HTTP(S) servers to accept WebSocket upgrades from (e.g. http for the TV + https for phones). */
  server: Server | Server[];
  path?: string;
  /** Build the URL a phone opens to join (for the QR code). */
  joinUrl?: (code: string) => string;
  /** App understanding step for final transcripts. Must be fast or degrade (e.g. fall back to rules). */
  onFinal?: (room: Room, msg: FinalMsg, from: PeerInfo) => Promise<IntentResult> | IntentResult;
  /** App-defined side channel. Return an intent to fan out (stamped with hops like an utterance). */
  onApp?: (room: Room, msg: AppMsg, from: PeerInfo) => Promise<IntentResult> | IntentResult;
  onJoin?: (room: Room, peer: PeerInfo) => void;
  onLeave?: (room: Room, peer: PeerInfo) => void;
  onAck?: (room: Room, msg: AckMsg) => void;
  /** A room was deleted: its last screen left more than `roomGraceMs` ago (`expired`), or the hub closed. */
  onRoomClose?: (room: Room, reason: 'expired' | 'closed') => void;
  clock?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** How long a room outlives its last screen. Mics can still join or rejoin inside it. Default 60 s. */
  roomGraceMs?: number;
  /** Protocol-level ping interval; a socket that misses two pings in a row is terminated. 0 disables. Default 15 s. */
  heartbeatMs?: number;
  /** When a second connection claims a live clientId without its resumeToken, wait this long for the holder to answer a ping. Default 2 s. */
  conflictProbeMs?: number;
  limits?: Partial<HubLimits>;
  /**
   * Key for the hello and wrong-code limits. Default: the socket's remote address. Behind a tunnel or reverse proxy every
   * client shares one address, so derive the key from what the proxy appended: `(req) => forwardedClient(req)`.
   */
  rateKey?: (req: IncomingMessage) => string;
  /** Random source for pairing codes (tests). Default: the platform CSPRNG. */
  random?: () => number;
  /**
   * Tell the room's mics what the TV is saying (`screen.speech`): `queued` on `say()`, then each `screen.say.status`
   * a screen reports. Phones use it to keep the TV's voice out of the microphone. Default true.
   */
  speechNotices?: boolean;
}

/** Counters for observability (and tests). */
export interface HubStats {
  badMessages: number;
  rateLimited: number;
  backpressureDrops: number;
  backpressureCloses: number;
  heartbeatTimeouts: number;
  handlerErrors: number;
  roomsExpired: number;
}

interface Conn {
  ws: WebSocket;
  key: string;
  room: Room | null;
  me: Peer | null;
  missed: number;
  tokens: number;
  refilledAt: number;
  rateNotedAt: number;
  ready: Promise<void>;
}

const MAX_INBOUND_HOPS = 32;
const mono = () => performance.now();

/** Message text of anything thrown, without ever throwing itself. */
export function errorText(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return 'unknown error';
  }
}

export interface ForwardedClientOptions {
  /** Addresses of proxies whose `X-Forwarded-For` is trusted, besides loopback. */
  proxies?: string[];
  /** Proxies in front of the hub, each appending to `X-Forwarded-For`. Default 1. */
  hops?: number;
}

const unmapped = (addr: string) => (addr.startsWith('::ffff:') ? addr.slice(7) : addr);
const isLoopback = (addr: string) => addr === '::1' || unmapped(addr).startsWith('127.');

/**
 * The client's address behind a reverse proxy or a tunnel, for `rateKey`. Each proxy appends the address it received
 * the request from, so only the entries at the end are trustworthy; whatever comes before them is what the client
 * sent. With `hops` proxies the client is the `hops`-th entry from the end. The header counts only when the socket's
 * peer is loopback (a tunnel agent or a proxy on this machine) or one of `proxies`. Otherwise, or when the header has
 * fewer entries than `hops`, the socket's own address is the key.
 */
export function forwardedClient(req: IncomingMessage, o: ForwardedClientOptions = {}): string {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  const trusted = isLoopback(peer) || (o.proxies ?? []).some((p) => unmapped(p) === unmapped(peer));
  if (!trusted) return peer;
  const raw = req.headers['x-forwarded-for'];
  const entries = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hops = Math.max(1, Math.floor(o.hops ?? 1));
  return entries.length >= hops ? entries[entries.length - hops]! : peer;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/**
 * Under backpressure, frames the next one supersedes can be dropped. Utterance results, speech lines, speech notices
 * (the phone's echo guard depends on them) and stops cannot.
 */
function droppable(msg: BridgeMessage): boolean {
  if (msg.type === 'transcript.partial') return true;
  if (msg.type !== 'app' || msg.utteranceId) return false;
  const t = msg.topic;
  return t !== SAY_TOPIC && !t.endsWith('.say') && t !== SPEECH_TOPIC && t !== SAY_STOP_TOPIC;
}

class FixedWindow {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly limit: number,
    private readonly ms: number,
  ) {}
  private entry(key: string, t: number) {
    let e = this.hits.get(key);
    if (!e || t - e.start >= this.ms) {
      e = { start: t, n: 0 };
      this.hits.set(key, e);
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t - v.start >= this.ms) this.hits.delete(k);
    }
    return e;
  }
  /** Count one event; false when it is over the limit. */
  hit(key: string, t: number): boolean {
    if (!(this.limit > 0)) return true;
    const e = this.entry(key, t);
    e.n++;
    return e.n <= this.limit;
  }
  /** True when the limit is already used up (does not count). */
  full(key: string, t: number): boolean {
    return this.limit > 0 && this.entry(key, t).n >= this.limit;
  }
  retryAfter(key: string, t: number): number {
    const e = this.hits.get(key);
    return e ? Math.max(0, Math.ceil(e.start + this.ms - t)) : 0;
  }
}

/**
 * WebSocket hub: pairing rooms, transcript fan-out, intent dispatch and ack forwarding with hop stamps.
 * Defensive by construction: no inbound frame, upgrade request or app callback can throw out of it.
 */
export class BridgeHub {
  readonly rooms = new Map<string, Room>();
  readonly limits: Readonly<HubLimits>;
  readonly stats: HubStats = { badMessages: 0, rateLimited: 0, backpressureDrops: 0, backpressureCloses: 0, heartbeatTimeouts: 0, handlerErrors: 0, roomsExpired: 0 };
  private wss: WebSocketServer;
  private clock: () => number;
  private readonly path: string;
  private readonly servers: Server[];
  private readonly conns = new Set<Conn>();
  private readonly tokenOf = new WeakMap<WebSocket, string>();
  private readonly screenlessSince = new WeakMap<Room, number>();
  private readonly hellos: FixedWindow;
  private readonly misses: FixedWindow;
  private readonly graceMs: number;
  private readonly random: () => number;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private closed = false;

  constructor(private readonly opts: HubOptions) {
    this.clock = opts.clock ?? (() => performance.timeOrigin + performance.now());
    this.limits = { ...DEFAULT_HUB_LIMITS, ...opts.limits };
    this.path = opts.path ?? '/ws';
    this.graceMs = opts.roomGraceMs ?? 60_000;
    this.random = opts.random ?? secureRandom;
    this.hellos = new FixedWindow(this.limits.hellosPerMinute, 60_000);
    this.misses = new FixedWindow(this.limits.codeMissesPerMinute, 60_000);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.limits.maxMessageBytes });
    this.wss.on('error', (err) => this.log('wss-error', { error: errorText(err) }));
    this.servers = Array.isArray(opts.server) ? opts.server : [opts.server];
    for (const srv of this.servers) srv.on('upgrade', this.onUpgrade);

    const heartbeatMs = opts.heartbeatMs ?? 15_000;
    if (heartbeatMs > 0) this.every(heartbeatMs, () => this.heartbeat());
    if (this.graceMs > 0) this.every(Math.max(10, Math.min(this.graceMs, 5_000)), () => this.sweep());
  }

  private every(ms: number, fn: () => void) {
    const t = setInterval(() => {
      try {
        fn();
      } catch (err) {
        this.log('timer-failed', { error: errorText(err) });
      }
    }, ms);
    (t as { unref?: () => void }).unref?.();
    this.timers.push(t);
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://hub').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== this.path || this.closed) return;
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
    } catch (err) {
      // ws throws only when another listener already upgraded this socket (two hubs on one path); leave it be.
      this.log('upgrade-failed', { error: errorText(err) });
    }
  };

  now(): number {
    return this.clock();
  }

  private log(event: string, data?: Record<string, unknown>) {
    try {
      this.opts.log?.(event, data);
    } catch {
      // a logger must never take the hub down
    }
  }

  /** Run an app callback; a throw or a rejected promise is logged, never propagated. */
  private call<T>(label: string, fn: () => T): T | undefined {
    try {
      const r = fn();
      // A rejected handler is reported once, here; the caller gets a promise that settles, so awaiting it
      // does not throw the same error into onMessage's catch as well.
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        return (r as unknown as Promise<unknown>).then(undefined, (err) => (this.handlerError(label, err), undefined)) as T;
      }
      return r;
    } catch (err) {
      this.handlerError(label, err);
      return undefined;
    }
  }

  private handlerError(label: string, err: unknown) {
    this.stats.handlerErrors++;
    this.log('handler-failed', { handler: label, error: errorText(err) });
  }

  /** Create a room (or return the live one with that code). Throws only when the hub is full; the hub itself never calls this form. */
  createRoom(code?: string): Room {
    const r = this.tryCreateRoom(code);
    if (!r) throw new Error('tv-voice-bridge: no free room (maxRooms reached)');
    return r;
  }

  private tryCreateRoom(code?: string): Room | null {
    if (code !== undefined && isPairingCode(code)) {
      const existing = this.rooms.get(code);
      if (existing) return existing;
      return this.rooms.size >= this.limits.maxRooms ? null : this.addRoom(code);
    }
    if (this.rooms.size >= this.limits.maxRooms) return null;
    // A generated code must never land on a live room (another household's TV).
    for (let i = 0; i < 64; i++) {
      const c = makePairingCode(this.random);
      if (!this.rooms.has(c)) return this.addRoom(c);
    }
    return null;
  }

  private addRoom(code: string): Room {
    const room: Room = { code, peers: new Map(), createdAt: this.now() };
    this.rooms.set(code, room);
    this.screenlessSince.set(room, mono());
    return room;
  }

  /** Delete a room and disconnect whoever is still in it (they get `unknown-code`, then close code 4404). */
  private closeRoom(room: Room, reason: 'expired' | 'closed') {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    if (reason === 'expired') this.stats.roomsExpired++;
    for (const p of room.peers.values()) {
      this.error(p.socket, 'unknown-code', `room ${room.code} closed: its TV left`);
      try {
        p.socket.close(4404, 'room closed');
      } catch {
        p.socket.terminate();
      }
    }
    this.log('room-close', { code: room.code, reason });
    this.call('onRoomClose', () => this.opts.onRoomClose?.(room, reason));
  }

  private sweep() {
    const t = mono();
    for (const room of [...this.rooms.values()]) {
      const since = this.screenlessSince.get(room);
      if (since !== undefined && t - since >= this.graceMs) this.closeRoom(room, 'expired');
    }
  }

  private heartbeat() {
    for (const conn of this.conns) {
      if (conn.missed >= 2) {
        this.stats.heartbeatTimeouts++;
        this.log('heartbeat-timeout', { code: conn.room?.code, clientId: conn.me?.clientId });
        conn.ws.terminate();
        continue;
      }
      conn.missed++;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  /** Send one message. Returns false when it was not sent (socket not open, backpressure, unencodable payload). */
  send(socket: WebSocket, msg: BridgeMessage): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    const buffered = socket.bufferedAmount;
    if (buffered > this.limits.maxBufferedBytesHard) {
      this.stats.backpressureCloses++;
      this.log('backpressure-close', { buffered });
      socket.terminate();
      return false;
    }
    if (buffered > this.limits.maxBufferedBytes && droppable(msg)) {
      this.stats.backpressureDrops++;
      this.log('backpressure-drop', { type: msg.type, buffered });
      return false;
    }
    let text: string;
    try {
      text = encode(msg);
    } catch (err) {
      this.log('encode-failed', { type: msg.type, error: errorText(err) });
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private error(socket: WebSocket, code: ErrorCode, message: string, extra: { utteranceId?: string; retryAfterMs?: number } = {}) {
    if (code === 'bad-message') this.stats.badMessages++;
    if (code === 'rate-limited') this.stats.rateLimited++;
    this.send(socket, { type: 'error', code, message, ...extra });
  }

  broadcast(room: Room, msg: BridgeMessage, roles?: Role[]) {
    for (const p of room.peers.values()) if (!roles || roles.includes(p.role)) this.send(p.socket, msg);
  }

  /**
   * TV -> room speech: send a line to every screen in the room (`screen.say`, or your own topic name).
   * The screen plays `audioUrl` or speaks `text`, and captions it. Returns the payload sent.
   */
  say(room: Room, line: SayPayload, opts: { topic?: string } = {}): SayPayload {
    const payload: SayPayload = { priority: 'normal', ...line };
    this.broadcast(room, { type: 'app', topic: opts.topic ?? SAY_TOPIC, payload }, ['screen']);
    const notice: SpeechNotice = { id: String(payload.id), state: 'queued', at: this.now() };
    if (typeof payload.text === 'string') notice.text = payload.text;
    if (typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs > 0) notice.durationMs = payload.durationMs;
    this.speech(room, notice);
    return payload;
  }

  /** Ask the room's screens to stop the current line and drop their queues (`screen.say.stop`). */
  stopSay(room: Room, stop: SayStop = {}) {
    this.broadcast(room, { type: 'app', topic: SAY_STOP_TOPIC, payload: parseSayStop(stop) }, ['screen']);
  }

  /** Tell the room's mics what the TV is saying (unless `speechNotices` is off). */
  private speech(room: Room, notice: SpeechNotice) {
    if (this.opts.speechNotices === false) return;
    this.broadcast(room, { type: 'app', topic: SPEECH_TOPIC, payload: notice }, ['mic']);
  }

  peersOf(room: Room): PeerInfo[] {
    return [...room.peers.values()].map(({ clientId, role, name }) => ({ clientId, role, name }));
  }

  private stamp(hops: Hop[] | undefined, hop: string): Hop[] {
    return [...(hops ?? []).slice(0, MAX_INBOUND_HOPS), { hop, at: this.now() }];
  }

  private accept(ws: WebSocket, req: IncomingMessage) {
    let key = req.socket?.remoteAddress ?? 'unknown';
    if (this.opts.rateKey) key = String(this.call('rateKey', () => this.opts.rateKey!(req)) ?? key);
    const burst = this.limits.messagesPerSecond * 2;
    const conn: Conn = { ws, key, room: null, me: null, missed: 0, tokens: burst, refilledAt: mono(), rateNotedAt: -Infinity, ready: Promise.resolve() };
    this.conns.add(conn);
    ws.on('error', (err) => {
      this.log('socket-error', { error: errorText(err), code: conn.room?.code });
      ws.terminate();
    });
    ws.on('pong', () => {
      conn.missed = 0;
    });
    ws.on('message', (data, isBinary) => {
      conn.missed = 0;
      this.onMessage(conn, data, isBinary).catch((err) => this.log('message-failed', { error: errorText(err) }));
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      this.leave(conn);
    });
  }

  /** Token bucket per socket. */
  private take(conn: Conn): boolean {
    const rate = this.limits.messagesPerSecond;
    if (!(rate > 0)) return true;
    const t = mono();
    conn.tokens = Math.min(rate * 2, conn.tokens + ((t - conn.refilledAt) * rate) / 1000);
    conn.refilledAt = t;
    if (conn.tokens >= 1) {
      conn.tokens--;
      return true;
    }
    if (t - conn.rateNotedAt >= 1000) {
      conn.rateNotedAt = t;
      this.error(conn.ws, 'rate-limited', 'too many messages; some were dropped', { retryAfterMs: 1000 });
    }
    return false;
  }

  private async onMessage(conn: Conn, data: RawData, isBinary: boolean) {
    const ws = conn.ws;
    if (!this.take(conn)) return;
    if (isBinary) return this.error(ws, 'bad-message', 'binary frames are not part of the protocol');
    const r = decodeMessage(rawToString(data));
    if (!r.ok) return this.error(ws, 'bad-message', r.error);
    const msg = r.msg;
    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong', t0: msg.t0, serverTime: this.now() });
      return;
    }
    if (msg.type === 'hello') {
      // Hellos on one socket run in order; later messages wait for the join to finish.
      conn.ready = conn.ready.then(() => this.hello(conn, msg)).catch((err) => this.log('hello-failed', { error: errorText(err) }));
      return conn.ready;
    }
    await conn.ready;
    const { room, me } = conn;
    if (!room || !me) return this.error(ws, 'bad-message', 'say hello first');
    if (this.rooms.get(room.code) !== room) return; // the room closed; this socket is being disconnected
    if (!CLIENT_SENDS[me.role].includes(msg.type)) return this.error(ws, 'not-allowed', `a ${me.role} may not send ${msg.type}`);
    const from: PeerInfo = { clientId: me.clientId, role: me.role, name: me.name };
    switch (msg.type) {
      case 'transcript.partial': {
        const partial: PartialMsg = { type: 'transcript.partial', utteranceId: msg.utteranceId, text: msg.text, from: me.clientId, hops: msg.hops.slice(0, MAX_INBOUND_HOPS) };
        this.broadcast(room, partial, ['screen']);
        return;
      }
      case 'transcript.final': {
        const hops = this.stamp(msg.hops, 'hub.recv');
        const final: FinalMsg = { type: 'transcript.final', utteranceId: msg.utteranceId, text: msg.text, from: me.clientId, hops };
        this.broadcast(room, final, ['screen']);
        await this.dispatch(room, msg.utteranceId, from, hops, () => this.opts.onFinal?.(room, final, from));
        return;
      }
      case 'app': {
        const base: AppMsg = { type: 'app', topic: msg.topic, payload: msg.payload, from: me.clientId };
        if (!msg.utteranceId) {
          this.relaySpeech(room, me, msg);
          await this.call('onApp', () => this.opts.onApp?.(room, base, from));
          return;
        }
        const hops = this.stamp(msg.hops, 'hub.recv');
        const tracked: AppMsg = { ...base, utteranceId: msg.utteranceId, hops };
        await this.dispatch(room, msg.utteranceId, from, hops, () => this.opts.onApp?.(room, tracked, from));
        return;
      }
      case 'ack': {
        const ack: AckMsg = { type: 'ack', utteranceId: msg.utteranceId, stage: msg.stage, hops: this.stamp(msg.hops, 'hub.ack') };
        if (msg.detail !== undefined) ack.detail = msg.detail;
        this.call('onAck', () => this.opts.onAck?.(room, ack));
        this.broadcast(room, ack, ['mic']);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The two relays behind the phone's echo guard: a screen's playback report goes to the room's mics as
   * `screen.speech`, and a mic's `screen.say.stop` goes to the room's screens. Both are rebuilt from validated fields.
   */
  private relaySpeech(room: Room, me: Peer, msg: AppMsg) {
    if (me.role === 'screen' && isSayStatusTopic(msg.topic)) {
      const status = parseSayStatus(msg.payload, this.now());
      if (!status) return;
      const notice: SpeechNotice = { id: status.id, state: status.state, at: status.at };
      if (status.text !== undefined) notice.text = status.text;
      this.speech(room, notice);
    } else if (me.role === 'mic' && msg.topic === SAY_STOP_TOPIC) {
      this.broadcast(room, { type: 'app', topic: SAY_STOP_TOPIC, payload: parseSayStop(msg.payload), from: me.clientId }, ['screen']);
    }
  }

  private async hello(conn: Conn, msg: HelloMsg): Promise<void> {
    const ws = conn.ws;
    if (msg.v !== PROTOCOL_VERSION) return this.error(ws, 'version', `hub speaks v${PROTOCOL_VERSION}`);
    const t = mono();
    if (!this.hellos.hit(conn.key, t)) return this.error(ws, 'rate-limited', 'too many hellos; slow down', { retryAfterMs: this.hellos.retryAfter(conn.key, t) });
    // A second hello on the same socket moves it cleanly (no ghost peer left behind).
    if (conn.me) this.leave(conn);
    const code = normalizeCode(msg.code);
    let room: Room | null;
    if (msg.role === 'mic') {
      if (this.misses.full(conn.key, t))
        return this.error(ws, 'rate-limited', 'too many wrong codes; wait before trying again', { retryAfterMs: this.misses.retryAfter(conn.key, t) });
      room = code ? (this.rooms.get(code) ?? null) : null;
      if (!room) {
        this.misses.hit(conn.key, t);
        return this.error(ws, 'unknown-code', `no TV is showing code ${code || '(none)'}`);
      }
    } else {
      // A screen naming a code joins that room if it exists, so a screen probing codes is a guess like a mic's:
      // a miss (which creates the room, as a resume after a hub restart does) counts against the same budget.
      const explicit = isPairingCode(code);
      if (explicit && !this.rooms.has(code)) {
        if (this.misses.full(conn.key, t))
          return this.error(ws, 'rate-limited', 'too many unknown codes; wait before trying again', { retryAfterMs: this.misses.retryAfter(conn.key, t) });
        this.misses.hit(conn.key, t);
      }
      room = this.tryCreateRoom(explicit ? code : undefined);
      if (!room) return this.error(ws, 'full', 'the hub has no free room');
    }
    const old = room.peers.get(msg.clientId);
    if (!old && room.peers.size >= this.limits.maxPeersPerRoom) return this.error(ws, 'full', `room ${room.code} is full`);
    if (old && old.socket !== ws) {
      if ((await this.claim(old, msg)) === 'refuse') return this.error(ws, 'id-in-use', 'another live connection holds this clientId');
      old.socket.terminate();
      if (ws.readyState !== ws.OPEN) return;
      if (this.rooms.get(room.code) !== room) {
        // The room closed while the old holder was probed.
        if (msg.role === 'mic') return this.error(ws, 'unknown-code', `no TV is showing code ${room.code}`);
        room = this.tryCreateRoom(room.code);
        if (!room) return this.error(ws, 'full', 'the hub has no free room');
      }
    }
    this.join(conn, room, msg);
  }

  /**
   * Decide whether a hello may take a clientId that another socket holds. The same role is required. The holder
   * is replaced when its socket is already closing, when the hello carries the holder's resumeToken (or neither has
   * one, as 0.1 clients did), or when the holder does not answer a ping within `conflictProbeMs`.
   */
  private async claim(old: Peer, msg: HelloMsg): Promise<'replace' | 'refuse'> {
    if (old.role !== msg.role) return 'refuse';
    if (old.socket.readyState !== old.socket.OPEN) return 'replace';
    if (this.tokenOf.get(old.socket) === msg.resumeToken) return 'replace';
    return (await this.probe(old.socket)) ? 'refuse' : 'replace';
  }

  /** True when the socket shows any sign of life (pong or message) within the probe window. */
  private probe(ws: WebSocket): Promise<boolean> {
    const ms = this.opts.conflictProbeMs ?? 2_000;
    return new Promise((resolve) => {
      let done = false;
      const finish = (alive: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.off('pong', yes);
        ws.off('message', yes);
        ws.off('close', no);
        resolve(alive);
      };
      const yes = () => finish(true);
      const no = () => finish(false);
      const timer = setTimeout(no, ms);
      ws.on('pong', yes);
      ws.on('message', yes);
      ws.on('close', no);
      try {
        ws.ping();
      } catch {
        finish(false);
      }
    });
  }

  private join(conn: Conn, room: Room, msg: HelloMsg) {
    const ws = conn.ws;
    const me: Peer = { clientId: msg.clientId, role: msg.role, name: msg.name, socket: ws };
    room.peers.set(me.clientId, me);
    if (msg.resumeToken) this.tokenOf.set(ws, msg.resumeToken);
    else this.tokenOf.delete(ws);
    if (me.role === 'screen') this.screenlessSince.delete(room);
    conn.room = room;
    conn.me = me;
    const joinUrl = this.call('joinUrl', () => this.opts.joinUrl?.(room.code));
    this.send(ws, {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      clientId: me.clientId,
      role: me.role,
      code: room.code,
      joinUrl: typeof joinUrl === 'string' ? joinUrl : undefined,
      peers: this.peersOf(room),
      serverTime: this.now(),
    });
    this.broadcast(room, { type: 'peers', peers: this.peersOf(room) });
    this.log('join', { code: room.code, role: me.role, clientId: me.clientId });
    this.call('onJoin', () => this.opts.onJoin?.(room, me));
  }

  private leave(conn: Conn) {
    const { room, me } = conn;
    conn.room = null;
    conn.me = null;
    if (!room || !me || room.peers.get(me.clientId)?.socket !== conn.ws) return;
    room.peers.delete(me.clientId);
    const live = this.rooms.get(room.code) === room;
    if (live && me.role === 'screen' && ![...room.peers.values()].some((p) => p.role === 'screen')) this.screenlessSince.set(room, mono());
    this.broadcast(room, { type: 'peers', peers: this.peersOf(room) });
    this.log('leave', { code: room.code, role: me.role, clientId: me.clientId });
    this.call('onLeave', () => this.opts.onLeave?.(room, me));
    if (live && this.graceMs <= 0 && this.screenlessSince.has(room)) this.closeRoom(room, 'expired');
  }

  private async dispatch(room: Room, utteranceId: string, from: PeerInfo, hops: Hop[], run: () => Promise<IntentResult> | IntentResult) {
    try {
      const res = await run();
      if (!res) return;
      const intent: IntentMsg = { type: 'intent', utteranceId, name: String(res.name), ok: res.ok === true, payload: res.payload, from: from.clientId, hops: this.stamp(hops, 'hub.intent') };
      this.broadcast(room, intent);
    } catch (err) {
      const message = errorText(err);
      this.handlerError('dispatch', err);
      this.broadcast(room, { type: 'error', code: 'handler-failed', message, utteranceId });
    }
  }

  /** Stop accepting, disconnect everyone, and detach from the HTTP servers (a new hub can attach to them). */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const srv of this.servers) srv.off('upgrade', this.onUpgrade);
    for (const conn of this.conns) conn.ws.terminate();
    for (const room of [...this.rooms.values()]) {
      this.rooms.delete(room.code);
      this.call('onRoomClose', () => this.opts.onRoomClose?.(room, 'closed'));
    }
    this.wss.close();
  }
}

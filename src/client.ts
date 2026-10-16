import {
  PROTOCOL_VERSION,
  decode,
  encode,
  newId,
  type BridgeMessage,
  type Hop,
  type IntentMsg,
  type MessageOf,
  type MessageType,
  type Role,
  type SayPayload,
  type SayStatus,
  type WelcomeMsg,
  SAY_STATUS_TOPIC,
  SAY_TOPIC,
  parseSay,
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

export interface ClientOptions {
  url: string;
  role: Role;
  code?: string;
  name?: string;
  clientId?: string;
  /** Browser/Node 22+ have a global WebSocket; pass one otherwise. */
  WebSocketImpl?: new (url: string) => WSLike;
  reconnect?: boolean;
  /** Clock samples for the hub offset estimate. */
  clockSamples?: number;
}

type Handler<T extends MessageType> = (m: MessageOf<T>) => void;

/** Framework-agnostic client for both roles. Works in browsers, React Native and Node. */
export class BridgeClient {
  readonly clientId: string;
  code: string | undefined;
  /** hub clock - local clock, from the best (lowest RTT) ping sample */
  offsetMs = 0;
  rttMs: number | null = null;
  connected = false;
  private ws: WSLike | null = null;
  private handlers = new Map<string, Set<(m: BridgeMessage) => void>>();
  private closedByUser = false;
  private retry = 0;
  private bestRtt = Infinity;

  constructor(private readonly opts: ClientOptions) {
    this.clientId = opts.clientId ?? newId(opts.role);
    this.code = opts.code;
  }

  on<T extends MessageType>(type: T | 'open' | 'close', fn: Handler<T> | (() => void)): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(fn as (m: BridgeMessage) => void);
    this.handlers.set(type, set);
    return () => set.delete(fn as (m: BridgeMessage) => void);
  }

  private emit(type: string, m?: BridgeMessage) {
    for (const fn of this.handlers.get(type) ?? []) fn(m as BridgeMessage);
  }

  /** Local time mapped to hub clock. */
  now(): number {
    return performance.timeOrigin + performance.now() + this.offsetMs;
  }

  hop(name: string): Hop {
    return { hop: name, at: this.now() };
  }

  connect(): Promise<WelcomeMsg> {
    this.closedByUser = false;
    const WS = this.opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket: new (url: string) => WSLike }).WebSocket;
    return new Promise((resolve, reject) => {
      const ws = new WS(this.opts.url);
      this.ws = ws;
      let welcomed = false;
      ws.onopen = () => {
        this.send({ type: 'hello', v: PROTOCOL_VERSION, role: this.opts.role, clientId: this.clientId, code: this.code, name: this.opts.name });
      };
      ws.onmessage = (ev) => {
        const m = decode(String(ev.data));
        if (!m) return;
        if (m.type === 'welcome') {
          welcomed = true;
          this.connected = true;
          this.code = m.code;
          this.retry = 0;
          this.offsetMs = m.serverTime - (performance.timeOrigin + performance.now());
          void this.syncClock();
          resolve(m);
          this.emit('open');
        }
        if (m.type === 'pong') this.onPong(m);
        if (m.type === 'error' && !welcomed) reject(new Error(`${m.code}: ${m.message}`));
        this.emit(m.type, m);
      };
      ws.onerror = () => {
        if (!welcomed) reject(new Error(`cannot connect to ${this.opts.url}`));
      };
      ws.onclose = () => {
        this.connected = false;
        this.emit('close');
        if (!this.closedByUser && this.opts.reconnect !== false && welcomed) {
          const delay = Math.min(5000, 250 * 2 ** this.retry++);
          setTimeout(() => this.connect().catch(() => undefined), delay);
        }
      };
    });
  }

  private onPong(m: MessageOf<'pong'>) {
    const t1 = performance.timeOrigin + performance.now();
    const rtt = t1 - m.t0;
    if (rtt < this.bestRtt) {
      this.bestRtt = rtt;
      this.rttMs = Math.round(rtt);
      this.offsetMs = m.serverTime + rtt / 2 - t1;
    }
  }

  async syncClock(samples = this.opts.clockSamples ?? 5): Promise<void> {
    for (let i = 0; i < samples; i++) {
      this.send({ type: 'ping', t0: performance.timeOrigin + performance.now() });
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  send(m: BridgeMessage) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encode(m));
  }

  /** Mic: send a final transcript. speechEndAt is local (performance.timeOrigin + now) time of speech end. */
  sendFinal(text: string, opts: { speechEndAt?: number; utteranceId?: string } = {}): string {
    const utteranceId = opts.utteranceId ?? newId('utt');
    const hops: Hop[] = [];
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

  /** Screen: report playback of a line back to the hub (loading / playing / ended / error ...). */
  reportSay(status: Omit<SayStatus, 'at'> & { at?: number }, topic: string = SAY_STATUS_TOPIC) {
    this.sendApp(topic, { ...status, at: status.at ?? Date.now() });
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}

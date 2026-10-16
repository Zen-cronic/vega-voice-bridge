import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  isPairingCode,
  makePairingCode,
  normalizeCode,
  type AppMsg,
  type BridgeMessage,
  type FinalMsg,
  type Hop,
  type IntentMsg,
  type PeerInfo,
  type Role,
  type SayPayload,
  SAY_TOPIC,
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
  onAck?: (room: Room, msg: Extract<BridgeMessage, { type: 'ack' }>) => void;
  clock?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** WebSocket hub: pairing rooms, transcript fan-out, intent dispatch and ack forwarding with hop stamps. */
export class BridgeHub {
  readonly rooms = new Map<string, Room>();
  private wss: WebSocketServer;
  private clock: () => number;

  constructor(private readonly opts: HubOptions) {
    this.clock = opts.clock ?? (() => performance.timeOrigin + performance.now());
    this.wss = new WebSocketServer({ noServer: true });
    const path = opts.path ?? '/ws';
    for (const srv of Array.isArray(opts.server) ? opts.server : [opts.server]) {
      srv.on('upgrade', (req: IncomingMessage, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname !== path) return;
        this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
      });
    }
  }

  now(): number {
    return this.clock();
  }

  private log(event: string, data?: Record<string, unknown>) {
    this.opts.log?.(event, data);
  }

  createRoom(code?: string): Room {
    let c = code && isPairingCode(code) ? code : makePairingCode();
    while (!code && this.rooms.has(c)) c = makePairingCode();
    const existing = this.rooms.get(c);
    if (existing) return existing;
    const room: Room = { code: c, peers: new Map(), createdAt: this.now() };
    this.rooms.set(c, room);
    return room;
  }

  send(socket: WebSocket, msg: BridgeMessage) {
    if (socket.readyState === socket.OPEN) socket.send(encode(msg));
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
    return payload;
  }

  peersOf(room: Room): PeerInfo[] {
    return [...room.peers.values()].map(({ clientId, role, name }) => ({ clientId, role, name }));
  }

  private stamp(hops: Hop[] | undefined, hop: string): Hop[] {
    return [...(hops ?? []), { hop, at: this.now() }];
  }

  private accept(ws: WebSocket) {
    let room: Room | null = null;
    let me: Peer | null = null;
    ws.on('message', async (data) => {
      const msg = decode(String(data));
      if (!msg) return this.send(ws, { type: 'error', code: 'bad-message', message: 'unparseable or unknown message' });
      if (msg.type === 'ping') return this.send(ws, { type: 'pong', t0: msg.t0, serverTime: this.now() });
      if (msg.type === 'hello') {
        if (msg.v !== PROTOCOL_VERSION) return this.send(ws, { type: 'error', code: 'version', message: `hub speaks v${PROTOCOL_VERSION}` });
        const code = msg.code ? normalizeCode(msg.code) : undefined;
        if (msg.role === 'mic') {
          room = code ? (this.rooms.get(code) ?? null) : null;
          if (!room) return this.send(ws, { type: 'error', code: 'unknown-code', message: `no TV is showing code ${code ?? '(none)'}` });
        } else room = this.createRoom(code);
        const old = room.peers.get(msg.clientId);
        if (old && old.socket !== ws) old.socket.terminate();
        me = { clientId: msg.clientId, role: msg.role, name: msg.name, socket: ws };
        room.peers.set(me.clientId, me);
        this.send(ws, { type: 'welcome', v: PROTOCOL_VERSION, clientId: me.clientId, role: me.role, code: room.code, joinUrl: this.opts.joinUrl?.(room.code), peers: this.peersOf(room), serverTime: this.now() });
        this.broadcast(room, { type: 'peers', peers: this.peersOf(room) });
        this.log('join', { code: room.code, role: me.role, clientId: me.clientId });
        this.opts.onJoin?.(room, me);
        return;
      }
      if (!room || !me) return this.send(ws, { type: 'error', code: 'bad-message', message: 'say hello first' });
      const r = room;
      const from: PeerInfo = { clientId: me.clientId, role: me.role, name: me.name };
      switch (msg.type) {
        case 'transcript.partial':
          this.broadcast(r, { ...msg, from: from.clientId }, ['screen']);
          return;
        case 'transcript.final': {
          const hops = this.stamp(msg.hops, 'hub.recv');
          const final: FinalMsg = { ...msg, from: from.clientId, hops };
          this.broadcast(r, final, ['screen']);
          await this.dispatch(r, msg.utteranceId, from, hops, () => this.opts.onFinal?.(r, final, from));
          return;
        }
        case 'app': {
          if (!msg.utteranceId) {
            await this.opts.onApp?.(r, { ...msg, from: from.clientId }, from);
            return;
          }
          const hops = this.stamp(msg.hops, 'hub.recv');
          await this.dispatch(r, msg.utteranceId, from, hops, () => this.opts.onApp?.(r, { ...msg, from: from.clientId, hops }, from));
          return;
        }
        case 'ack': {
          const ack = { ...msg, hops: this.stamp(msg.hops, 'hub.ack') };
          this.opts.onAck?.(r, ack);
          this.broadcast(r, ack, ['mic']);
          return;
        }
        default:
          return;
      }
    });
    ws.on('close', () => {
      if (room && me && room.peers.get(me.clientId)?.socket === ws) {
        room.peers.delete(me.clientId);
        this.broadcast(room, { type: 'peers', peers: this.peersOf(room) });
        this.log('leave', { code: room.code, role: me.role, clientId: me.clientId });
        this.opts.onLeave?.(room, me);
      }
    });
  }

  private async dispatch(room: Room, utteranceId: string, from: PeerInfo, hops: Hop[], run: () => Promise<IntentResult> | IntentResult) {
    try {
      const res = await run();
      if (!res) return;
      const intent: IntentMsg = { type: 'intent', utteranceId, name: res.name, ok: res.ok, payload: res.payload, from: from.clientId, hops: this.stamp(hops, 'hub.intent') };
      this.broadcast(room, intent);
    } catch (err) {
      this.log('handler-failed', { error: (err as Error).message });
      this.broadcast(room, { type: 'error', code: 'handler-failed', message: (err as Error).message, utteranceId });
    }
  }

  close() {
    for (const room of this.rooms.values()) for (const p of room.peers.values()) p.socket.terminate();
    this.wss.close();
  }
}

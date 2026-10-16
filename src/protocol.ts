/**
 * tv-voice-bridge protocol v1: the phone is the microphone for a TV app.
 *
 * Roles: `screen` (the TV app), `mic` (a phone), and the hub (a small WebSocket server).
 * Every utterance carries `hops`: timestamps in HUB clock (clients correct with ping/pong offset),
 * so "speech end -> TV render" can be measured across three devices.
 */
export const PROTOCOL_VERSION = 1 as const;

export type Role = 'screen' | 'mic';

export interface Hop {
  hop: string;
  /** milliseconds, hub clock */
  at: number;
}

export interface PeerInfo {
  clientId: string;
  role: Role;
  name?: string;
}

export type HelloMsg = { type: 'hello'; v: typeof PROTOCOL_VERSION; role: Role; clientId: string; code?: string; name?: string };
export type WelcomeMsg = { type: 'welcome'; v: typeof PROTOCOL_VERSION; clientId: string; role: Role; code: string; joinUrl?: string; peers: PeerInfo[]; serverTime: number };
export type PeersMsg = { type: 'peers'; peers: PeerInfo[] };
export type ErrorMsg = { type: 'error'; code: 'unknown-code' | 'bad-message' | 'version' | 'handler-failed'; message: string; utteranceId?: string };
export type PingMsg = { type: 'ping'; t0: number };
export type PongMsg = { type: 'pong'; t0: number; serverTime: number };
export type PartialMsg = { type: 'transcript.partial'; utteranceId: string; text: string; from?: string; hops: Hop[] };
export type FinalMsg = { type: 'transcript.final'; utteranceId: string; text: string; from?: string; hops: Hop[] };
/** What the app understood. `payload` is app-defined (for example the parsed command plus the new screen state). */
export type IntentMsg = { type: 'intent'; utteranceId: string; name: string; ok: boolean; payload: unknown; from?: string; hops: Hop[] };
/** Screen confirms it rendered the intent; the hub forwards to mics so they can show end-to-end latency. */
export type AckMsg = { type: 'ack'; utteranceId: string; stage: 'rendered' | 'error'; detail?: string; hops: Hop[] };
/** App-defined side channel (taps, state pushes). With an utteranceId it can also produce an intent. */
export type AppMsg = { type: 'app'; topic: string; payload: unknown; from?: string; utteranceId?: string; hops?: Hop[] };

export type BridgeMessage =
  | HelloMsg
  | WelcomeMsg
  | PeersMsg
  | ErrorMsg
  | PingMsg
  | PongMsg
  | PartialMsg
  | FinalMsg
  | IntentMsg
  | AckMsg
  | AppMsg;

export type MessageType = BridgeMessage['type'];

/**
 * TV -> room speech ("the TV talks back"): the generic `screen.say` capability, carried on the `app` channel.
 * The hub (your app) sends a line to the room's screens; each screen plays `audioUrl` if it can (or speaks `text`
 * with a local TTS) and shows `text` as a caption. `priority: 'high'` interrupts the current line; `normal` queues.
 * Screens may report playback back on `screen.say.status`. Apps may use their own topic name (a coaching app
 * might use `coach.say`); the payload contract is the same.
 */
export const SAY_TOPIC = 'screen.say' as const;
export const SAY_STATUS_TOPIC = 'screen.say.status' as const;

export interface SayPayload {
  id: string;
  /** What is said, also the caption. */
  text: string;
  /** Absolute https URL (needed on Vega, whose media player refuses http and private CAs) or hub-relative path. */
  audioUrl?: string;
  /** Spoken length; also how long a caption-only screen keeps the caption up. */
  durationMs?: number;
  priority?: 'normal' | 'high';
}

export type SayState = 'loading' | 'playing' | 'ended' | 'interrupted' | 'error' | 'no-audio';
export interface SayStatus {
  id: string;
  state: SayState;
  detail?: string;
  at: number;
}

/** Validate a `screen.say` payload from the wire (defaults: no audio, 3 s, normal priority). */
export function parseSay(p: unknown): Required<SayPayload> | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.text !== 'string') return null;
  return {
    id: o.id,
    text: o.text,
    audioUrl: typeof o.audioUrl === 'string' ? o.audioUrl : '',
    durationMs: typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) && o.durationMs > 0 ? o.durationMs : 3000,
    priority: o.priority === 'high' ? 'high' : 'normal',
  };
}

/** Resolve a hub-relative audioUrl against the hub's origin; absolute URLs pass through. */
export function resolveSayAudio(audioUrl: string, origin: string): string {
  if (!audioUrl) return '';
  if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
  return origin.replace(/\/$/, '') + (audioUrl.startsWith('/') ? '' : '/') + audioUrl;
}
export type MessageOf<T extends MessageType> = Extract<BridgeMessage, { type: T }>;

const TYPES = new Set<MessageType>(['hello', 'welcome', 'peers', 'error', 'ping', 'pong', 'transcript.partial', 'transcript.final', 'intent', 'ack', 'app']);

/** Minimal structural validation; no schema library so the package stays dependency-free. */
export function decode(raw: string): BridgeMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (typeof o.type !== 'string' || !TYPES.has(o.type as MessageType)) return null;
  if ((o.type === 'transcript.final' || o.type === 'transcript.partial') && (typeof o.text !== 'string' || typeof o.utteranceId !== 'string')) return null;
  if (o.type === 'hello' && (o.role !== 'screen' && o.role !== 'mic')) return null;
  if ('hops' in o && o.hops !== undefined && !Array.isArray(o.hops)) return null;
  return o as unknown as BridgeMessage;
}

export const encode = (m: BridgeMessage): string => JSON.stringify(m);

/** Unambiguous alphabet: no 0/O, 1/I/L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makePairingCode(rand: () => number = Math.random, length = 4): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export const isPairingCode = (s: string, length = 4): boolean =>
  s.length === length && [...s].every((c) => CODE_ALPHABET.includes(c));

export const normalizeCode = (s: string): string => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export function newId(prefix = 'u'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface LatencyBreakdown {
  legs: Array<{ from: string; to: string; ms: number }>;
  /** first hop -> last hop */
  totalMs: number | null;
  /** convenience: a named span, e.g. speech.end -> screen.render */
  span(from: string, to: string): number | null;
}

export function latency(hops: Hop[]): LatencyBreakdown {
  const legs = hops.slice(1).map((h, i) => ({ from: hops[i]!.hop, to: h.hop, ms: Math.round(h.at - hops[i]!.at) }));
  const first = hops[0];
  const last = hops[hops.length - 1];
  return {
    legs,
    totalMs: first && last ? Math.round(last.at - first.at) : null,
    span(from, to) {
      const a = hops.find((h) => h.hop === from);
      const b = hops.find((h) => h.hop === to);
      return a && b ? Math.round(b.at - a.at) : null;
    },
  };
}

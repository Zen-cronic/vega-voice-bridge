/**
 * tv-voice-bridge protocol v1: a voice back-and-forth between a phone, an app or agent, and a TV.
 *
 * Roles: `screen` (the TV app), `mic` (a phone), and the hub (a small WebSocket server).
 * Every utterance carries `hops`: timestamps in HUB clock (clients correct with ping/pong offset),
 * so "speech end -> TV render" can be measured across three devices. The normative spec is PROTOCOL.md.
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

/**
 * Error codes. Clients must treat a code they do not know as a failure of the request that caused it.
 * - `unknown-code`: no room has that pairing code (or it closed).
 * - `bad-message`: the frame is not valid JSON or a field has the wrong type or length.
 * - `version`: the hub speaks another protocol version.
 * - `handler-failed`: the app's handler threw for this utterance.
 * - `rate-limited`: too many hellos, wrong codes or messages from this client; see `retryAfterMs`.
 * - `id-in-use`: another live connection holds this clientId (and this hello did not prove it owns it).
 * - `full`: the hub or the room is at capacity.
 * - `not-allowed`: this role may not send this message type.
 */
export type ErrorCode = 'unknown-code' | 'bad-message' | 'version' | 'handler-failed' | 'rate-limited' | 'id-in-use' | 'full' | 'not-allowed';

/**
 * `resumeToken` is a client-held secret that binds `clientId` to this client across reconnects. The hub never echoes it.
 * Optional for backward compatibility: a hello without one is treated as a 0.1 client.
 */
export type HelloMsg = { type: 'hello'; v: typeof PROTOCOL_VERSION; role: Role; clientId: string; code?: string; name?: string; resumeToken?: string };
export type WelcomeMsg = { type: 'welcome'; v: typeof PROTOCOL_VERSION; clientId: string; role: Role; code: string; joinUrl?: string; peers: PeerInfo[]; serverTime: number };
export type PeersMsg = { type: 'peers'; peers: PeerInfo[] };
export type ErrorMsg = { type: 'error'; code: ErrorCode; message: string; utteranceId?: string; retryAfterMs?: number };
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

/** Who may send what to the hub. Everything else is sent by the hub only. */
export const CLIENT_SENDS: Readonly<Record<Role, readonly MessageType[]>> = {
  mic: ['hello', 'ping', 'transcript.partial', 'transcript.final', 'app'],
  screen: ['hello', 'ping', 'ack', 'app'],
};

/**
 * Field limits enforced by `decodeMessage` (characters for strings, entries for arrays).
 * The hub also caps a whole frame at `HubLimits.maxMessageBytes`.
 */
export const FIELD_LIMITS = {
  clientId: 128,
  name: 128,
  code: 32,
  resumeToken: 256,
  utteranceId: 128,
  text: 10_000,
  topic: 128,
  intentName: 128,
  detail: 2_000,
  errorMessage: 2_000,
  url: 2_048,
  hopName: 64,
  hops: 64,
  peers: 1_000,
} as const;

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
  /** Absolute URL or hub-relative path. On Vega: publicly trusted https, or fragmented MP4/AAC over http (see `./vega`). */
  audioUrl?: string;
  /** Spoken length; also how long a caption-only screen keeps the caption up. */
  durationMs?: number;
  priority?: 'normal' | 'high';
}

export type SayState = 'loading' | 'playing' | 'ended' | 'interrupted' | 'error' | 'no-audio';
export const SAY_STATES: readonly SayState[] = ['loading', 'playing', 'ended', 'interrupted', 'error', 'no-audio'];
export interface SayStatus {
  id: string;
  state: SayState;
  detail?: string;
  at: number;
  /** What the line says (optional). Lets a phone's echo guard recognize the TV's words for lines the TV started itself. */
  text?: string;
}

/**
 * Hub -> the room's mics: what the TV is saying, so a phone in the same room can keep its microphone from sending
 * the TV's own voice back (the echo guard). The hub sends `queued` when it dispatches a say line, then relays each
 * `screen.say.status` a screen reports. The payload never carries `audioUrl`, which stays with the screens.
 */
export const SPEECH_TOPIC = 'screen.speech' as const;
/** Mic -> hub -> the room's screens: stop the current line and drop the queue (barge-in, or a stop button). */
export const SAY_STOP_TOPIC = 'screen.say.stop' as const;

export type SpeechState = 'queued' | SayState;
export interface SpeechNotice {
  id: string;
  state: SpeechState;
  /** Hub clock. */
  at: number;
  text?: string;
  durationMs?: number;
}
export interface SayStop {
  /** The line being interrupted, when the sender knows it. Screens stop the current line either way. */
  id?: string;
  reason?: string;
}

/** True for `screen.say.status` and app-named status topics such as `coach.say.status`. */
export const isSayStatusTopic = (topic: string): boolean => topic === SAY_STATUS_TOPIC || topic.endsWith('.say.status');

const optStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Validate a `screen.say.status` payload from the wire. A missing or invalid `at` becomes `fallbackAt`. */
export function parseSayStatus(p: unknown, fallbackAt = NaN): SayStatus | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > FIELD_LIMITS.utteranceId) return null;
  if (!SAY_STATES.includes(o.state as SayState)) return null;
  const out: SayStatus = { id: o.id, state: o.state as SayState, at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : fallbackAt };
  const detail = optStr(o.detail, FIELD_LIMITS.detail);
  const text = optStr(o.text, FIELD_LIMITS.text);
  if (detail !== undefined) out.detail = detail;
  if (text !== undefined) out.text = text;
  return out;
}

/** Validate a `screen.speech` payload from the wire. */
export function parseSpeech(p: unknown): SpeechNotice | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || o.id.length > FIELD_LIMITS.utteranceId) return null;
  if (o.state !== 'queued' && !SAY_STATES.includes(o.state as SayState)) return null;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const out: SpeechNotice = { id: o.id, state: o.state as SpeechState, at: o.at };
  const text = optStr(o.text, FIELD_LIMITS.text);
  if (text !== undefined) out.text = text;
  if (typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) && o.durationMs > 0) out.durationMs = o.durationMs;
  return out;
}

/** Validate a `screen.say.stop` payload (anything else, including no payload, is a plain stop). */
export function parseSayStop(p: unknown): SayStop {
  const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  const out: SayStop = {};
  const id = optStr(o.id, FIELD_LIMITS.utteranceId);
  const reason = optStr(o.reason, FIELD_LIMITS.topic);
  if (id) out.id = id;
  if (reason) out.reason = reason;
  return out;
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

/** Resolve a hub-relative audioUrl against the hub's origin; absolute and protocol-relative URLs keep their host. */
export function resolveSayAudio(audioUrl: string, origin: string): string {
  if (!audioUrl) return '';
  if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
  if (audioUrl.startsWith('//')) {
    const scheme = /^(https?:)/i.exec(origin)?.[1]?.toLowerCase() ?? 'https:';
    return scheme + audioUrl;
  }
  return origin.replace(/\/$/, '') + (audioUrl.startsWith('/') ? '' : '/') + audioUrl;
}
export type MessageOf<T extends MessageType> = Extract<BridgeMessage, { type: T }>;

export type DecodeResult = { ok: true; msg: BridgeMessage } | { ok: false; error: string; reason: 'json' | 'shape' };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Field checks. Each returns an error string or null. Optional fields may be absent or null (null is dropped,
 * so a Python or Kotlin client that serializes `None` still conforms).
 */
function str(o: Obj, key: string, max: number, opt: { required?: boolean; min?: number } = {}): string | null {
  const v = o[key];
  if (v === undefined || v === null) {
    if (opt.required) return `${String(o.type)}.${key} is required`;
    delete o[key];
    return null;
  }
  if (typeof v !== 'string') return `${String(o.type)}.${key} must be a string`;
  if (v.length < (opt.min ?? 0) || v.length > max) return `${String(o.type)}.${key} must be ${opt.min ?? 0}..${max} characters`;
  return null;
}

function num(o: Obj, key: string, required = true): string | null {
  const v = o[key];
  if ((v === undefined || v === null) && !required) {
    delete o[key];
    return null;
  }
  return isNum(v) ? null : `${String(o.type)}.${key} must be a finite number`;
}

function hops(o: Obj, required: boolean): string | null {
  const v = o.hops;
  if (v === undefined || v === null) {
    if (required) o.hops = [];
    else delete o.hops;
    return null;
  }
  if (!Array.isArray(v)) return `${String(o.type)}.hops must be an array`;
  if (v.length > FIELD_LIMITS.hops) return `${String(o.type)}.hops has more than ${FIELD_LIMITS.hops} entries`;
  for (const h of v) {
    if (!isObj(h) || typeof h.hop !== 'string' || !h.hop || h.hop.length > FIELD_LIMITS.hopName || !isNum(h.at))
      return `${String(o.type)}.hops entries must be {hop: string, at: number}`;
  }
  return null;
}

function peers(o: Obj): string | null {
  const v = o.peers;
  if (!Array.isArray(v) || v.length > FIELD_LIMITS.peers) return `${String(o.type)}.peers must be an array of at most ${FIELD_LIMITS.peers}`;
  for (const p of v) {
    if (!isObj(p) || typeof p.clientId !== 'string' || (p.role !== 'screen' && p.role !== 'mic') || (p.name != null && typeof p.name !== 'string'))
      return `${String(o.type)}.peers entries must be {clientId, role, name?}`;
  }
  return null;
}

const first = (...errs: Array<string | null>): string | null => errs.find((e) => e !== null) ?? null;

function check(o: Obj): string | null {
  const L = FIELD_LIMITS;
  switch (o.type) {
    case 'hello':
      if (!isNum(o.v)) return 'hello.v must be a number';
      if (o.v !== PROTOCOL_VERSION) return null; // a future version: the hub answers `version`, not bad-message
      if (o.role !== 'screen' && o.role !== 'mic') return 'hello.role must be "screen" or "mic"';
      return first(
        str(o, 'clientId', L.clientId, { required: true, min: 1 }),
        str(o, 'code', L.code),
        str(o, 'name', L.name),
        str(o, 'resumeToken', L.resumeToken),
      );
    case 'welcome':
      if (!isNum(o.v)) return 'welcome.v must be a number';
      if (o.role !== 'screen' && o.role !== 'mic') return 'welcome.role must be "screen" or "mic"';
      return first(
        str(o, 'clientId', L.clientId, { required: true, min: 1 }),
        str(o, 'code', L.code, { required: true, min: 1 }),
        str(o, 'joinUrl', L.url),
        peers(o),
        num(o, 'serverTime'),
      );
    case 'peers':
      return peers(o);
    case 'error':
      return first(str(o, 'code', 64, { required: true, min: 1 }), str(o, 'message', L.errorMessage, { required: true }), str(o, 'utteranceId', L.utteranceId), num(o, 'retryAfterMs', false));
    case 'ping':
      return num(o, 't0');
    case 'pong':
      return first(num(o, 't0'), num(o, 'serverTime'));
    case 'transcript.partial':
    case 'transcript.final':
      return first(
        str(o, 'utteranceId', L.utteranceId, { required: true, min: 1 }),
        str(o, 'text', L.text, { required: true }),
        str(o, 'from', L.clientId),
        hops(o, true),
      );
    case 'intent':
      if (typeof o.ok !== 'boolean') return 'intent.ok must be a boolean';
      return first(
        str(o, 'utteranceId', L.utteranceId, { required: true, min: 1 }),
        str(o, 'name', L.intentName, { required: true }),
        str(o, 'from', L.clientId),
        hops(o, true),
      );
    case 'ack':
      if (o.stage !== 'rendered' && o.stage !== 'error') return 'ack.stage must be "rendered" or "error"';
      return first(str(o, 'utteranceId', L.utteranceId, { required: true, min: 1 }), str(o, 'detail', L.detail), hops(o, true));
    case 'app':
      return first(str(o, 'topic', L.topic, { required: true, min: 1 }), str(o, 'from', L.clientId), str(o, 'utteranceId', L.utteranceId), hops(o, false));
    default:
      return typeof o.type === 'string' ? `unknown message type "${o.type.slice(0, 40)}"` : 'type must be a string';
  }
}

/**
 * Parse and validate one wire message: every field's type and length, per message type. Never throws.
 * Returns a typed error (`reason: 'json'` when the text is not one JSON value, `'shape'` when a field is wrong).
 */
export function decodeMessage(raw: string): DecodeResult {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'json', error: 'not a JSON object' };
  }
  if (!isObj(m)) return { ok: false, reason: 'shape', error: 'a message must be a JSON object' };
  try {
    const err = check(m);
    return err ? { ok: false, reason: 'shape', error: err } : { ok: true, msg: m as unknown as BridgeMessage };
  } catch {
    return { ok: false, reason: 'shape', error: 'invalid message' };
  }
}

/** Validating decode; returns null for anything invalid (see `decodeMessage` for the reason). */
export function decode(raw: string): BridgeMessage | null {
  const r = decodeMessage(raw);
  return r.ok ? r.msg : null;
}

export const encode = (m: BridgeMessage): string => JSON.stringify(m);

/** Unambiguous alphabet: no 0/O, 1/I/L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Uniform [0, 1) from the platform CSPRNG when there is one (browsers, Node 20+), else Math.random. */
export function secureRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0]! / 2 ** 32;
  }
  return Math.random();
}

export function makePairingCode(rand: () => number = secureRandom, length = 4): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[Math.min(CODE_ALPHABET.length - 1, Math.floor(rand() * CODE_ALPHABET.length))];
  return s;
}

export const isPairingCode = (s: unknown, length = 4): s is string =>
  typeof s === 'string' && s.length === length && [...s].every((c) => CODE_ALPHABET.includes(c));

/** Upper-case and strip separators. Non-strings normalize to '' (never throws). */
export const normalizeCode = (s: unknown): string => (typeof s === 'string' ? s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

export function newId(prefix = 'u'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(secureRandom() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

/** 128-bit random hex token (the client's `resumeToken`). */
export function newToken(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(secureRandom() * 2 ** 32).toString(16).padStart(8, '0');
  return s;
}

export interface LatencyBreakdown {
  legs: Array<{ from: string; to: string; ms: number }>;
  /** first hop -> last hop */
  totalMs: number | null;
  /** convenience: a named span, e.g. speech.end -> screen.render */
  span(from: string, to: string): number | null;
}

/** Per-leg latency of a hop list. Malformed entries are skipped, so this never throws on wire data. */
export function latency(input: readonly Hop[] | null | undefined): LatencyBreakdown {
  const hops = (Array.isArray(input) ? input : []).filter((h): h is Hop => isObj(h) && typeof h.hop === 'string' && isNum(h.at));
  const legs = hops.slice(1).map((h, i) => ({ from: hops[i]!.hop, to: h.hop, ms: Math.round(h.at - hops[i]!.at) }));
  const firstHop = hops[0];
  const last = hops[hops.length - 1];
  return {
    legs,
    totalMs: firstHop && last ? Math.round(last.at - firstHop.at) : null,
    span(from, to) {
      const a = hops.find((h) => h.hop === from);
      const b = hops.find((h) => h.hop === to);
      return a && b ? Math.round(b.at - a.at) : null;
    },
  };
}

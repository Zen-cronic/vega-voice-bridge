/**
 * The voice half, for a phone browser page: connect as a mic, turn Web Speech results into transcripts with
 * `speech.start` / `speech.end` hops, and keep the TV's own voice out of the microphone.
 *
 * The echo guard: the phone and the TV's speaker share a room, so while the TV is saying something the phone's
 * recognizer hears it. The hub tells mics what the TV is saying (`screen.speech`: queued, loading, playing, then
 * ended / interrupted / error / no-audio). From a line being queued until it ends, plus a short tail, the mic drops
 * what it hears (or pauses the recognizer). Optionally, a user who talks over the TV interrupts it (barge-in):
 * the mic sends `screen.say.stop`, which the TV honours.
 */
import { BridgeClient, localNow, type ClientOptions } from './client.js';
import { isPairingCode, newId, normalizeCode, type SpeechNotice } from './protocol.js';

/** The pairing code in a join URL's path: the last path segment, normalized (`/p/k7qf` gives `K7QF`). */
export function codeFromPath(pathname: string): string | null {
  const segments = String(pathname ?? '').split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  let raw = last;
  try {
    raw = decodeURIComponent(last);
  } catch {
    // keep it as is
  }
  const code = normalizeCode(raw);
  return isPairingCode(code) ? code : null;
}

type LocationLike = { protocol: string; host: string; pathname: string };
const currentLocation = (): LocationLike | undefined => (globalThis as { location?: LocationLike }).location;

/** The hub's WebSocket URL on the page's own host: `wss://host/ws` on https, `ws://host/ws` otherwise. */
export function hubUrlFromLocation(loc: LocationLike | undefined = currentLocation(), path = '/ws'): string {
  if (!loc) throw new Error('tv-voice-bridge: no location to derive the hub URL from; pass url');
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${path}`;
}

export interface ConnectPhoneOptions extends Omit<ClientOptions, 'role' | 'url' | 'code'> {
  /** Default: the page's host, path `/ws`. */
  url?: string;
  /** Default: the code in the page's path (`/p/K7QF`). */
  code?: string;
  /** The first connection attempt failed (with reconnect on, the client keeps trying; watch `status`). */
  onError?: (err: Error) => void;
}

/** Connect this page as the room's mic. Throws when there is no pairing code to join with. */
export function connectPhone(opts: ConnectPhoneOptions = {}): BridgeClient {
  const { url, code, onError, ...rest } = opts;
  const loc = currentLocation();
  const joinCode = code ?? (loc ? codeFromPath(loc.pathname) : null);
  if (!joinCode) throw new Error('tv-voice-bridge: no pairing code; pass code, or open the join URL (/p/<code>)');
  const client = new BridgeClient({ ...rest, url: url ?? hubUrlFromLocation(loc), role: 'mic', code: joinCode });
  client.connect().catch((err: unknown) => onError?.(err instanceof Error ? err : new Error(String(err))));
  return client;
}

// Web Speech, reduced to what the mic uses (so tests and other recognizers can stand in).
export interface RecognitionAlternativeLike {
  transcript: string;
}
export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternativeLike;
}
export interface RecognitionEventLike {
  resultIndex: number;
  results: { readonly length: number; [index: number]: RecognitionResultLike };
}
export interface RecognizerLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((ev: unknown) => void) | null;
  onresult: ((ev: RecognitionEventLike) => void) | null;
  onerror: ((ev: { error: string; message?: string }) => void) | null;
  onend: ((ev: unknown) => void) | null;
  onspeechstart?: ((ev: unknown) => void) | null;
  onspeechend?: ((ev: unknown) => void) | null;
}
export type RecognizerFactory = () => RecognizerLike;

/** The platform's recognizer (`SpeechRecognition`, or Safari's `webkitSpeechRecognition`), if there is one. */
export function webSpeechRecognizer(): RecognizerFactory | null {
  const g = globalThis as { SpeechRecognition?: new () => RecognizerLike; webkitSpeechRecognition?: new () => RecognizerLike };
  const Ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return Ctor ? () => new Ctor() : null;
}

export type PhoneMicMode = 'push-to-talk' | 'continuous';
/** `guarded`: listening, but the TV is talking, so what the mic hears is dropped (or the recognizer is paused). */
export type PhoneMicState = 'idle' | 'starting' | 'listening' | 'guarded' | 'error';
export type PhoneMicErrorCode = 'no-support' | 'insecure-context' | 'permission-denied' | 'no-microphone' | 'network' | 'no-speech' | 'language' | 'recognizer';

export class PhoneMicError extends Error {
  constructor(
    readonly code: PhoneMicErrorCode,
    message: string,
    /** Fatal errors stop the mic; `start()` again after fixing the cause. */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'PhoneMicError';
  }
}

export interface EchoGuardOptions {
  /** Keep guarding this long after a line ends or is interrupted (room reverb, the recognizer's lag). Default 700 ms. */
  tailMs?: number;
  /** Never guard one line longer than this without hearing from the screen. Default 20 s. */
  maxHoldMs?: number;
  /** `drop` (default) keeps the recognizer running and discards what it hears; `pause` aborts it and restarts after (continuous mode). */
  mode?: 'drop' | 'pause';
  /** Also drop a final that repeats the TV's last words, a few seconds after a line (a late echo). Default true. */
  matchText?: boolean;
  /**
   * Let the user talk over the TV: speech during a line that does not sound like the line itself (at least
   * `minWords` words, mostly not the TV's) sends `screen.say.stop` and is kept. Default off.
   */
  bargeIn?: boolean | { minWords?: number };
}

export interface PhoneMicOptions {
  client: BridgeClient;
  /** BCP 47 language tag. Default: the recognizer's default (the page language). */
  lang?: string;
  /** `push-to-talk` (default): `start()` on press, `stop()` on release. `continuous`: listen until `stop()`, restarting as sessions end. */
  mode?: PhoneMicMode;
  /** A recognizer to use instead of Web Speech (tests, or another engine with the same shape). */
  recognizer?: RecognizerFactory;
  /** At most one `transcript.partial` this often. Default 150 ms. */
  partialEveryMs?: number;
  /** On by default. `false` sends whatever the mic hears, including the TV. */
  echoGuard?: boolean | EchoGuardOptions;
  /** Continuous mode: wait this long before restarting an ended session; doubles while sessions end quickly, up to 5 s. Default 250 ms. */
  restartDelayMs?: number;
  /** Override secure-context detection (tests). Default: `globalThis.isSecureContext`. */
  secureContext?: boolean;
  /** Local clock (epoch ms). Default `localNow`. */
  now?: () => number;
}

export interface PhoneMicFinal {
  utteranceId: string;
  text: string;
  speechStartAt: number;
  speechEndAt: number;
}

export interface PhoneMicEvents {
  state: (state: PhoneMicState) => void;
  partial: (p: { utteranceId: string; text: string }) => void;
  final: (f: PhoneMicFinal) => void;
  /**
   * Heard but not sent: `echo` while the TV was talking, `echo-text` a late repeat of its words,
   * `not-connected` when the link was down (reconnecting), so the page can ask the user to say it again.
   */
  dropped: (d: { text: string; reason: 'echo' | 'echo-text' | 'not-connected' }) => void;
  /** The echo guard switched on (the TV started a line) or off. */
  guard: (active: boolean) => void;
  /** The user talked over the TV; `screen.say.stop` was sent. */
  bargeIn: (b: { text: string; ids: string[] }) => void;
  error: (err: PhoneMicError) => void;
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Share of the heard words that the TV's line contains (0..1). */
export function echoOverlap(heard: string, said: string): number {
  const h = words(heard);
  if (!h.length) return 0;
  const s = new Set(words(said));
  return h.filter((w) => s.has(w)).length / h.length;
}

/** True when `heard` is most likely the TV's own line coming back: the same words, or at least 3 words mostly from it. */
export function isEcho(heard: string, said: string): boolean {
  const h = words(heard);
  if (!h.length) return false;
  if (h.join(' ') === words(said).join(' ')) return true;
  return h.length >= 3 && echoOverlap(heard, said) >= 0.8;
}

interface GuardLine {
  until: number;
  text: string;
  endedAt: number | null;
  released: boolean;
}

/**
 * Tracks what the TV is saying from `screen.speech` notices and answers "is the TV audible right now?". Each line
 * holds the guard from `queued` (for its duration when the screen never reports) through `playing`, until a final
 * state plus `tailMs`. Every hold is capped at `maxHoldMs`.
 */
export class EchoGuard {
  private lines = new Map<string, GuardLine>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wasActive = false;
  readonly tailMs: number;
  readonly maxHoldMs: number;

  constructor(
    private readonly o: { tailMs?: number; maxHoldMs?: number; now?: () => number; onChange?: (active: boolean) => void } = {},
  ) {
    this.tailMs = o.tailMs ?? 700;
    this.maxHoldMs = o.maxHoldMs ?? 20_000;
  }

  private now(): number {
    return (this.o.now ?? localNow)();
  }

  notice(n: Pick<SpeechNotice, 'id' | 'state' | 'text' | 'durationMs'>) {
    const t = this.now();
    let line = this.lines.get(n.id);
    if (!line) {
      line = { until: t, text: n.text ?? '', endedAt: null, released: false };
      this.lines.set(n.id, line);
    }
    if (n.text) line.text = n.text;
    const cap = t + this.maxHoldMs;
    switch (n.state) {
      case 'queued':
        // A screen that never reports still starts at once: hold for the line's length, with slack for dispatch.
        if (!line.released) line.until = Math.max(line.until, Math.min(cap, t + (n.durationMs ?? 3000) + 1000 + this.tailMs));
        break;
      case 'loading':
        if (!line.released) line.until = Math.max(line.until, cap);
        break;
      case 'playing':
        if (!line.released) line.until = Math.max(line.until, n.durationMs ? Math.min(cap, t + n.durationMs + 1000 + this.tailMs) : cap);
        break;
      case 'no-audio':
        // Captions only: nothing is audible.
        line.until = t;
        line.endedAt = t;
        break;
      default:
        // ended, interrupted, error
        line.until = line.released ? t : t + this.tailMs;
        line.endedAt = t;
    }
    this.evaluate();
  }

  /** The guard as last announced through `onChange` (it switches off on a timer once the last hold runs out). */
  get engaged(): boolean {
    return this.wasActive;
  }

  /** True while any line may be audible (computed now; `engaged` follows it on the next timer tick). */
  get active(): boolean {
    const t = this.now();
    for (const l of this.lines.values()) if (l.until > t) return true;
    return false;
  }

  /** Ids of the lines holding the guard now. */
  get holding(): string[] {
    const t = this.now();
    return [...this.lines].filter(([, l]) => l.until > t).map(([id]) => id);
  }

  /** Text of each line holding the guard now ('' when the notices carried none). */
  holdingText(): string[] {
    const t = this.now();
    return [...this.lines.values()].filter((l) => l.until > t).map((l) => l.text);
  }

  /** Text of lines that are audible, or ended less than `windowMs` ago (for late-echo matching). */
  recentText(windowMs = 4000): string[] {
    const t = this.now();
    return [...this.lines.values()].filter((l) => l.text && (l.until > t || (l.endedAt !== null && t - l.endedAt <= windowMs))).map((l) => l.text);
  }

  /** Stop guarding the current lines (barge-in). Later notices for them cannot re-arm the guard. */
  release(): string[] {
    const ids = this.holding;
    const t = this.now();
    for (const id of ids) {
      const l = this.lines.get(id)!;
      l.until = t;
      l.released = true;
      l.endedAt ??= t;
    }
    this.evaluate();
    return ids;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lines.clear();
  }

  private evaluate() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const t = this.now();
    // Forget lines that ended long ago.
    for (const [id, l] of this.lines) if (l.until <= t && l.endedAt !== null && t - l.endedAt > 60_000) this.lines.delete(id);
    const active = this.active;
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.o.onChange?.(active);
    }
    if (active) {
      const next = Math.min(...[...this.lines.values()].filter((l) => l.until > t).map((l) => l.until));
      this.timer = setTimeout(() => this.evaluate(), Math.max(1, next - t));
    }
  }
}

export interface PhoneMic {
  readonly state: PhoneMicState;
  readonly mode: PhoneMicMode;
  /** The TV is (or may be) audible right now. */
  readonly guarded: boolean;
  /** A recognizer exists and the page is a secure context. */
  readonly supported: boolean;
  /** Start listening (push-to-talk: on press). Returns false and emits `error` when the mic cannot start. */
  start(): boolean;
  /** Stop listening (push-to-talk: on release). The final result of the current utterance is still sent. */
  stop(): void;
  /** Stop listening and discard the utterance in progress. */
  abort(): void;
  /** Ask the TV to stop talking now (a stop button). */
  interrupt(reason?: string): void;
  on<E extends keyof PhoneMicEvents>(event: E, fn: PhoneMicEvents[E]): () => void;
  /** Stop, and detach from the client. */
  dispose(): void;
}

interface Utterance {
  id: string;
  startAt: number;
  lastChangeAt: number;
  text: string;
  /** Heard (at least in part) while the TV was audible. Sent only if it turned into a barge-in. */
  suspect: boolean;
  barged: boolean;
  partialSentAt: number;
  partialTimer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

const FATAL: Record<string, [PhoneMicErrorCode, string]> = {
  'not-allowed': ['permission-denied', 'Microphone permission was denied. Allow the microphone for this page in the browser settings, then try again.'],
  'service-not-allowed': ['permission-denied', 'Speech recognition is not allowed on this page or device.'],
  'audio-capture': ['no-microphone', 'No microphone is available.'],
  'language-not-supported': ['language', 'The recognizer does not support this language.'],
};

/**
 * Wrap Web Speech (or an injected recognizer) as the room's mic: interim results become throttled
 * `transcript.partial`s, finals become `transcript.final`s with `speech.start` and `speech.end` hops, continuous
 * mode restarts sessions the browser ends (iOS Safari ends them often), and the echo guard keeps the TV out.
 *
 * `speech.end` is the recognizer's `speechend` event when it fired for this utterance, else the last time the
 * interim text changed: the closest a browser recognizer gets to "the user stopped talking".
 */
export function createPhoneMic(opts: PhoneMicOptions): PhoneMic {
  const { client } = opts;
  const mode: PhoneMicMode = opts.mode ?? 'push-to-talk';
  const now = opts.now ?? localNow;
  const partialEveryMs = opts.partialEveryMs ?? 150;
  const guardOpts: EchoGuardOptions | null = opts.echoGuard === false ? null : opts.echoGuard === true || opts.echoGuard === undefined ? {} : opts.echoGuard;
  const bargeIn = guardOpts?.bargeIn ? { minWords: (typeof guardOpts.bargeIn === 'object' ? guardOpts.bargeIn.minWords : undefined) ?? 2 } : null;
  const factory = opts.recognizer ?? webSpeechRecognizer();
  const secure = opts.secureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext;

  const handlers = new Map<string, Set<(arg: never) => void>>();
  const emit = <E extends keyof PhoneMicEvents>(event: E, arg: Parameters<PhoneMicEvents[E]>[0]) => {
    for (const fn of [...(handlers.get(event) ?? [])]) {
      try {
        (fn as (a: typeof arg) => void)(arg);
      } catch (err) {
        globalThis.console?.error?.(`tv-voice-bridge: a phone mic "${event}" handler threw`, err);
      }
    }
  };

  let state: PhoneMicState = 'idle';
  const setState = (s: PhoneMicState) => {
    if (s === state) return;
    state = s;
    emit('state', s);
  };

  let rec: RecognizerLike | null = null;
  let session = 0;
  let sessionStartedAt = 0;
  let speechStartAt: number | null = null;
  let speechEndAt: number | null = null;
  let want = false; // the user wants the mic on
  let pausedByGuard = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDelay = opts.restartDelayMs ?? 250;
  const utterances = new Map<string, Utterance>();

  const guard = guardOpts
    ? new EchoGuard({
        tailMs: guardOpts.tailMs,
        maxHoldMs: guardOpts.maxHoldMs,
        now,
        onChange: (active) => {
          emit('guard', active);
          if (active)
            for (const u of utterances.values())
              if (!u.done && !u.barged) {
                u.suspect = true;
                clearPartial(u);
              }
          if (guardOpts.mode === 'pause' && mode === 'continuous') {
            if (active && rec) {
              pausedByGuard = true;
              endSession(true);
            } else if (!active && pausedByGuard) {
              pausedByGuard = false;
              if (want) open();
            }
          }
          refreshState();
        },
      })
    : null;
  const offSpeech = guard ? client.onSpeech((n) => guard.notice(n)) : () => undefined;

  const refreshState = () => {
    if (state === 'error' || state === 'idle' || state === 'starting') return;
    setState(guard?.engaged ? 'guarded' : 'listening');
  };

  const fail = (code: PhoneMicErrorCode, message: string, fatal: boolean) => {
    const err = new PhoneMicError(code, message, fatal);
    if (fatal) {
      want = false;
      clearRestart();
      endSession(true);
      setState('error');
    }
    emit('error', err);
    return err;
  };

  const clearRestart = () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  };

  const clearPartial = (u: Utterance) => {
    if (u.partialTimer) clearTimeout(u.partialTimer);
    u.partialTimer = null;
  };

  const sendPartial = (u: Utterance) => {
    clearPartial(u);
    if (u.done || (u.suspect && !u.barged)) return;
    u.partialSentAt = now();
    client.sendPartial(u.text, u.id);
    emit('partial', { utteranceId: u.id, text: u.text });
  };

  /** While the TV is talking: is this the user talking over it? */
  const tryBargeIn = (u: Utterance): boolean => {
    if (!bargeIn || !guard) return false;
    if (words(u.text).length < bargeIn.minWords) return false;
    // Without the TV's words there is no telling the user from the TV, so no automatic barge-in.
    const holding = guard.holdingText();
    if (!holding.length || holding.some((s) => !s)) return false;
    if (guard.recentText().some((s) => echoOverlap(u.text, s) >= 0.5)) return false;
    const ids = guard.release();
    for (const id of ids.length ? ids : [undefined]) client.stopSay({ id, reason: 'barge-in' });
    emit('bargeIn', { text: u.text, ids });
    return true;
  };

  const onResult = (ev: RecognitionEventLike, mySession: number) => {
    if (mySession !== session) return;
    const t = now();
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const result = ev.results[i];
      if (!result) continue;
      const text = (result[0]?.transcript ?? '').trim();
      const key = `${mySession}:${i}`;
      let u = utterances.get(key);
      if (!u) {
        const startAt = speechStartAt !== null && speechStartAt <= t ? speechStartAt : t;
        u = { id: newId('utt'), startAt, lastChangeAt: t, text: '', suspect: false, barged: false, partialSentAt: -Infinity, partialTimer: null, done: false };
        speechStartAt = null;
        speechEndAt = null;
        utterances.set(key, u);
      }
      if (u.done) continue;
      if (text !== u.text) {
        u.text = text;
        u.lastChangeAt = t;
      }
      if (guard?.active && !u.barged) {
        u.suspect = true;
        if (tryBargeIn(u)) u.barged = true;
      }
      const blocked = u.suspect && !u.barged;
      if (!result.isFinal) {
        if (blocked || !text) {
          clearPartial(u);
          continue;
        }
        const wait = u.partialSentAt + partialEveryMs - t;
        if (wait <= 0) sendPartial(u);
        else if (!u.partialTimer) {
          const target = u;
          u.partialTimer = setTimeout(() => sendPartial(target), wait);
        }
        continue;
      }
      u.done = true;
      clearPartial(u);
      utterances.delete(key);
      if (!text) continue;
      if (blocked) {
        emit('dropped', { text, reason: 'echo' });
        continue;
      }
      if (guard && guardOpts?.matchText !== false && guard.recentText().some((s) => isEcho(text, s))) {
        emit('dropped', { text, reason: 'echo-text' });
        continue;
      }
      const end = Math.min(t, speechEndAt !== null && speechEndAt >= u.startAt ? speechEndAt : u.lastChangeAt);
      const final: PhoneMicFinal = { utteranceId: u.id, text, speechStartAt: Math.min(u.startAt, end), speechEndAt: end };
      speechEndAt = null;
      if (client.sendFinal(text, { utteranceId: final.utteranceId, speechStartAt: final.speechStartAt, speechEndAt: final.speechEndAt }) === null) {
        emit('dropped', { text, reason: 'not-connected' });
        continue;
      }
      emit('final', final);
    }
  };

  /** End the recognizer session. `discard` aborts it (no final); otherwise it stops and the final arrives. */
  function endSession(discard: boolean) {
    const r = rec;
    if (!r) return;
    if (discard) {
      rec = null;
      session++;
      for (const u of utterances.values()) clearPartial(u);
      utterances.clear();
      detach(r);
      try {
        r.abort();
      } catch {
        // already gone
      }
    } else {
      try {
        r.stop();
      } catch {
        endSession(true);
      }
    }
  }

  function detach(r: RecognizerLike) {
    r.onstart = null;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    r.onspeechstart = null;
    r.onspeechend = null;
  }

  function open() {
    clearRestart();
    if (!factory) return;
    let r: RecognizerLike;
    try {
      r = factory();
      r.continuous = mode === 'continuous';
      r.interimResults = true;
      if (opts.lang) r.lang = opts.lang;
    } catch (err) {
      fail('no-support', `Speech recognition could not start: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }
    const mine = ++session;
    rec = r;
    speechStartAt = null;
    speechEndAt = null;
    r.onstart = () => {
      if (mine !== session) return;
      sessionStartedAt = now();
      setState(guard?.engaged ? 'guarded' : 'listening');
    };
    r.onspeechstart = () => {
      if (mine === session) speechStartAt = now();
    };
    r.onspeechend = () => {
      if (mine === session) speechEndAt = now();
    };
    r.onresult = (ev) => onResult(ev, mine);
    r.onerror = (ev) => {
      if (mine !== session) return;
      const fatal = FATAL[ev.error];
      if (fatal) return void fail(fatal[0], fatal[1], true);
      if (ev.error === 'aborted') return;
      if (ev.error === 'no-speech') return void fail('no-speech', 'No speech was heard.', false);
      if (ev.error === 'network') return void fail('network', 'The recognizer could not reach its speech service.', false);
      fail('recognizer', `Speech recognition failed: ${ev.error}${ev.message ? ` (${ev.message})` : ''}`, false);
    };
    r.onend = () => {
      if (mine !== session) return;
      rec = null;
      session++;
      for (const u of utterances.values()) clearPartial(u);
      utterances.clear();
      if (state === 'error') return;
      if (want && mode === 'continuous' && !pausedByGuard) {
        // Browsers end sessions on their own (silence, time limits, iOS Safari after each phrase): start again.
        const lived = now() - sessionStartedAt;
        restartDelay = lived < 1000 ? Math.min(5000, restartDelay * 2) : (opts.restartDelayMs ?? 250);
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (want && !rec) open();
        }, restartDelay);
        return;
      }
      if (!pausedByGuard) {
        want = false;
        setState('idle');
      }
    };
    setState('starting');
    try {
      r.start();
    } catch (err) {
      rec = null;
      fail('recognizer', `Speech recognition could not start: ${err instanceof Error ? err.message : String(err)}`, mode !== 'continuous');
    }
  }

  const mic: PhoneMic = {
    get state() {
      return state;
    },
    mode,
    get guarded() {
      return guard?.engaged ?? false;
    },
    get supported() {
      return !!factory && secure !== false;
    },
    start() {
      if (!factory) {
        fail('no-support', 'This browser has no speech recognition. Use Chrome or Safari, or type instead.', true);
        return false;
      }
      if (secure === false) {
        fail('insecure-context', 'Speech recognition needs a secure page: open it over https (or on localhost).', true);
        return false;
      }
      if (rec) return true;
      // Pressing to talk while the TV speaks is a deliberate barge-in.
      if (guard?.active && bargeIn && mode === 'push-to-talk') {
        const ids = guard.release();
        for (const id of ids.length ? ids : [undefined]) client.stopSay({ id, reason: 'barge-in' });
        emit('bargeIn', { text: '', ids });
      }
      want = true;
      restartDelay = opts.restartDelayMs ?? 250;
      if (state === 'error') state = 'idle';
      if (guardOpts?.mode === 'pause' && mode === 'continuous' && guard?.active) {
        pausedByGuard = true;
        setState('guarded');
        return true;
      }
      open();
      return (state as PhoneMicState) !== 'error';
    },
    stop() {
      want = false;
      pausedByGuard = false;
      clearRestart();
      if (rec) endSession(false);
      else setState('idle');
    },
    abort() {
      want = false;
      pausedByGuard = false;
      clearRestart();
      endSession(true);
      setState('idle');
    },
    interrupt(reason = 'user') {
      const ids = guard?.release() ?? [];
      for (const id of ids.length ? ids : [undefined]) client.stopSay({ id, reason });
    },
    on(event, fn) {
      const set = handlers.get(event) ?? new Set();
      set.add(fn as (arg: never) => void);
      handlers.set(event, set);
      return () => set.delete(fn as (arg: never) => void);
    },
    dispose() {
      mic.abort();
      offSpeech();
      guard?.dispose();
      handlers.clear();
    },
  };
  return mic;
}

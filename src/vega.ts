/**
 * `./vega`: the TV speaks back on Vega OS. A `SayPlayer` for `useVoiceBridge` (or any screen) built on Vega's
 * W3C media player (`@amazon-devices/react-native-w3cmedia`, an optional peer dependency).
 *
 * What Vega's player accepts, measured on the Vega Virtual Device (SDK 0.24):
 *   - an https URL with a publicly trusted certificate, in URL mode;
 *   - plain http only through Media Source Extensions, and only as **fragmented MP4 with AAC**. The demuxer
 *     never starts on raw MP3 (`isTypeSupported('audio/mpeg')` says yes, playback ends in MediaError 3), so an
 *     http MP3 is refused up front with a message instead.
 * So a hub on a laptop or the LAN can serve its own text-to-speech clips with no certificate or cloud storage:
 * encode them as fragmented MP4/AAC (see examples/vega-voice-loop/tts.mjs).
 */
import { AudioPlayer, MediaSource } from '@amazon-devices/react-native-w3cmedia';
import type { SayControls, SayLine, SayPlayer } from './react.js';

export interface VegaSayPlayerOptions {
  /** Resolves a hub-relative `audioUrl` (`/tts/a1.m4a`), e.g. `http://127.0.0.1:8790`. */
  baseUrl?: string;
  /** How long to wait for the demuxer to take the stream before ending it. Default 3000 ms. */
  eosWaitMs?: number;
  /** Default: the global fetch. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface VegaSayPlayer extends SayPlayer {
  /** Create and initialize the media player now, so the first line is not delayed by it. */
  warm(): Promise<void>;
  /** Release the media player. */
  dispose(): Promise<void>;
}

type Player = InstanceType<typeof AudioPlayer>;

const MP4_TYPES = ['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'];
const isMp4 = (url: string, contentType: string | null) => /\.(m4a|mp4|m4s)(\?|#|$)/i.test(url) || /\b(audio|video)\/mp4\b/i.test(contentType ?? '');

export const RAW_HTTP_AUDIO =
  'Vega plays http audio only as fragmented MP4/AAC through MSE (raw MP3 never starts): serve .m4a, or an https URL';

function resolve(audioUrl: string, baseUrl: string | undefined): string | null {
  if (/^https?:\/\//i.test(audioUrl)) return audioUrl;
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/${audioUrl.replace(/^\/+/, '')}`;
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function createVegaSayPlayer(opts: VegaSayPlayerOptions = {}): VegaSayPlayer {
  const eosWaitMs = opts.eosWaitMs ?? 3000;
  const get = opts.fetch ?? ((url: string) => fetch(url));
  let ready: Promise<Player | null> | null = null;
  let current: SayControls | null = null; // the line the player's events belong to

  const player = () =>
    (ready ??= (async () => {
      try {
        const p = new AudioPlayer();
        await p.initialize();
        p.addEventListener('playing', () => current?.playing());
        p.addEventListener('ended', () => {
          const c = current;
          current = null;
          c?.ended();
        });
        p.addEventListener('error', () => {
          const c = current;
          current = null;
          const e = p.error;
          c?.error(e ? `MediaError ${e.code ?? '?'} ${e.message ?? ''}`.trim() : 'media error');
        });
        return p;
      } catch {
        return null;
      }
    })());

  // Feed one fragmented MP4 clip through MSE. Ending the stream before the demuxer has the stream fails
  // (DEMUXER_INVALID_STATE), and a short clip may not start until the stream is ended, so: append, play,
  // wait for the first sign the demuxer has it (metadata, canplay or playing), then end the stream.
  async function viaMse(p: Player, bytes: ArrayBuffer) {
    const type = MP4_TYPES.find((t) => MediaSource.isTypeSupported(t, true));
    if (!type) throw new Error('MSE: no supported MP4/AAC type');
    const ms = new MediaSource();
    const opened = new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve()));
    p.srcObject = ms;
    await within(opened, 4000, 'sourceopen');
    const sb = ms.addSourceBuffer(type);
    await within(
      new Promise<void>((resolve, reject) => {
        sb.addEventListener('updateend', () => resolve());
        sb.addEventListener('error', () => reject(new Error('SourceBuffer error')));
        sb.appendBuffer(bytes);
      }),
      6000,
      'appendBuffer',
    );
    let took!: () => void;
    const sign = new Promise<void>((resolve) => (took = resolve));
    const signs = ['loadedmetadata', 'canplay', 'playing'];
    const onSign = () => took();
    for (const s of signs) p.addEventListener(s, onSign);
    await p.play();
    await Promise.race([sign, new Promise((r) => setTimeout(r, eosWaitMs))]);
    for (const s of signs) p.removeEventListener(s, onSign);
    ms.endOfStream();
  }

  const play = ((line: SayLine, ctl: SayControls) => {
    let stopped = false;
    let held: Player | null = null;
    void (async () => {
      const url = line.audioUrl ? resolve(line.audioUrl, opts.baseUrl) : null;
      if (!url) return ctl.error(line.audioUrl ? `relative audioUrl ${line.audioUrl} needs baseUrl` : 'no audioUrl');
      const p = await player();
      if (stopped) return;
      if (!p) return ctl.error('the Vega media player is unavailable');
      held = p;
      current = ctl;
      if (/^https:/i.test(url)) {
        p.src = url;
        await p.play();
        return;
      }
      const res = await get(url);
      if (stopped) return;
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      if (!isMp4(url, res.headers.get('content-type'))) throw new Error(RAW_HTTP_AUDIO);
      await viaMse(p, await res.arrayBuffer());
    })().catch((err: unknown) => {
      if (stopped) return;
      if (current === ctl) current = null;
      ctl.error(err instanceof Error ? err.message : String(err));
    });
    return () => {
      stopped = true;
      if (current === ctl) current = null;
      try {
        held?.pause();
      } catch {
        // the player may be between sources
      }
    };
  }) as VegaSayPlayer;

  play.warm = async () => void (await player());
  play.dispose = async () => {
    const p = await (ready ?? Promise.resolve(null));
    ready = null;
    current = null;
    await p?.deinitialize().catch(() => {});
  };
  return play;
}

// A scriptable stand-in for @amazon-devices/react-native-w3cmedia: records what `./vega` does and fires media
// events the way the Vega player was seen to (canplay -> playing after play(), ended later).
type Fn = () => void;
class Events {
  private fns = new Map<string, Set<Fn>>();
  addEventListener(t: string, fn: Fn) {
    if (!this.fns.has(t)) this.fns.set(t, new Set());
    this.fns.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: Fn) {
    this.fns.get(t)?.delete(fn);
  }
  fire(t: string) {
    for (const fn of [...(this.fns.get(t) ?? [])]) fn();
  }
}

export const media = {
  log: [] as string[],
  players: [] as AudioPlayer[],
  supported: new Set(['audio/mp4; codecs="mp4a.40.2"', 'audio/mp4', 'audio/mpeg']),
  /** What play() leads to: the events, in order, each after a tick. */
  script: ['canplay', 'playing', 'ended'] as string[],
  /** Called whenever a player's srcObject is set (a test can stop a line right there). */
  onSrcObject: null as ((v: unknown) => void) | null,
  /** The next this many initialize() calls fail. */
  failInit: 0,
  reset() {
    this.log = [];
    this.players = [];
    this.script = ['canplay', 'playing', 'ended'];
    this.onSrcObject = null;
    this.failInit = 0;
  },
};

const tick = () => new Promise((r) => setTimeout(r, 5));

export class SourceBuffer extends Events {
  appendBuffer(data: ArrayBuffer) {
    media.log.push(`append ${data.byteLength}`);
    void tick().then(() => this.fire('updateend'));
  }
}

export class MediaSource extends Events {
  static isTypeSupported(type: string) {
    return media.supported.has(type);
  }
  addSourceBuffer(type: string) {
    media.log.push(`addSourceBuffer ${type}`);
    return new SourceBuffer();
  }
  endOfStream() {
    media.log.push('endOfStream');
  }
}

export class AudioPlayer extends Events {
  private url = '';
  error: { code?: number; message?: string } | null = null;
  private obj: unknown = null;
  constructor() {
    super();
    media.players.push(this);
  }
  // As on a Vega device: setting src replaces an attached stream, and setting srcObject to null throws.
  get src() {
    return this.url;
  }
  set src(v: string) {
    this.url = v;
    this.obj = null;
  }
  get srcObject() {
    return this.obj;
  }
  set srcObject(v: unknown) {
    if (v == null) throw new TypeError("Cannot read property 'setMediaEventRouter' of null");
    this.obj = v;
    media.onSrcObject?.(v);
    if (v instanceof MediaSource) void tick().then(() => v.fire('sourceopen'));
  }
  async initialize() {
    media.log.push('initialize');
    if (media.failInit > 0) {
      media.failInit--;
      throw new Error('initialize failed');
    }
  }
  async deinitialize() {
    media.log.push('deinitialize');
  }
  async play() {
    media.log.push(this.obj ? 'play mse' : this.url ? `play ${this.url}` : 'play (no source)');
    void (async () => {
      for (const e of media.script) {
        await tick();
        media.log.push(`event ${e}`);
        this.fire(e);
      }
    })();
  }
  pause() {
    media.log.push('pause');
  }
}

// The slice of @amazon-devices/react-native-w3cmedia that `./vega` uses, so this package type-checks without
// installing it. A Vega app's own copy of the package takes over in its build.
declare module '@amazon-devices/react-native-w3cmedia' {
  type Listener = () => void;
  export class AudioPlayer {
    src: string;
    srcObject: unknown;
    readonly error: { code?: number; message?: string } | null;
    initialize(): Promise<void>;
    deinitialize(): Promise<void>;
    play(): Promise<void>;
    pause(): void;
    addEventListener(type: string, fn: Listener): void;
    removeEventListener(type: string, fn: Listener): void;
  }
  export class SourceBuffer {
    appendBuffer(data: ArrayBuffer): void;
    addEventListener(type: string, fn: Listener): void;
  }
  export class MediaSource {
    static isTypeSupported(type: string, audioOnly?: boolean): boolean;
    addEventListener(type: string, fn: Listener): void;
    addSourceBuffer(type: string): SourceBuffer;
    endOfStream(): void;
  }
}

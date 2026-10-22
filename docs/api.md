# API

Each entry point in detail. The README has the short version; the wire protocol is [PROTOCOL.md](../PROTOCOL.md).

## Vega notes

Verified on the Vega Virtual Device, SDK 0.24. The full list of quirks is [vega-notes.md](vega-notes.md).

- **WebSocket and the VVD.** React Native's global `WebSocket` works. On the VVD, reach a hub on your machine with a **reverse port forward**, `vega device start-port-forwarding -d VirtualDevice --port 8790 --forward false`, and connect to `ws://127.0.0.1:8790/ws`. The emulator's NAT alias `10.0.2.2` dropped WebSocket frames larger than about 1.4 KB in our tests. On a stick, the same reverse forward works over Wi-Fi, or use the dev machine's LAN address.
- **Built-in client defences.** The client reassembles messages that arrive split across events, and its heartbeat drops a link that goes silent even when `onclose` never fires.
- **Audio: https in URL mode, or fragmented MP4/AAC over plain http.** The W3C media player (`@amazon-devices/react-native-w3cmedia`) plays an `https://` URL only with a publicly trusted certificate (a local CA is refused). Over `http://` it plays only through Media Source Extensions, and only fragmented MP4 with AAC: raw MP3 through MSE never starts. `./vega` handles both; see [below](#the-tv-speaks-back-on-vega-vega).
- **Metro, only when bundling from source.** The package source uses TS-ESM imports (`./protocol.js`), so map them to `.ts` in a custom `resolveRequest`. A custom resolver replaces Vega's own, so also re-apply the `react-native` → `@amazon-devices/react-native-kepler` mapping; without it the bundle ships core React Native and the app aborts at launch. See [`examples/minimal-vega/metro.config.js`](../examples/minimal-vega/metro.config.js).
- **React Native 0.72 Vega apps (Metro before 0.82).** The subpaths (`vega-voice-bridge/react`, `/vega`, `/qr`) resolve through the package's `exports`, which Metro reads by default only from 0.82 (React Native 0.83 for Vega). On the 0.72 line, turn it on in `metro.config.js`: `mergeConfig(getDefaultConfig(__dirname), { resolver: { unstable_enablePackageExports: true } })`. That switch applies to every package the app bundles, so rebuild and launch once after setting it. This repo's Vega example and its CI typecheck use React Native 0.83; the 0.72 setting is not tested here.
- **`performance.timeOrigin`.** It may be missing on some runtimes. The client falls back on its own; polyfill it as `Date.now() - performance.now()` if your code stamps `receivedAt` itself.

## The React hook (`./react`)

`useVoiceBridge()` wraps the client for a React or React Native TV. It runs on React Native for Vega and react-native-web, and `<PairingQr>` draws the QR code with plain `View`s.

```tsx
const tv = useVoiceBridge({
  url: 'ws://192.168.1.20:8790/ws',
  player: (line, ctl) => {                          // play line.audioUrl, or a local TTS of line.text
    const stop = myPlayer.play(line, { onStart: ctl.playing, onEnd: ctl.ended, onError: ctl.error });
    return stop;                                    // called when a high-priority line or a barge-in interrupts
  },
  onIntent: (m) => applyToMyState(m.payload),        // the ack is sent after the frame that shows it
});
```

- **What it returns:**
  - `status`: `connecting`, `waiting-for-phone`, `paired`, `reconnecting` or `closed`;
  - `code`, `joinUrl`, `peers` and `mics`;
  - the live `partial`, and the latest `final` and `intent`;
  - `saying`, the line being said and its state;
  - `say(text)`, `stopSay()`, `sendApp()` and `ack()`, plus `client` for anything else.
- **Acks follow the paint.** The hook acks each intent in a task queued from the next animation frame after React commits it. So the `screen.render` hop is a moment when the viewer could see the result. Pass `autoAck: false` to ack yourself.
- **Say lines play one at a time** through your `player`. Lines come from the hub, or from the TV's own `say(text)`. `high` priority interrupts the current line, and so does a phone's barge-in (`interruptible`, default true). Every state is reported on `screen.say.status`, with the line's text, which is what keeps the phone's echo guard in step. With no player, lines are captions only and are reported as `no-audio`.
- **Callbacks and the player are read from the latest render,** so inline functions are fine. The connection is rebuilt only when `url`, `code`, `name`, `clientId`, `resumeToken`, `sayTopic` or `enabled` change. Unmounting closes it.
- **`<PairingQr value size? ecc? quietZone? dark? light? testID? />`** draws one `View` per horizontal run of dark modules over a light square. The square includes the 4-module quiet zone and uses whole-number cells. Its default `testID` is `pairing-qr`.
- **Where it has run.** The Vega voice-loop example runs on the hook on the VVD ([measurement.md](measurement.md)). Spee, which uses `BridgeClient` and `PairingQr` from version 0.3.5, ran on a Fire TV Stick on 2026-10-20; that run was not measured. The tests use react-test-renderer and React 18 with a host-component mock of `react-native`.

## The TV speaks back on Vega (`./vega`)

`createVegaSayPlayer()` is a `SayPlayer` for `useVoiceBridge` built on Vega's W3C media player:

- **https** (publicly trusted) plays in URL mode.
- **Plain http** plays through Media Source Extensions, as **fragmented MP4 with AAC**. That is what lets a hub on a laptop or the LAN speak its own text-to-speech with no certificate or cloud storage. A raw MP3 over http is refused with a message rather than the player's opaque `MediaError 3`: Vega's MSE demuxer never starts on raw MP3, though `isTypeSupported('audio/mpeg')` says yes.
- The player plays first and ends the stream only once the demuxer has it (`loadedmetadata`, `canplay` or `playing`). Ending it earlier fails, and a short clip may not start until the stream is ended.
- Each line reports `loading`, `playing` (when sound starts), then `ended`, `interrupted` or `error` on `screen.say.status`, so the hub can time it and the phone's echo guard knows when the TV is audible.
- Encode clips with ffmpeg: `-c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof -f mp4`. [`examples/vega-voice-loop/tts.mjs`](../examples/vega-voice-loop/tts.mjs) does it from macOS `say`, Linux `espeak`, Amazon Polly or any command (`TTS_CMD`).

[`examples/vega-voice-loop`](../examples/vega-voice-loop) is the whole loop as a Vega app: the pairing QR, the phone's words as they arrive, the answer, the answer said out loud, and the hub's measurements of each loop, shown on the TV. The screenshot at the top of the README is that app.

## Hub (Node)

```ts
import http from 'node:http';
import { BridgeHub } from 'vega-voice-bridge/hub';   // needs `ws`

const server = http.createServer(app);
const hub = new BridgeHub({
  server,                                   // or [httpServer, httpsServer]: one hub, several listeners
  joinUrl: (code) => `https://${lanIp}:8443/p/${code}`,
  onFinal: async (room, msg) => {
    const reply = await respond(msg.text);                     // rules, an LLM, an MCP tool: your call
    hub.say(room, { id: nextId(), text: reply, audioUrl: await tts(reply), priority: 'high' });
    return { name: 'reply', ok: true, payload: { text: msg.text, reply } };   // fanned out as an `intent`
  },
  onApp: (room, msg) => null,               // taps, nav, playback status; return an intent to answer a tracked one
});
```

The hub is defensive by construction. No frame, upgrade request or app callback can throw out of it. Every field of every message is validated, and anything bad gets a typed error instead of a crash. A handler that throws gives the room `handler-failed` with the generic message "handler failed"; the exception text goes to the hub's log.

The CLI is the same hub with a phone page. In a clone of this repo, run `npm run hub -- --port 8790` (add `--echo` to answer each final with "You said: …"). In an app that installed the package, run `npx --no-install vega-voice-bridge-hub --port 8790`. The command is this package's bin, and `--no-install` stops npx from downloading some other npm package that happens to have that name. Either way, it prints the WebSocket URL and the join URL built from this machine's LAN address. [docs/deploy.md](deploy.md) has the rest: every hub option and limit, containers, reverse proxies and tunnels (`--trust-proxy` and `X-Forwarded-For`), the Origin check, serving the phone page from your own server, and what `hub.stats` and the log report.

## Phone (`./phone`)

The phone is a web page; nothing is installed on it. [`examples/minimal-phone/phone.html`](../examples/minimal-phone/phone.html) is a complete one, with hold-to-talk, hands-free, a stop button, typed input, a code entry when opened without a code, and an explanation when voice cannot work on that page.

```ts
import { latency } from 'vega-voice-bridge';
import { connectPhone, createPhoneMic, voiceSupport } from 'vega-voice-bridge/phone';

const voice = voiceSupport();                       // { ok, reason?, message, fixes[] }: show it when !voice.ok
const phone = connectPhone();                       // hub URL and code from this page's address (/p/K7QF)
phone.on('ack', (a) => show(latency(a.hops).span('speech.end', 'screen.render')));   // ms, across three devices
phone.on('repair', () => askToScanAgain());         // the TV's room is gone for good

const mic = createPhoneMic({ client: phone, mode: 'push-to-talk', echoGuard: { bargeIn: true } });
button.onpointerdown = () => mic.start();
button.onpointerup = () => mic.stop();              // the final result still arrives
mic.on('error', (e) => show(e.message));            // e.code: no-support, insecure-context, permission-denied, ...
```

- **Recognizer.** It uses Web Speech (`SpeechRecognition`, or Safari's `webkitSpeechRecognition`). Pass `recognizer` to use something else with the same shape, as the tests do.
- **Transcripts.** Interim results become `transcript.partial`s, at most one per `partialEveryMs` (150 ms) and always ending on the latest text. Finals become `transcript.final`s with `speech.start` and `speech.end` hops. `speech.end` is the recognizer's `speechend` event when it fired for this utterance; otherwise it is the last time the interim text changed. That is the closest a browser recognizer gets to "the user stopped talking".
- **Modes.** `push-to-talk` is `start()` on press and `stop()` on release. `continuous` listens until `stop()`, and restarts each session the browser ends; iOS Safari ends them often. The restart delay backs off while sessions keep ending quickly.
- **Errors.** Each error has a code and a plain message. `no-support`, `insecure-context` (speech recognition needs https or `localhost`), `permission-denied` and `no-microphone` are fatal. `no-speech` and `network` are not. Typed input over plain http still works.
- **`voiceSupport()`** answers before the user presses anything: whether this page can listen, and if not, why (`insecure-context`, `no-support`) and what to do, with the page's own address filled in. Browsers with no recognizer are told which one to use.
- **Without `./phone`,** drive `BridgeClient` yourself: `new BridgeClient({ url, role: 'mic', code })`, `sendPartial(text, id)` while speaking, and `sendFinal(text, { speechEndAt: localNow(), utteranceId: id })` at the end.

## Pairing QR (`./qr`)

The pairing screen shows the join URL as a QR code. `./qr` encodes it with no dependencies, so a TV app does not need a native QR module or an SVG renderer.

```ts
import { qrMatrix, qrRuns, qrSvg, qrSvgPath } from 'vega-voice-bridge/qr';

const m = qrMatrix(joinUrl);                  // { size, version, ecc: 'M', mask, modules: boolean[][] }, no quiet zone
const d = qrSvgPath(m, { cell: 8, margin: 4 });   // one SVG path, dark modules merged into horizontal runs
const svg = qrSvg(m);                         // a whole <svg> document with a 4-module quiet zone
const runs = qrRuns(m);                       // [{x, y, w}], for any other renderer (PairingQr uses these)
```

- **What it encodes:** byte mode (UTF-8; `eci: true` adds an ECI 26 header), error correction `L`, `M` (default), `Q` or `H`, and versions 1 to 40. It picks the smallest version that fits, and the mask with the lowest penalty under the four rules of ISO/IEC 18004. It was written from the standard.
- **How it is tested:** `test/qr.test.ts` rasterizes symbols and reads them back with an independent decoder (a devDependency). Every version at every level is filled to its last byte and decoded, except version 23 at level L. There the decoder's own alignment table differs from the spec's, so that pair is checked structurally instead. The test also covers each mask, UTF-8 with and without ECI, and each copy of the format and version information on its own.

## Protocol

[PROTOCOL.md](../PROTOCOL.md) is the spec, with portable wire vectors in [`test/vectors/wire.json`](../test/vectors/wire.json) and a black-box suite any hub can run (`TVB_HUB_URL=ws://host:port/ws npm run conformance`). It covers framing, every message with field limits, who may send what, routing, pairing and room lifetime, identity, liveness, errors, hub-clock hops, `screen.say`, the echo guard relays, backpressure, and the versioning rules. Version `1` has three revisions, which interoperate both ways. In short:

| `type` | Direction | Notes |
|---|---|---|
| `hello` / `welcome` / `peers` | client ↔ hub | A mic sends a live `code`; a screen may send one to resume its room |
| `transcript.partial` / `transcript.final` | mic → hub → **screens** (+ `onFinal`) | Live caption, then the final text |
| `intent` | hub → **room** | What your app or agent understood |
| `ack` | screen → hub → **mics** | Sent after the frame that shows the intent |
| `app` | any → hub | Side channel. `screen.say` (hub → screens) and `screen.say.status` (screen → hub) ride on it |
| `app` `screen.speech` | hub → **mics** | What the TV is saying, for the echo guard. Never carries the audio URL |
| `app` `screen.say.stop` | mic → hub → **screens** | Stop talking (barge-in, or a stop button) |
| `ping` / `pong` | client ↔ hub | Clock sync and liveness |
| `error` | hub → client | `unknown-code`, `bad-message`, `version`, `handler-failed`, `rate-limited`, `id-in-use`, `full`, `not-allowed` |

## Packaging

`exports` point at `dist/`. A `source` condition points at `src/`, so a monorepo or a git submodule can consume the TypeScript directly (`tsx -C source`, Vite `resolve.conditions`, TypeScript `customConditions`). Releases: [docs/releasing.md](releasing.md).

Requires Node 20 or later (developed on Node 24).

```bash
npm install              # dev dependencies only; also builds dist/ (prepare)
npm run typecheck        # tsc --noEmit over src/ and test/
npm test                 # vitest, no build needed (tests import src/)
npm run example          # the whole loop in one process, with the hop timeline
npm run hub -- --echo    # a standalone hub (the vega-voice-bridge-hub bin)
npm run build            # cleans, then tsc -> dist/ (ESM + .d.ts + source maps)
npm pack --dry-run       # dist/, src/, the phone page, README.md, PROTOCOL.md, CHANGELOG.md, LICENSE (no tests)
```

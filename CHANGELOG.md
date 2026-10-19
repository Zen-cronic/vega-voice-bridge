# Changelog

## Unreleased (0.3.0)

The wire protocol is still **v1**. Everything below is additive.

### Added
- **`./qr`:** a dependency-free QR Code encoder written from ISO/IEC 18004, for the pairing screen. Byte mode (UTF-8, optional ECI 26), error correction L/M/Q/H (default M), versions 1 to 40, and automatic mask selection with the four penalty rules. `qrMatrix(text, {ecc})` returns `{size, version, ecc, mask, modules}`. `qrRuns()` merges each row's dark modules into runs, `qrSvgPath()` draws them as one SVG path, and `qrSvg()` returns a whole document with a quiet zone. `test/qr.test.ts` decodes every symbol with an independent decoder: all 40 versions at all four levels filled to the last byte (one pair, version 23 at level L, is checked structurally because the decoder's own table differs from the spec there), each mask, UTF-8, and each copy of the format and version information on its own.
- **`./react`:** React bindings for the TV, with no native dependencies (React Native for Vega, react-native-web). `react` and `react-native` are optional peer dependencies, imported only by this subpath.
  - `useVoiceBridge(options)` connects a screen and returns `status` (`connecting`, `waiting-for-phone`, `paired`, `reconnecting`, `closed`), `code`, `joinUrl`, `peers`, `mics`, the live `partial`, the latest `final` and `intent`, and what is being said (`saying`). It acks each intent after the frame that shows it, so the `screen.render` hop is when the viewer could see it. Say lines (from the hub, or the TV's own `say(text)`) play one at a time through your `player`, `high` priority interrupts, and every state is reported on `screen.say.status`. Callbacks and the player are read from the latest render, and unmounting closes the connection.
  - `<PairingQr value size? />` draws a QR code from `View`s, one per horizontal run of dark modules, with a quiet zone, whole-number cells and a `testID`.
  - `test/react.test.ts` runs the hook against a real in-process hub and checks that PairingQr's views reproduce (and decode back to) the encoded matrix.
- `localNow()`: local epoch milliseconds from the monotonic clock, the time base of `speechEndAt` and `receivedAt`.
- **`./phone`:** the voice half, for a phone browser page.
  - `connectPhone()` joins as the room's mic, taking the hub URL and the code from the page's address unless given. `codeFromPath('/p/k7qf')` gives `K7QF`.
  - `createPhoneMic({client, mode, lang, recognizer})` wraps Web Speech (`SpeechRecognition` or `webkitSpeechRecognition`; injectable). Interim results become throttled `transcript.partial`s. Finals become `transcript.final`s with `speech.start` and `speech.end` hops. Continuous mode restarts sessions the browser ends (iOS Safari ends them often), and push-to-talk is `start()` / `stop()`. Errors are typed: `no-support`, `insecure-context` (not https), `permission-denied`, `no-microphone`, `network`, `no-speech`.
  - **The echo guard**, on by default. While the TV is saying something (from `queued` until `ended`, `interrupted` or `error`, plus a 700 ms tail), what the mic hears is dropped, or the recognizer is paused (`mode: 'pause'`). A final that repeats the TV's last words just after a line is dropped too. With `bargeIn: true`, a user who talks over the TV stops it, and what they said is kept. `interrupt()` is a stop button.
- **Protocol v1 revision 3** (additive; see [PROTOCOL.md](PROTOCOL.md#101-the-echo-guard-screenspeech-and-screensaystop-revision-3)):
  - the hub tells the room's mics what the TV is saying on the new `app` topic `screen.speech`: `queued` on `hub.say()`, then each playback report a screen sends. The notices never carry the audio URL. `speechNotices: false` turns them off;
  - a mic's `screen.say.stop` is relayed to the room's screens, and `hub.stopSay(room)` sends one from the app;
  - `screen.say.status` payloads may carry `text`, and finals may lead with a `speech.start` hop.
- Client: `onSpeech()` and `stopSay()` for mics, `onSayStop()` for screens, and `sendFinal({speechStartAt})`. The React hook honours `screen.say.stop` (`interruptible`, default true) and reports each line's `text`.
- Examples: the phone page uses `./phone` (hold to talk, hands-free, a stop button, barge-in on). The web TV honours `screen.say.stop` and reports every line it drops as `interrupted`.

- **`npm run example`:** the whole loop in one process (`examples/loop/loop.mjs`). A hub, a TV and a phone with a scripted recognizer run three utterances. It prints each hop leg, `speech.end -> screen.render` and `say -> playing`, measured in-process, and it shows the echo guard dropping the TV's replies that the phone hears.
- **`tv-voice-bridge-hub` (bin):** starts a hub and prints the WebSocket and join URLs. Flags: `--port` (default 8790), `--host`, `--path`, `--public-url` or `--join-url '<...{code}...>'`, `--echo`, `--trust-proxy`, `--quiet`. It serves `GET /healthz`. `npm run hub` runs it from this repo.
- A minimal `Dockerfile` for the hub, and a README section, "Deploy the hub anywhere".

### Changed
- Mics now receive `app` frames from the hub (`screen.speech`). Mic code that handles every `app` message without checking `topic` will see them.
- README: it leads with the loop and `npm run example`, and adds sections for `./react`, `./phone`, the echo guard and `./qr`, a table of what is in the package, and new known limits.
- In the conformance suite, "hub.say reaches no mic" now means no `screen.say` frame reaches a mic. Mics get a `screen.speech` notice instead.

## 0.2.0 (2026-10-18)

The wire protocol is still **v1** (revision 2, see [PROTOCOL.md](PROTOCOL.md#revision-history)). 0.1 and 0.2 clients and hubs interoperate in both directions. The minor bump is for behaviour that is stricter than 0.1. That behaviour is listed under "Changed" below.

### Fixed
- **The hub process can no longer be killed by one client.** Before this fix, a `hello` with a non-string `code`, an invalid UTF-8 or reserved-opcode frame, an unparseable upgrade target, or an app callback that threw (including `throw null`) crashed it. Each case is now a regression test in `test/robustness.test.ts`.
- **Reconnect never stopped trying too early.** In 0.1, reconnect stopped after one failed retry, and a failed first `connect()` was never retried. Now the client keeps retrying with capped exponential backoff and jitter until `close()`.
- **Recovery after a hub restart.** A mic answered `unknown-code` on a reconnect used to be left un-joined. Now it keeps retrying while the TV re-creates its room, and stops with status `repair` after `repairAfterMs`.
- `close()` cancels a pending retry. `connect()` rejects when the socket closes before `welcome`.
- Every `welcome` resets the clock-offset sample. `reportSay` stamps hub clock.
- A screen that sends an invalid code can no longer land in another live room. Generated codes avoid live rooms, and generation is bounded.
- `hub.close()` detaches from the HTTP server, so a new hub can attach to the same server.
- A second `hello` on one socket no longer leaves a ghost peer.
- `latency()` and `normalizeCode()` never throw on wire data. `resolveSayAudio()` handles `//host/...` URLs.
- Examples:
  - the join URL uses the LAN address and the bound port;
  - `/lib/` serves only `dist/`;
  - the web TV plays say lines through one queue, honouring `priority`;
  - the Vega example keeps one caption timer.

### Added
- **Validation:** `decodeMessage()` gives typed field-level errors. The limits are exported as `FIELD_LIMITS`, and the role rules as `CLIENT_SENDS`.
- **Reassembly:** `MessageAssembler` rebuilds messages that a runtime splits across, or coalesces into, `onmessage` events. The client uses it.
- **Client heartbeat:** a ping every 10 s, and the link counts as dead after 25 s of silence even if `onclose` never fires. There is also a connect timeout.
- **Client API:**
  - options `reconnect: boolean | ReconnectOptions`, `heartbeatMs`, `heartbeatTimeoutMs`, `connectTimeoutMs`, `maxMessageBytes`, `resumeToken` and `onHandlerError`;
  - the `status` field;
  - the events `reconnecting`, `repair` and `status`;
  - `backoffDelay()`;
  - `send()` now returns a boolean.
- **Hub API:**
  - options `roomGraceMs`, `heartbeatMs`, `conflictProbeMs`, `limits`, `rateKey`, `random` and `onRoomClose`;
  - `hub.limits` and `hub.stats`;
  - `DEFAULT_HUB_LIMITS` and `errorText()`.
- **Protocol:** an optional `hello.resumeToken`, `error.retryAfterMs`, and the error codes `rate-limited`, `id-in-use`, `full` and `not-allowed`.
- `examples/agent/`: a pluggable `respond(transcript)` that the TV renders and speaks, with a stubbed round-trip test.
- `PROTOCOL.md`: the spec, versioning rules, and which tests a second implementation must pass.

### Changed (stricter than 0.1)
- A screen hello whose explicit code matches no live room counts against the wrong-code budget, so the screen role cannot enumerate codes faster than a mic.
- Inbound messages are validated field by field. Anything malformed gets `bad-message` and is not relayed. Relayed messages carry only known fields.
- Role rules: a mic may not send `ack`, and a screen may not send transcripts. Clients may not send hub message types. All of these answer `not-allowed`.
- A room closes once its last screen has been gone for `roomGraceMs` (default 60 s). Its mics get `unknown-code`, then close code 4404.
- A `clientId` held by a live connection can be taken only with that connection's `resumeToken`. Two 0.1 clients without tokens still replace each other.
- **Defaults:**
  - 256 KiB frame cap;
  - 10,000 rooms and 32 peers per room;
  - 100 messages/s per socket;
  - 120 hellos, and 30 hellos naming an unknown code (mic or screen), per minute per remote address;
  - 1 MiB / 8 MiB backpressure thresholds;
  - hub pings every 15 s.
- `npm run build` cleans `dist/` first. `prepare` builds, so a git install builds itself.

### Migrating from 0.1
- Most apps need no code change.
- If you create a new `BridgeClient` while the old connection may still be open, persist `client.resumeToken` with the `clientId` and pass both. Otherwise the new client gets `id-in-use` while the old socket is alive.
- Behind a tunnel or reverse proxy every client shares one remote address. Pass `rateKey` (or raise `limits`) so one busy room does not rate-limit another.
- With `reconnect` on, a rejected `connect()` keeps retrying. Listen for `open` (and `repair`) instead of treating the rejection as final.

## 0.1.0 (2026-10-16)

The first standalone release, extracted from Rack Board: protocol v1, the hub, the client, conformance tests, and web, phone and Vega examples.

# Changelog

## 0.4.0 (2026-10-20)

The wire protocol is still v1, revision 3: no message or field changed, and 0.3 clients and hubs work with 0.4 ones both ways. The minor bump is for hub behaviour that changed by default (under "Changed").

### Changed
- **`handler-failed` no longer carries the exception text.** The room gets `handler failed`; the text, the room code and the `utteranceId` go to the hub's `log`. `exposeHandlerErrors: true` sends the text, capped at 2,000 characters, for development. Before, a failing `onFinal` or tracked `onApp` sent its exception text to every peer in the room, uncapped; past 2,000 characters clients refused the frame, so the error never arrived.
- **The CLI hub checks `Origin`.** It accepts WebSockets from pages it served itself (its own address, `--public-url`, `--join-url`) and from clients that send no `Origin` (TV apps, Node); a page on another site gets 403. `--origin <origin>` adds a site, and `--any-origin` turns the check off. It prints the policy at startup and each refused origin once.
- **IPv6 rate keys are the client's /64**, so one host cannot get a fresh hello and wrong-code budget from every address in its prefix (`ipv6RateKeyPrefix`, default 64; 128 keys each address on its own).
- **Pairing pauses when wrong codes pass a hub-wide budget** (below).

### Added
- **Hub, a hub-wide wrong-code budget:** `limits.hubCodeMisses` (default 100) per `limits.hubCodeMissWindowMs` (default 10 minutes), counting the misses the per-key budget counts, with one rate key counting for at most a tenth. Past it, every hello that names a code is refused with `rate-limited` until the window ends, the right code too, so a refusal tells a guesser nothing. Still admitted: connected peers, a peer resuming into its own room with the `clientId`, role and `resumeToken` it joined with, and a screen asking for a fresh code. `hub.stats.pairingPauses` counts the pauses.
- **Hub, an Origin allow-list:** `allowedOrigins` (exact origins, or a function), off by default in the library. A refused upgrade gets 403 before the handshake; an upgrade with no `Origin` always passes; a policy that throws refuses. `localOriginPolicy(extra)` is the CLI's policy, `normalizeOrigin()` the comparison, and `hub.stats.originRefused` the count. The `join` log event carries the `Origin` a peer connected with.
- **Hub:** `rateKeyBucket(key, prefix)`, `HANDLER_FAILED_MESSAGE`.
- **`./phone`:** `voiceSupport()` says whether a page can listen and, if not, why (`insecure-context`, `no-support`) and what to do: the hub's https link, Chrome's per-device developer flag with the page's origin filled in, or `localhost` on the hub's computer. Browsers with no recognizer are told which one to use.
- **The phone page** says why voice is off over plain http and lists those fixes, disables the mic controls and keeps typing. Opened without a code (`/p/`), it asks for one; the CLI hub sends `/` and `/p` there.
- **The web TV example** draws the pairing QR with `./qr`.
- **`examples/vega-voice-loop`:**
  - `RESPOND_CMD`: any command as the agent. It gets the transcript on stdin and in `$TEXT` and the room's last turns in `$HISTORY_FILE`, and prints the reply. After 8 s, a non-zero exit or no output, the TV still shows and says "Sorry, I didn't catch that." (`ok: false`), and the reason goes only to the hub's log.
  - `agents/bedrock.mjs`: a ready command for Amazon Bedrock (one Converse call per utterance through the AWS CLI).
  - `startVoiceLoop()` is exported; each loop line gains `agentMs`, and each join logs the peer's `Origin`.
  - The scripted phone takes `--n` and `--gap`.
- **`docs/https.md`:** four ways to get voice on the phone (Chrome's developer flag, an https tunnel, a local CA for an iPhone, localhost).
- **CI** on GitHub Actions: Node 20, 22 and 24 (typecheck, test, build, the loop from `dist/`, `npm pack --dry-run`), and the Vega example type-checked against the real `@amazon-devices/react-native-kepler` and `react-native-w3cmedia` packages with the packed tarball.
- **Releases:** a `v*` tag builds, tests and packs, then attaches the tarball and its SHA-256 to a GitHub release with this section as the notes. It never publishes to npm ([docs/releasing.md](docs/releasing.md)).
- `package.json`: `repository`, `homepage` and `bugs`.

### Fixed
- **`npm run example` on Node 20:** the loop example used the global `WebSocket`, which Node 20 lacks; it falls back to `ws`.
- **Hub:** every error message it sends is capped at the protocol's 2,000-character limit.

## 0.3.5 (2026-10-20)

The wire protocol is unchanged (v1, revision 3). The package's code is unchanged; only the example below is.

### Fixed
- **`examples/vega-voice-loop`:** a clip is served from the cache only when its `<id>.ok` marker is there and matches both files' sizes. The marker is written after both clips are in place. A clip made by an older version has no marker, so it is rendered again once: 0.3.3 could leave a full `.m4a` with a cut-short `.mp3` that 0.3.4 kept serving.
- **`examples/vega-voice-loop`:** work files a killed hub left in `.tts/` are swept when the hub starts, and the hub now stops its renders and removes their files on Ctrl-C (SIGINT) and SIGTERM (`createTts(...).close()`). With Polly, that includes the file holding the reply text.
- **`examples/vega-voice-loop`:** work files are named per instance, so two `createTts` on one directory no longer remove each other's files.
- **`examples/vega-voice-loop`:** a render removes its own files by name instead of listing the whole cache, and a failed removal no longer replaces the render's own error (a cache directory removed while the hub ran used to report `ENOENT` instead of the engine's failure).

## 0.3.4 (2026-10-20)

The wire protocol is unchanged (v1, revision 3). The package's code is unchanged; only the example below is.

### Fixed
- **`examples/vega-voice-loop`:** a clip is encoded into work files and moved into place only after both the MP4 and the MP3 succeeded, and it counts as cached only when both exist. An encode that failed or was killed partway used to leave a partial `.m4a` that later replies were served from; a failed render also left its work file behind.

## 0.3.3 (2026-10-19)

The wire protocol is unchanged (v1, revision 3).

### Fixed
- **Hub, `forwardedClient`:** the rate key is the bare client address. A proxy that appends `ip:port` to `X-Forwarded-For` (`203.0.113.7:51544`, `[2001:db8::7]:443`) gave each new connection its own key, and with it a fresh hello and wrong-code budget. The socket fallback is bare too (`::ffff:` removed).
- **Hub, `forwardedClient`:** the trusted-proxy list is no longer re-parsed on every upgrade; a matcher is kept per list.
- **Hub CLI, `--proxy-hops`:** above 1 with no `--proxy`, the hub warns at startup that every client behind the outer proxy shares one rate-limit key.
- **Hub CLI, `--path`:** a path with `$&`, `$'` or `` $` `` is written into the phone page as it is; it was expanded as a replacement pattern.
- **`examples/vega-voice-loop`:** two requests for the same reply while its clip renders share one render, and each render uses its own work files. The first to finish used to remove the files the second was still reading, so that line went out with no audio.

### Added
- **`./hub`:** `forwardedClientKey({ proxies, hops, trusted })`, a ready `rateKey` that checks the proxy list once, when it is built. `forwardedClient` takes a prebuilt `trusted` matcher too.

## 0.3.2 (2026-10-19)

The wire protocol is unchanged (v1, revision 3).

### Fixed
- **Hub, subprotocols:** the hub no longer answers with the first WebSocket subprotocol a client offers. A client that carried a token as a subprotocol and offered it first got it back in the `Sec-WebSocket-Protocol` response header, where proxies and tunnel inspectors record it. The new `protocols` option lists the subprotocols the hub may select; it answers with the first listed one the client offers, and with none listed it answers with no subprotocol. **An app whose clients offer a subprotocol must now list it in `protocols`**, or browsers fail the connection.
- **Hub CLI, `--proxy-hops`:** `forwardedClient` read the entry `hops` places from the end of `X-Forwarded-For` without checking the entries after it, so a client that reached the inner proxy directly (skipping the CDN) chose its own rate key on every upgrade. It now reads from the end and passes over an entry only when it is loopback or a named proxy. `--proxy` and `proxies` take CIDR ranges, for a CDN's published ranges, and a malformed one is refused. With two hops and the outer proxy not named, every client through it shares its key.
- **Hub CLI, `--path`:** the phone page it serves now connects to the hub's path. It always used `/ws`, so with `--path` the printed join URL never connected. The page reads the path from its `tv-voice-bridge-path` meta tag, which the hub fills in.
- **Hub CLI:** importing the CLI module no longer starts a hub when the importer's entry file is called `cli.js`; it starts only when Node's entry resolves to the CLI itself or its bin link.
- **`examples/vega-voice-loop`:** the Polly voice passes the reply to the AWS CLI in a temp file (`--text file://<path>`), not as `--text=<reply>`. The CLI loads a value that starts with `file://` or `fileb://` (v1 also fetches `http(s)://`), so a reply beginning with one would have been replaced by that file.

### Added
- **`./serve`:** `servePhonePage(req, res, { path })` and `lanAddress()`, moved out of the CLI, so an app built on `BridgeHub` can serve the shipped phone page. The Vega voice-loop example imports them from `tv-voice-bridge/serve` instead of `dist/cli.js`.
- **`./phone`:** `connectPhone({ path })`, the hub's WebSocket path on the page's host.
- **`./hub`:** `proxyMatcher(proxies)`, the trusted-proxy test `forwardedClient` uses (loopback, addresses and CIDR ranges).
- **`examples/vega-voice-loop`:** an optional Amazon Polly voice (`TTS_ENGINE=polly`, generative Ruth in us-east-1 by default) through the AWS CLI; local voices stay the default.

## 0.3.1 (2026-10-19)

The wire protocol is unchanged (v1, revision 3).

### Fixed
- **Hub CLI, `--trust-proxy`:** rate limits are keyed on the client address the proxy appended to `X-Forwarded-For` (the last entry), read only when the socket's peer is loopback or a proxy named with `--proxy`. They were keyed on the first entry, which the client controls, so a client that changed it on every upgrade got a fresh pairing-code guess budget each time. `--proxy-hops <n>` handles chains of proxies, and `forwardedClient(req, { proxies, hops })` in `./hub` does the same for your own `rateKey`; the README sample used the whole header.
- **Hub CLI:** the join URL it prints now opens a phone page. The hub serves `examples/minimal-phone/phone.html` at `/p/<code>` and the package's browser modules at `/lib/` (`--no-phone` turns it off); before, `/p/<code>` answered 404. The page ships in the package and the container image. The Vega voice-loop hub serves it too, and its QR uses this machine's LAN address instead of 127.0.0.1.
- **`./vega`:** a line stopped or superseded while its clip downloads, or during the MSE setup, no longer plays when the download finishes, and media events reach only the line whose source is on the player, so a barge-in or a `high` line is not cut short by the line it replaced. Stopping a line pauses it.
- **`./vega`:** an https line after a plain-http one sets `src` without clearing `srcObject` first: on a Vega device `srcObject = null` throws, and a new `src` replaces the stream. Checked on the Vega Virtual Device with http, https, http, https, https, http in a row.
- **`./vega`:** audio URLs resolve with `resolveSayAudio`, so a protocol-relative `//cdn/clip.m4a` keeps its host.
- **`./vega`:** a failed media player start is not cached; the next line tries again instead of failing until the app restarts.
- **`./phone`:** a final the recognizer delivers again is sent once, not twice.
- **`./phone`:** a `speechend` that fires before an utterance's first result is kept, so `speech.end` on short phrases is the end of speech, not the arrival of the result.
- **`./phone`:** the echo guard forgets lines that were only ever queued (a screen that reports no playback) once their hold is a minute past, so it no longer grows for the whole session.
- **`./phone`:** in continuous mode, a restart whose `recognizer.start()` throws is retried with backoff and stops the mic with a fatal error after three in a row; the mic used to stay `starting` and never listen again. A `start()` call that throws returns false.
- **Client reassembly:** each piece of a split message is scanned once, so a large message in many small pieces costs about what it costs in a few (a 900 KiB message in 1 KiB pieces went from about a second to under 10 ms on a desktop).

## 0.3.0 (2026-10-19)

The wire protocol is still **v1**. Everything below is additive.

### Changed
- `sendFinal()` returns null and `sendPartial()` false when nothing was sent (not connected, or the socket refused it); a tracked `sendApp()` returns null the same way. Before, they returned an id as if delivered, so a page showed "sent" for a lost utterance. `./phone` reports such a final as `dropped` with reason `not-connected`.
- An `onApp` handler that rejects is logged once (`handler-failed`), not a second time as `message-failed`.
- `examples/minimal-vega` uses `useVoiceBridge` and `createVegaSayPlayer`: a say queue, priority interrupts and every playback state, in about 40 lines.
- The package is now `tv-voice-bridge` (it was `@rackboard/tv-voice-bridge`). Imports change their prefix only: `tv-voice-bridge`, `tv-voice-bridge/hub`, `tv-voice-bridge/react` and so on.

### Added
- **`./vega`:** `createVegaSayPlayer({ baseUrl })`, a `SayPlayer` for `useVoiceBridge` on Vega OS's W3C media player (`@amazon-devices/react-native-w3cmedia`, an optional peer dependency). https plays in URL mode. Plain http plays through Media Source Extensions as fragmented MP4/AAC, so a laptop or LAN hub can speak its own TTS with no certificate or cloud storage. Raw MP3 over http, which Vega's MSE demuxer never starts, is refused with a message. The stream is ended only once the demuxer has it. `test/vega.test.ts` runs it against a scripted stand-in for the media player.
- **`examples/vega-voice-loop/`:** the whole loop as a Vega app (`useVoiceBridge`, `PairingQr`, `createVegaSayPlayer`), a hub with local text-to-speech (macOS `say`, Linux `espeak` or `TTS_CMD`, encoded by ffmpeg) and a scripted phone. The hub measures each loop in hub clock and shows it on the TV. On the Vega Virtual Device: speech end → reply audible 217–322 ms.
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

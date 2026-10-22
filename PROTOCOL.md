# vega-voice-bridge protocol v1

This is the wire contract between a **hub** and its clients: **screens** (TV apps) and **mics** (phones). It covers the voice round trip:

1. The phone turns speech into text and sends it.
2. The hub's app or agent understands it.
3. The TV renders the result and confirms the render.
4. The TV speaks a reply and confirms playback.

**Status:** protocol version `1`, revision 3. Packages 0.3.x and 0.4.x implement revision 3, 0.2.0 implemented revision 2, and 0.1.0 revision 1. All three revisions interoperate in both directions (see [Revision history](#revision-history)).

**Reference tests.** These suites pin the protocol down. A second implementation (another language or another TV platform) is conformant when it behaves as these cases require:

| File | What it pins down | Required of |
|---|---|---|
| [`test/vectors/wire.json`](test/vectors/wire.json) | Wire vectors as plain JSON, for any language: messages a decoder must accept unchanged, frames it must refuse (with the field the error names), and frames it must normalize | decoders (hubs and clients) |
| [`test/hub-conformance.test.ts`](test/hub-conformance.test.ts) | The hub over raw WebSockets: refusals, version, pairing and code normalization, routing and hop order, the reply's `screen.say` and `screen.speech`, the echo guard relays, role rules, `id-in-use`. `TVB_HUB_URL=ws://host:port/ws npm run conformance` runs it against any running hub that answers each final with an intent and a `screen.say` line (as `vega-voice-bridge-hub --echo` does); CI runs it against a separate hub process | hubs |
| [`test/conformance.test.ts`](test/conformance.test.ts) | Wire vectors for every message type, field validation, black-box hub behaviour over raw sockets (refusals, pairing, identity, role rules), routing, hop order, `screen.say`, and the echo guard relays (`screen.speech`, `screen.say.stop`) | hubs and clients |
| [`test/robustness.test.ts`](test/robustness.test.ts) | The hub survives malformed frames, bad upgrades and throwing handlers; room lifetime; pairing, rate and size limits; heartbeat; backpressure | hubs |
| [`test/client.test.ts`](test/client.test.ts) | Reconnect with backoff, recovery after a hub restart, re-pair, heartbeat on links that never report closing, split-frame reassembly | clients |

The keywords MUST, SHOULD and MAY follow RFC 2119.

## 1. Transport and framing

- One WebSocket (RFC 6455) per client, on a path the hub chooses (default `/ws`). Use `wss://` beyond a trusted LAN.
- Each message is one JSON object, UTF-8, in **one text frame**. Senders MUST NOT split a message across frames or put several in one frame.
- Receivers SHOULD tolerate both anyway. Some React Native runtimes deliver one frame as several `message` events, or several frames as one. The reference client reassembles them with `MessageAssembler` (top-level JSON object scanning, a size cap, and lost-fragment recovery).
- A hub MAY refuse an upgrade whose `Origin` header names a web page it does not trust, with HTTP 403 before the handshake (reference: `allowedOrigins`). It MUST NOT refuse an upgrade for carrying no `Origin`: non-browser clients such as Node send none. A TV app may send one: the Vega app on the Vega Virtual Device sends the address it dialled (`http://127.0.0.1:8790`), which the reference policy (`localOriginPolicy`) admits as the hub's own address.
- The hub refuses binary frames with `bad-message`. It closes a socket whose frame exceeds its size cap (default 256 KiB) with close code 1009. Invalid UTF-8 and other protocol errors close that socket only.
- Receivers MUST ignore fields they do not know. Optional fields MAY be absent or `null`, and `null` means absent.

## 2. Messages

Limits are maximum lengths in characters, or entries for arrays (`FIELD_LIMITS` in `src/protocol.ts`). A message that breaks a type or a limit is refused with `bad-message`, and the error names the field.

| `type` | Fields (`?` = optional) | Limits |
|---|---|---|
| `hello` | `v: 1`, `role: "screen"\|"mic"`, `clientId`, `code?`, `name?`, `resumeToken?` | clientId 1..128, code 32, name 128, resumeToken 256 |
| `welcome` | `v`, `clientId`, `role`, `code`, `joinUrl?`, `peers[]`, `serverTime` | joinUrl 2048, peers 1000 |
| `peers` | `peers[]` of `{clientId, role, name?}` | 1000 |
| `error` | `code`, `message`, `utteranceId?`, `retryAfterMs?` | code 64, message 2000 |
| `ping` | `t0` (number) | |
| `pong` | `t0`, `serverTime` | |
| `transcript.partial` | `utteranceId`, `text`, `from?`, `hops` | utteranceId 1..128, text 10,000 |
| `transcript.final` | `utteranceId`, `text`, `from?`, `hops` | as above |
| `intent` | `utteranceId`, `name`, `ok: boolean`, `payload`, `from?`, `hops` | name 128 |
| `ack` | `utteranceId`, `stage: "rendered"\|"error"`, `detail?`, `hops` | detail 2000 |
| `app` | `topic`, `payload`, `from?`, `utteranceId?`, `hops?` | topic 1..128 |

- `hops` is an array (at most 64 entries) of `{hop: string (1..64), at: number}`. A missing `hops` on a message that requires it is read as `[]`.
- A `hello` whose `v` is a number other than 1 is not a validation error: the hub answers `version`.
- `payload` is app-defined JSON, limited only by the frame cap.

## 3. Who may send what

| Sender | May send |
|---|---|
| mic | `hello`, `ping`, `transcript.partial`, `transcript.final`, `app` |
| screen | `hello`, `ping`, `ack`, `app` |
| hub | everything else (`welcome`, `peers`, `error`, `pong`, `intent`), and relays |

- Before a successful `hello`, a socket may send only `hello` and `ping`. Anything else gets `bad-message` ("say hello first").
- After `hello`, a type the role may not send gets `not-allowed`.

## 4. Routing

| Message | Delivered to |
|---|---|
| `transcript.partial` | the room's screens. The hub sets `from` to the sender's clientId and does not stamp a hop |
| `transcript.final` | the room's screens, stamped `hub.recv`, then the app's `onFinal` |
| `intent` (from the app's result) | everyone in the room, stamped `hub.intent` |
| `ack` | the room's mics, stamped `hub.ack` |
| `app` without `utteranceId` | the app's `onApp` only; nothing is broadcast, except the two relays below |
| `app` `screen.say.status` (or `*.say.status`) from a screen | also the room's mics, rebuilt as `screen.speech` (section 10.1) |
| `app` `screen.say.stop` from a mic | also the room's screens, with `from` set to the mic (section 10.1) |
| `app` with `utteranceId` | stamped `hub.recv`; the app's `onApp` may return an intent, which is fanned out like an utterance's |
| `peers` | everyone in the room, on every join and leave |
| `error handler-failed` | everyone in the room, with the `utteranceId` |

The hub rebuilds every relayed message from validated fields. Unknown fields are not forwarded, and `from` is always the hub's value.

## 5. Pairing and rooms

- A code is 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O or 1/I/L), so there are 923,521 codes. Codes are compared after trimming, upper-casing and removing anything that is not a letter or digit (`" k7q-f "` is `K7QF`).
- **Screen `hello`:**
  - With a valid code, the screen joins the live room with that code, or creates it. This is how a TV resumes after a reload or a hub restart, and how a second screen joins.
  - Without a code, or with an invalid one, the hub generates a fresh code that is never a live room's.
  - The code is the room's only credential. Codes are not authentication; see the README's security notes.
- **Mic `hello`:** it MUST name a live room. Otherwise the answer is `unknown-code`.
- **Room lifetime:** a room closes once it has had no screen for the hub's grace period (default 60 s). Mics may still join or rejoin inside the grace period. When a room closes, each remaining peer gets `error unknown-code`, then close code **4404**.
- **Capacity:** a hello beyond the hub's room cap (default 10,000) or the room's peer cap (default 32) gets `full`.
- **Rate limits:** these are counted per rate key (the remote address by default, or a key the operator derives behind a proxy). An IPv6 address SHOULD count as its /64 network, because one host can draw any address from it (reference: `ipv6RateKeyPrefix`, default 64):
  - hellos per minute (default 120);
  - hellos that name a code no live room has, per minute (default 30). This covers mics with a wrong code and screens whose explicit code misses: such a screen hello creates the room, as a resume does, but it is also how a screen would probe codes. Past the limit, hellos that name a code are refused until the window ends. A screen hello without a code is not limited by this budget.

  The same misses are also counted **hub-wide**, across all rate keys (reference: 100 per 10 minutes, with one rate key counting for at most a tenth of it), for guesses spread over many addresses. Past that budget, pairing pauses until the window ends: every hello that names a code is refused, the right code included, so a refusal tells a guesser nothing. Three kinds of hello still get in: peers already in a room stay connected; a peer resuming into its own live room with the `clientId`, role and `resumeToken` it joined with (a TV or phone back from a dropped connection) is admitted, and neither budget refuses it; and a screen hello without a code still gets a fresh room.

  All of these answer `rate-limited` with `retryAfterMs`.

## 6. Identity: `clientId` and `resumeToken`

- `clientId` is chosen by the client and shown to the room in `peers` and `from`. It is a handle, not a secret.
- `resumeToken` is a client-held secret, at least 128 random bits in the reference client. The hub never sends it to anyone. A client SHOULD send the same token on every reconnect, and SHOULD persist it whenever it persists `clientId`.
- When a hello claims a `clientId` that another socket holds in that room, the hub decides as follows:
  1. A different role is refused with `id-in-use`.
  2. If the holder's socket is already closing, the newcomer replaces it.
  3. If the hello carries the holder's token, the newcomer replaces it. If neither side has a token (two revision-1 clients), the newcomer also replaces the holder, as in revision 1.
  4. Otherwise the hub pings the holder. If the holder answers within the probe window (default 2 s), the newcomer gets `id-in-use`. If not, the newcomer replaces it.
- A second `hello` on the same socket leaves the old room or seat cleanly before joining again.

## 7. Liveness

- **Hub:** sends a WebSocket ping every 15 s by default. A socket that misses two in a row is terminated, and its peer leaves the room. Any frame from the client also counts as alive. Every compliant WebSocket stack answers pings automatically.
- **Client:**
  - SHOULD send `ping` while connected (reference: every 10 s).
  - SHOULD treat the link as dead after a silence (reference: 25 s), even if the platform never reports the socket closing.
  - SHOULD give up on an attempt that has not been welcomed (reference: 10 s).
- The `pong` answers to `ping` also refine the clock offset (section 9).

## 8. Errors and reconnecting

| `code` | Meaning | Reference client, before `welcome` |
|---|---|---|
| `unknown-code` | No live room has that code, or it closed | First pairing: fatal. Reconnect: retry for `repairAfterMs` (default 60 s), then status `repair` |
| `bad-message` | Unparseable frame or a bad field; the socket stays open | fatal |
| `version` | The hub speaks another `v` | fatal |
| `handler-failed` | The app's handler threw for `utteranceId`. The message SHOULD be generic (reference: `handler failed`): the exception text goes to the hub's log, not to the room | n/a (sent after welcome) |
| `rate-limited` | Too many hellos, wrong codes or messages; see `retryAfterMs` | retry no sooner than `retryAfterMs` |
| `id-in-use` | Another live connection holds this `clientId` | fatal |
| `full` | The hub or the room is at capacity | retry with backoff |
| `not-allowed` | This role may not send this type | fatal |

- Clients MUST treat an error code they do not know as a failure of the request that caused it.
- A hub MUST keep every `message` within the 2,000-character limit of section 2; receivers refuse a longer one, so the error would never arrive.
- Retries SHOULD use capped exponential backoff with jitter. The reference waits about 250 ms at first, doubles to a 10 s cap, and randomizes half of each delay.

## 9. Time and hops

- All timestamps are **hub clock**, in epoch milliseconds.
- A client estimates its offset from `welcome.serverTime`, then from `ping`/`pong`. It keeps the lowest-RTT sample, assuming the RTT is split evenly. It starts over on every `welcome`, because a reconnect can take a different network path.
- Each party appends hops; nobody reorders or removes them. The reference hop names are:

  `speech.end → mic.send → hub.recv → hub.intent → screen.recv → screen.render → hub.ack`

  Taps use `input.end` instead of `speech.end`. A mic MAY lead with `speech.start` (when the user started talking), so `speech.start → speech.end` is how long they spoke.
- The hub keeps at most 32 inbound hops before stamping its own.

## 10. `screen.say`: the TV talks back

- The hub sends `app` on topic `screen.say` to the room's **screens only**. The payload is `{id, text, audioUrl?, durationMs?, priority?: "normal"|"high"}`. Apps MAY use their own topic name (for example `coach.say`) with the same payload.
- The screen plays `audioUrl` if it can. Otherwise it speaks `text` with a local TTS, or shows `text` as a caption for `durationMs` (default 3000).
- `high` interrupts the current line and clears the queue. `normal` queues.
- A screen MAY report playback as `app` on `screen.say.status`, with payload `{id, state, detail?, at, text?}`. The states are `loading`, `playing`, `ended`, `interrupted`, `error` and `no-audio`, and `at` is in hub clock. The report SHOULD say `playing` only when sound has actually started. `text` (what the line says) is optional; include it for lines the screen starts itself, so a phone can recognize the TV's words.

### 10.1 The echo guard: `screen.speech` and `screen.say.stop` (revision 3)

The phone's microphone and the TV's speaker are in the same room, so a phone that keeps listening hears the TV. Two relays let it tell the TV's voice from the user's. Both are new `app` topics, so they are additive within v1.

- **`screen.speech` (hub → the room's mics).** Payload `{id, state, at, text?, durationMs?}`, where `state` is `queued` or one of the playback states above, and `at` is hub clock.
  - When the app sends a say line (`hub.say`), the hub sends each mic `queued` with the line's `text` and `durationMs`.
  - When a screen reports on `screen.say.status` (or an app-named `*.say.status`), the hub validates the payload and sends each mic the same `id`, `state`, `at` and `text`. A report that fails validation is not relayed. Reports from mics are not relayed.
  - The payload never carries `audioUrl`: say audio URLs are bearer links and stay with the screens.
  - A hub MAY turn the notices off (reference: `speechNotices: false`).
- **`screen.say.stop` (mic → hub → the room's screens).** Payload `{id?, reason?}`, for example `{id: "say_9", reason: "barge-in"}`. The hub rebuilds it from those two fields, sets `from` to the mic's clientId, and sends it to the room's screens (not to other mics). A screen that honours it SHOULD stop the current line, drop its queue and report each affected line `interrupted`. The app can send the same stop itself (reference: `hub.stopSay(room)`). A stop that a screen sends is not relayed.
- **What a mic does with them (reference: `createPhoneMic` in `./phone`).** From `queued` until `ended`, `interrupted` or `error` plus a short tail, it drops what it hears. `no-audio` releases at once, because nothing is audible. Each hold is capped, so a screen that never reports cannot silence the phone for long. With barge-in on, speech during a line that is not mostly the line's own words sends `screen.say.stop` and is kept.
- Mics MUST ignore `app` topics they do not know (section 1). Revision 3 is the first in which mics receive `app` frames from the hub.

## 11. Backpressure and message rate

- **Per socket:** the hub accepts a sustained rate of messages (default 100/s, bursts of 200). Excess messages are dropped, with at most one `rate-limited` error per second.
- **Per peer:** above a buffered-bytes threshold (default 1 MiB), the hub drops frames that the next one supersedes: `transcript.partial`, and untracked `app` frames other than say topics, `screen.speech` and `screen.say.stop`. Intents, acks, errors, say lines, speech notices and stops are always sent. Above a hard cap (default 8 MiB), the peer is disconnected; it reconnects and gets fresh state.

## 12. Versioning rules

- `v` in `hello` and `welcome` is the protocol **major** version. A hub that does not speak a client's `v` answers `error version` and leaves the socket open.
- **Allowed within v1** (a new revision):
  - new optional fields;
  - new error codes;
  - new `app` topics;
  - new hub-side limits and defaults;
  - stricter validation of values that the spec already called invalid.
- **Requires v2:**
  - removing or renaming a field, changing its type, or making an optional field required;
  - changing who receives an existing message type;
  - adding a message type that existing receivers must understand.

  Clients ignore unknown types and the hub answers `bad-message` to them, so a new client-to-hub type needs v2.
- Every change adds or updates a vector in `test/vectors/wire.json` or `test/conformance.test.ts` (and, for hub behaviour, a case in `test/hub-conformance.test.ts`) in the same commit.
- The package version is separate from the protocol version. A package minor bump (0.x) may tighten behaviour within the same protocol version, and the CHANGELOG says how.

## Revision history

### v1 revision 3 (package 0.3.0)

**Added (optional, additive):**
- the `app` topics `screen.speech` (hub → mics) and `screen.say.stop` (mic → hub → screens), section 10.1;
- the optional `text` field in a `screen.say.status` payload;
- the optional `speech.start` hop (section 9).

**Interop:**
- A revision-2 mic on a revision-3 hub receives `screen.speech` frames as `app` messages on a topic it does not know. The 0.2 client hands them to `app` handlers, which ignore topics they do not handle. Everything else is unchanged.
- A revision-3 mic on a revision-2 hub never receives `screen.speech`, so its echo guard never engages and it behaves like a revision-2 mic. Its `screen.say.stop` reaches only the app's `onApp`.
- A revision-2 screen ignores `screen.say.stop`. It still reports playback, so phones still guard against it.

### v1 revision 2 (package 0.2.0, 2026-10-18)

**Added (optional, additive):**
- `hello.resumeToken`;
- `error.retryAfterMs`;
- the error codes `rate-limited`, `id-in-use`, `full` and `not-allowed`;
- close code 4404 when a room closes.

**Tightened** (behaviour within v1):
- every field is validated against section 2;
- role rules (section 3);
- rooms close after the grace period (section 5);
- clientId claims (section 6);
- rate, size and buffer limits (sections 5, 1 and 11);
- hub heartbeat (section 7).

**Interop:**
- A revision-1 client on a revision-2 hub works unchanged. It sends no token, so same-role replacement behaves as before. It never sent messages that revision 2 refuses.
- A revision-2 client on a revision-1 hub also works. The hub ignores `resumeToken`, and the client's pings get ordinary `pong`s.

### v1 revision 1 (package 0.1.0, 2026-10-16)

The first release: roles, pairing codes, transcripts, intents, acks, the `app` channel, hop stamps, clock sync and `screen.say`.

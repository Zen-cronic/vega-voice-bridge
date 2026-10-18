# tv-voice-bridge protocol v1

This is the wire contract between a **hub** and its clients: **screens** (TV apps) and **mics** (phones). It covers the voice round trip:

1. The phone turns speech into text and sends it.
2. The hub's app or agent understands it.
3. The TV renders the result and confirms the render.
4. The TV speaks a reply and confirms playback.

**Status:** protocol version `1`, revision 2. Package 0.2.0 implements revision 2, and package 0.1.0 implemented revision 1. The two revisions interoperate in both directions (see [Revision history](#revision-history)).

**Reference tests.** A second implementation (another language or another TV platform) is conformant when it passes the following:

| File | What it pins down | Required of |
|---|---|---|
| [`test/conformance.test.ts`](test/conformance.test.ts) | Wire vectors for every message type, field validation, black-box hub behaviour over raw sockets (refusals, pairing, identity, role rules), routing, hop order, `screen.say` | hubs and clients |
| [`test/robustness.test.ts`](test/robustness.test.ts) | The hub survives malformed frames, bad upgrades and throwing handlers; room lifetime; pairing, rate and size limits; heartbeat; backpressure | hubs |
| [`test/client.test.ts`](test/client.test.ts) | Reconnect with backoff, recovery after a hub restart, re-pair, heartbeat on links that never report closing, split-frame reassembly | clients |

The keywords MUST, SHOULD and MAY follow RFC 2119.

## 1. Transport and framing

- One WebSocket (RFC 6455) per client, on a path the hub chooses (default `/ws`). Use `wss://` beyond a trusted LAN.
- Each message is one JSON object, UTF-8, in **one text frame**. Senders MUST NOT split a message across frames or put several in one frame.
- Receivers SHOULD tolerate both anyway. Some React Native runtimes deliver one frame as several `message` events, or several frames as one. The reference client reassembles them with `MessageAssembler` (top-level JSON object scanning, a size cap, and lost-fragment recovery).
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
| `app` without `utteranceId` | the app's `onApp` only; nothing is broadcast |
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
- **Rate limits:** these are counted per rate key (the remote address by default, or a key the operator derives behind a proxy):
  - hellos per minute (default 120);
  - mic hellos with a wrong code per minute (default 30). Past that, mic hellos are refused even with a right code until the window ends.

  Both answer `rate-limited` with `retryAfterMs`.

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
| `handler-failed` | The app's handler threw for `utteranceId` | n/a (sent after welcome) |
| `rate-limited` | Too many hellos, wrong codes or messages; see `retryAfterMs` | retry no sooner than `retryAfterMs` |
| `id-in-use` | Another live connection holds this `clientId` | fatal |
| `full` | The hub or the room is at capacity | retry with backoff |
| `not-allowed` | This role may not send this type | fatal |

- Clients MUST treat an error code they do not know as a failure of the request that caused it.
- Retries SHOULD use capped exponential backoff with jitter. The reference waits about 250 ms at first, doubles to a 10 s cap, and randomizes half of each delay.

## 9. Time and hops

- All timestamps are **hub clock**, in epoch milliseconds.
- A client estimates its offset from `welcome.serverTime`, then from `ping`/`pong`. It keeps the lowest-RTT sample, assuming the RTT is split evenly. It starts over on every `welcome`, because a reconnect can take a different network path.
- Each party appends hops; nobody reorders or removes them. The reference hop names are:

  `speech.end → mic.send → hub.recv → hub.intent → screen.recv → screen.render → hub.ack`

  Taps use `input.end` instead of `speech.end`.
- The hub keeps at most 32 inbound hops before stamping its own.

## 10. `screen.say`: the TV talks back

- The hub sends `app` on topic `screen.say` to the room's **screens only**. The payload is `{id, text, audioUrl?, durationMs?, priority?: "normal"|"high"}`. Apps MAY use their own topic name (for example `coach.say`) with the same payload.
- The screen plays `audioUrl` if it can. Otherwise it speaks `text` with a local TTS, or shows `text` as a caption for `durationMs` (default 3000).
- `high` interrupts the current line and clears the queue. `normal` queues.
- A screen MAY report playback as `app` on `screen.say.status`, with payload `{id, state, detail?, at}`. The states are `loading`, `playing`, `ended`, `interrupted`, `error` and `no-audio`, and `at` is in hub clock. The report SHOULD say `playing` only when sound has actually started.

## 11. Backpressure and message rate

- **Per socket:** the hub accepts a sustained rate of messages (default 100/s, bursts of 200). Excess messages are dropped, with at most one `rate-limited` error per second.
- **Per peer:** above a buffered-bytes threshold (default 1 MiB), the hub drops frames that the next one supersedes: `transcript.partial`, and untracked `app` frames other than say topics. Intents, acks, errors and say lines are always sent. Above a hard cap (default 8 MiB), the peer is disconnected; it reconnects and gets fresh state.

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
- Every change adds or updates a vector in `test/conformance.test.ts` in the same commit.
- The package version is separate from the protocol version. A package minor bump (0.x) may tighten behaviour within the same protocol version, and the CHANGELOG says how.

## Revision history

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

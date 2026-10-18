# Changelog

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

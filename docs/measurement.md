# Measurement

Where the README's numbers come from, what they leave out, and what the tests cover.

## The numbers

The table is in the [README](../README.md#measured). These numbers are the bridge's own path (phone final → TV → reply audio) with the example's offline rules and espeak; they leave out an agent's thinking time and cloud text-to-speech, so an app with a model in the loop adds that model's latency on top.

**With a model in the loop** (Amazon Bedrock, `us.amazon.nova-lite-v1:0` in us-east-1, one line, headless on one laptop with no device, 2026-10-22, **N=1**): final → reply audio ready on the TV client 1,992 ms, of which the agent command took 1,851 ms (a Node process, the AWS CLI's start-up and one Converse call; the model's own share is not separated) and espeak 122 ms. No speaker, so this stops at the clip being on the TV client, not at sound. Raw timings: [docs/bench/e2e-bedrock-2026-10-22.json](bench/e2e-bedrock-2026-10-22.json).

The scripted phone stamps `speech.end` when it sends the final, so a real phone's recognizer tail comes on top. Text-to-speech (espeak, about 140 ms) runs while the answer is already on screen. The scripted phone repeats four lines, so 14 of the 20 replies reused a clip the hub had already made; the 6 it rendered fresh are the slow end of the audible leg. The answer showed in 8–21 ms on those 6, and took up to 118 ms when a cached clip reached the TV together with the answer. Measured earlier in the first app built on the bridge, on the VVD: phone tap → TV render 6–69 ms over a reverse port forward, and `screen.say` → audio playing from a presigned S3 MP3 166–224 ms. A web TV on the same host is under 40 ms end to end.

The hop legs each number is built from are in [design.md](design.md#the-round-trip). The measured Fire TV Stick run is [scripts/stick-run.md](../scripts/stick-run.md).

## Tests

`npm test` runs every suite with vitest, offline (no device, network or keys), and CI runs it on Node 20, 22 and 24 on every push.

- **Hub conformance, against any hub** (`test/hub-conformance.test.ts`): the black-box cases a second hub must pass, over raw WebSockets. `npm test` runs them against this repo's CLI hub; `TVB_HUB_URL=ws://host:port/ws npm run conformance` runs them against any running hub, and CI runs them against a separate hub process. The wire vectors are plain JSON in `test/vectors/wire.json`.
- **Protocol conformance** (`test/conformance.test.ts`), the reference for second implementations: wire vectors for every message type; field-level validation; the hub as a black box over raw sockets (refusals, version, pairing, code normalization, `id-in-use`, 0.1 compatibility, role rules, handler failure); routing, hop order and `screen.say`; the echo guard relays.
- **Hub robustness** (`test/robustness.test.ts`): every input that crashed the 0.1.0 hub (non-string `code`, invalid UTF-8, a reserved opcode, an oversized frame, a bad upgrade target, throwing callbacks), room lifetime, collision-free codes, brute-force limits per key and hub-wide (and resuming through a pause), IPv6 /64 keys, the Origin allow-list, generic `handler-failed`, capacity, dead-holder takeover, heartbeat and backpressure.
- **Client resilience** (`test/client.test.ts`): backoff, split-frame reassembly, dead links without `onclose`, connect timeout, timer hygiene, clock-offset reset, and real hub restarts (re-join and re-pair).
- **Client and hub behaviour** (`test/bridge.test.ts`): pairing, resume, end-to-end hops, partials, taps, two mics.
- **Phone** (`test/phone.test.ts`), with a scripted recognizer and a real hub: pairing from the page address, throttled partials, `speech.start` / `speech.end`, continuous restarts, typed errors, the echo guard, late echoes, pause mode, barge-in, the guard's clock, and `voiceSupport()` per browser.
- **React** (`test/react.test.ts`), with react-test-renderer and a real hub: status transitions, ack-after-render hops, the say queue and its reports, interrupts, callback refs, cleanup, barge-in through `./phone`, and PairingQr's views reproducing and decoding to the matrix.
- **QR** (`test/qr.test.ts`): decode round trips (see [Pairing QR](api.md#pairing-qr-qr)).
- **Vega player** (`test/vega.test.ts`), against a scripted stand-in for the W3C media player.
- **Examples and the CLI** (`test/example.test.ts`, `test/agent.test.ts`, `test/loop.test.ts`, `test/tts.test.ts`, `test/respond.test.ts`): the web TV server and its QR, the agent round trip with a stubbed `respond`, `npm run example`, the hub CLI (its phone page and code entry, `--path`, the proxy rules, the Origin check), the voice loop's text-to-speech commands, `RESPOND_CMD` and the Bedrock command against a stand-in for the AWS CLI, the loop's fallback line when the agent fails, and the voice loop's Origin check.
- **Releases** (`test/release.test.ts`): no workflow publishes to npm, and the version agrees across `package.json`, the lockfile, `CHANGELOG.md` and the Vega example.

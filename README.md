# vega-voice-bridge

Two-way voice for Fire TV (Vega) apps and AI agents: the phone listens, your agent answers, the TV shows it and says it. No phone app.

[![CI](https://github.com/Zen-cronic/vega-voice-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Zen-cronic/vega-voice-bridge/actions/workflows/ci.yml)

Vega OS has no app-level speech-to-text or text-to-speech ([why, and why not Alexa or Matter](docs/design.md#why)). The phone in your hand already has a good mic and a recognizer, so the bridge carries its words to the TV, your handler answers, and the TV speaks back. Echo guard, barge-in, every hop timed.

**Measured on the Vega Virtual Device.** Version 0.3.5 has also run on a Fire TV Stick inside Spee, my speaking coach on Bee; that stick run was not measured.

![The voice loop on the Vega Virtual Device: the pairing QR, what was said, the answer, audio playing, and the measured legs](docs/vvd-voice-loop.png)

*The [Vega voice loop example](examples/vega-voice-loop) on the Vega Virtual Device.*

```
phone speech  →  your app or agent  →  TV renders  →  TV speaks (screen.say)  →  playback confirmed
```

Version **0.4.2**, protocol v1 revision 3 ([CHANGELOG.md](CHANGELOG.md)).

## Install

```bash
npm install vega-voice-bridge
```

Or from a release tag (`npm install github:Zen-cronic/vega-voice-bridge#v0.4.2`), or the tarball `vega-voice-bridge-0.4.2.tgz` attached to each [GitHub release](https://github.com/Zen-cronic/vega-voice-bridge/releases). For Vega builds, install from npm or a tarball, not `npm link`. The hub needs `ws`; Node 20 clients pass `WebSocketImpl` from `ws`. The [Vega notes](docs/api.md#vega-notes) cover Metro and React Native 0.72.

## Quick start

Try the whole loop in one process, with no device and no keys:

```bash
npm install && npm run example     # a hub, a TV and a scripted phone; prints each hop's timing
```

**1. The hub** runs your agent. In a clone, `npm run hub -- --echo`; in your app, `npx --no-install vega-voice-bridge-hub --port 8790`. In code:

```ts
import { BridgeHub } from 'vega-voice-bridge/hub';

const hub = new BridgeHub({
  server,
  onFinal: async (room, msg) => {
    const reply = await respond(msg.text);                     // rules, an LLM or an MCP tool
    hub.say(room, { id: nextId(), text: reply, audioUrl: await tts(reply) });
    return { name: 'reply', ok: true, payload: { text: msg.text, reply } };
  },
});
```

**2. The phone** is a web page served by the hub: scan the TV's QR. Voice needs https or `localhost` ([docs/https.md](docs/https.md)); every browser can type.

**3. The Vega app** is a hook, a QR and a player:

```tsx
import { useMemo } from 'react';
import { PairingQr, useVoiceBridge } from 'vega-voice-bridge/react';
import { createVegaSayPlayer } from 'vega-voice-bridge/vega';

const HUB = '127.0.0.1:8790';   // a reverse port forward on the VVD

export function App() {
  const player = useMemo(() => createVegaSayPlayer({ baseUrl: `http://${HUB}` }), []);
  const tv = useVoiceBridge({ url: `ws://${HUB}/ws`, player });
  if (tv.status !== 'paired') return <PairingQr value={tv.joinUrl ?? ''} size={200} />;
  return <Answer heard={tv.final?.text} reply={tv.intent?.payload} saying={tv.saying?.state} />;
}
```

[`examples/minimal-vega`](examples/minimal-vega/App.tsx) is a whole screen; [`examples/vega-voice-loop`](examples/vega-voice-loop) is the built, measured app with local text-to-speech; [`examples/agent`](examples/agent/agent.mjs) is an agent on a web TV.

## API

| Import | What it is |
|---|---|
| `vega-voice-bridge` | The client for both roles (React Native for Vega, web TVs, Node), plus the protocol types |
| `…/react` | `useVoiceBridge()` and `<PairingQr>` for the TV, with no native dependencies |
| `…/vega` | `createVegaSayPlayer()`: the TV speaks back on Vega OS, from a plain-http hub |
| `…/phone` | The phone page's voice half: Web Speech in, transcripts out, the echo guard and barge-in |
| `…/hub` | The Node hub, and the `vega-voice-bridge-hub` CLI |
| `…/serve` | `servePhonePage()` and `lanAddress()`: the phone page, from your own server |
| `…/qr` | A dependency-free QR Code encoder for the pairing screen |

Details: [docs/api.md](docs/api.md). How it works (round trip, echo guard, reconnects): [docs/design.md](docs/design.md). The wire protocol (v1), with conformance vectors: [PROTOCOL.md](PROTOCOL.md). Hub options and deployment: [docs/deploy.md](docs/deploy.md).

## Measured

The bridge's own path (phone final → TV → reply audio), with the example's offline rules and espeak; an agent's thinking time and cloud text-to-speech come on top.

| Leg (hub clock) | Vega Virtual Device (SDK 0.24), scripted phone, N=20, p50 / p95 | Fire TV Stick, real phone |
|---|---|---|
| speech end → answer on screen | 83 / 114 ms | *not measured yet* |
| `screen.say` → audio playing | 154 / 182 ms | *not measured yet* |
| **speech end → reply audible** | **166 / 303 ms** | *not measured yet* |
| replies played to the end | 20 of 20 | *not measured yet* |

<!-- The right-hand column is filled only from bench-phone.json after a measured stick run (scripts/stick-run.md), never by hand. test/docs.test.ts fails if a number appears there before then. -->

With Amazon Bedrock (Nova Lite) in the loop, headless, N=1: final → reply audio ready 1,992 ms, 1,851 ms of it the agent command. Method and caveats: [docs/measurement.md](docs/measurement.md).

## Known limits

- **The Fire TV Stick is not measured yet.** [scripts/stick-run.md](scripts/stick-run.md) is the measured run, step by step.
- **The phone's browser does the recognizing** ([Browsers](docs/design.md#browsers)): Firefox has none, and `speech.end` is an estimate.
- **The echo guard is a heuristic.** It trusts the TV's playback reports; room acoustics are not modelled.
- **A 4-character code pairs anyone who can see the TV.** Guessing is throttled; there is no end-to-end encryption, so serve https/wss beyond your LAN ([SECURITY.md](SECURITY.md)).
- **One hub process holds all rooms in memory.** No clustering.

## Development

```bash
npm install && npm run typecheck && npm test     # offline; CI runs Node 20, 22 and 24
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/releasing.md](docs/releasing.md). Used by Spee, a speaking coach on Bee (not public).

## License

MIT © 2026 Kaung Zin Hein

# The voice loop on Vega

A Vega TV app, a hub with local text-to-speech, and a scripted phone. You talk into the phone; the TV shows what you said, shows the answer, says it out loud and reports playback; the hub times every leg and shows the numbers on the TV.

```
phone (mic) ──transcript──▶ hub: respond(text) ──intent──▶ TV renders ──ack──▶ hub
                                  └─ tts(reply) → /tts/<id>.m4a ──screen.say──▶ TV plays ──screen.say.status──▶ hub
```

## Run it on the Vega Virtual Device

Needs the Vega SDK, `ffmpeg`, and `espeak` (Linux) or `say` (macOS); or the AWS CLI for the optional Polly voice.

```bash
# 1. the package, as a tarball the app installs
npm install && npm pack                                   # -> tv-voice-bridge-0.3.1.tgz at the repo root

# 2. the hub (port 8790): bridge + stub agent + text-to-speech
node examples/vega-voice-loop/hub.mjs

# 3. the TV app
cd examples/vega-voice-loop/vega
npm install && npm run hub -- 127.0.0.1:8790 && npm run build
vega virtual-device start
vega device start-port-forwarding -d VirtualDevice --port 8790 --forward false   # the VVD reaches the hub at 127.0.0.1
vega run-app build/x86_64-release/voiceloop_x86_64.vpkg com.tvvoicebridge.loop.main -d VirtualDevice

# 4. a phone: the scripted one (the TV shows the code), or a real phone on the same Wi-Fi scanning the TV's QR
node examples/vega-voice-loop/phone.mjs <CODE>
```

The QR opens the phone page this hub serves, at this machine's LAN address (`--public-url` overrides it). Browsers allow the microphone only on https or localhost, so over plain http the page offers typing; for voice, put the hub behind an https tunnel and pass its URL as `--public-url`.

On a Fire TV Stick, set `npm run hub -- <LAN IP>:8790` before building, and install the `armv7` or `aarch64` package.

## What to change

- **The agent:** `respond(text)` in `hub.mjs`. Rules, an LLM or an MCP tool; it returns what the TV says.
- **The voice:** `tts.mjs` uses macOS `say` (`TTS_VOICE=<voice>`) or Linux `espeak`, or any command that writes a WAV: `TTS_CMD='my-tts "$TEXT" > "$OUT"'`. For a natural cloud voice, `TTS_ENGINE=polly` calls Amazon Polly through the AWS CLI with its usual credentials (`AWS_PROFILE`): `POLLY_VOICE` (default `Ruth`), `POLLY_ENGINE` (default `generative`) and `AWS_REGION` (default `us-east-1`; not every engine is offered in every region). A clip is made once per reply text and cached. Clips are encoded as fragmented MP4/AAC, the format Vega's media player plays from a plain-http hub (raw MP3 does not).

## What is measured

All in hub clock, per utterance:

| Column | From → to |
|---|---|
| speech end → shown | the phone's `speech.end` → the TV's `screen.render` (after the frame that shows the answer) |
| say → playing | the hub sending `screen.say` → the TV reporting `playing` (sound started) |
| speech end → heard | the phone's `speech.end` → the TV reporting `playing` |

The scripted phone stamps `speech.end` when it sends the final, so a real phone adds its recognizer's tail. Measured on the Vega Virtual Device (SDK 0.24), 4 utterances: shown 11–46 ms, say → playing 72–175 ms, speech end → heard 217–322 ms.

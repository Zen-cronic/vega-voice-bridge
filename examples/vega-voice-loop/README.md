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
npm install && npm pack                                   # -> tv-voice-bridge-0.4.1.tgz at the repo root

# 2. the hub (port 8790): bridge + stub agent + text-to-speech
node examples/vega-voice-loop/hub.mjs

# 3. the TV app
cd examples/vega-voice-loop/vega
npm install && npm install ../../../tv-voice-bridge-0.4.1.tgz   # the second install refreshes the bridge after a new pack
npm run hub -- 127.0.0.1:8790 && npm run build                 # build/<arch>-release/tv-voice-bridge-voiceloop_<arch>.vpkg
vega virtual-device start
vega device start-port-forwarding -d VirtualDevice --port 8790 --forward false   # the VVD reaches the hub at 127.0.0.1
vega device terminate-app -d VirtualDevice --appName com.tvvoicebridge.loop.main  # run-app does not restart a running app
vega run-app build/x86_64-release/tv-voice-bridge-voiceloop_x86_64.vpkg com.tvvoicebridge.loop.main -d VirtualDevice

# 4. a phone: the scripted one (the TV shows the code), or a real phone on the same Wi-Fi scanning the TV's QR
node examples/vega-voice-loop/phone.mjs <CODE>
```

The QR opens the phone page this hub serves, at this machine's LAN address (`--public-url` overrides it). The hub checks `Origin` as the CLI does. It admits an upgrade with no `Origin`, one whose `Origin` is the address it reached the hub at when that is an IP address, `localhost` or a `.local` name (the pages it served), and the `--public-url` page. A page on another site gets 403 and one `{"event":"origin-refused",...}` line. `--any-origin` turns the check off. On the Vega Virtual Device the Vega app sends `Origin: http://127.0.0.1:8790`, the address it dials through the reverse forward, so the address rule admits it. What it sends on a Fire TV Stick is not checked yet ([docs/vega-notes.md](../../docs/vega-notes.md)). Browsers allow speech recognition only on https or localhost, so over plain http the page says so and offers typing; [docs/https.md](../../docs/https.md) has the ways to turn voice on (a tunnel with `--public-url`, or Chrome's developer flag on your own Android phone).

On a Fire TV Stick, either keep `127.0.0.1:8790` and add the same reverse port forward to the stick (`-d <stick IP>:5555`), or set `npm run hub -- <LAN IP>:8790` before building (it writes `vega/src/hub.local.json`, which git ignores and the app reads before the tracked `vega/src/hub.json`); then run the `armv7` or `aarch64` package. [scripts/stick-run.md](../../scripts/stick-run.md) is the measured run, step by step.

## What to change

- **The agent:** offline rules by default ([`respond.mjs`](respond.mjs)). Set `RESPOND_CMD` to any command to answer with your own agent; see [Your agent](#your-agent-respond_cmd) below.
- **The voice:** `tts.mjs` uses macOS `say` (`TTS_VOICE=<voice>`) or Linux `espeak`, or any command that writes a WAV: `TTS_CMD='my-tts "$TEXT" > "$OUT"'`. For a natural cloud voice, `TTS_ENGINE=polly` calls Amazon Polly through the AWS CLI with its usual credentials (`AWS_PROFILE`): `POLLY_VOICE` (default `Ruth`), `POLLY_ENGINE` (default `generative`) and `AWS_REGION` (default `us-east-1`; not every engine is offered in every region). A clip is made once per reply text and cached. Clips are encoded as fragmented MP4/AAC, the format Vega's media player plays from a plain-http hub (raw MP3 does not).

## Your agent (`RESPOND_CMD`)

```bash
RESPOND_CMD='<command>' node examples/vega-voice-loop/hub.mjs
```

- **The contract.** The command gets the transcript on stdin and in `$TEXT`, and the room's last six turns in `$HISTORY_FILE`: a JSON array of `{"role": "user" | "assistant", "content": "..."}`, readable only by you and removed after the call. It prints the reply on stdout. The hub cleans it for speech (one line, no terminal colour codes, at most 600 characters).
- **When it fails.** A non-zero exit, no output, or more than 8 seconds (the command and whatever it started are stopped): the TV still shows and says "Sorry, I didn't catch that.", and the intent has `ok: false`. The reason goes to the hub's log as `{"event":"respond-error",...}`, never to the phone or the TV.
- **What is timed.** The hub's `loop` line gains `agentMs` (transcript in, reply out), next to `ttsMs`. On the wire it is the `hub.recv → hub.intent` leg.

Two commands to start from. Neither is run by this repo's tests, which use stand-ins:

- **Amazon Bedrock** through the AWS CLI ([`agents/bedrock.mjs`](agents/bedrock.mjs)): one Converse call per utterance, with the history. It uses the CLI's usual credentials, and each call is billed to that account.

  ```bash
  RESPOND_CMD='node examples/vega-voice-loop/agents/bedrock.mjs' AWS_PROFILE=<your profile> node examples/vega-voice-loop/hub.mjs
  ```

  `BEDROCK_MODEL` defaults to `us.amazon.nova-lite-v1:0` (a cross-Region inference profile; the account needs access to the model in that Region), `AWS_REGION` to `us-east-1`, and `BEDROCK_MAX_TOKENS` to 160. The transcript reaches the CLI in a file, never as an argument value.
- **A local model** with Ollama (not tested here): `RESPOND_CMD='ollama run llama3.2 "Answer in one short spoken sentence: $TEXT"'`.

To make exactly one call, with the TV showing its code, send one scripted line: `node examples/vega-voice-loop/phone.mjs <CODE> --n 1`.

## What is measured

All in hub clock, per utterance:

| Column | From → to |
|---|---|
| speech end → shown | the phone's `speech.end` → the TV's `screen.render` (after the frame that shows the answer) |
| say → playing | the hub sending `screen.say` → the TV reporting `playing` (sound started) |
| speech end → heard | the phone's `speech.end` → the TV reporting `playing` |

The hub prints each loop as a JSON line, `{"event":"loop","said":...,"shownMs":...,"agentMs":...,"ttsMs":...,"sayToPlayingMs":...,"heardMs":...,"replyMs":...,"state":...}`, and each join with the `Origin` header the peer connected with (`null` when it sent none, as the scripted phone does; `http://127.0.0.1:8790` from the Vega app on the Virtual Device).

The scripted phone stamps `speech.end` when it sends the final, so a real phone adds its recognizer's tail. Measured on the Vega Virtual Device (SDK 0.24) with the scripted phone, N=20, p50 / p95: shown 83 / 114 ms, say → playing 154 / 182 ms, speech end → heard 166 / 303 ms. 20 of 20 replies played to the end.

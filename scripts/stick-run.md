# The measured Fire TV Stick run (R1)

The run that turns the README's "pending" column into measured numbers: the Vega voice loop on a real Fire TV Stick, first with the scripted phone (N=20), then with a real phone speaking (N≥10), plus four checks: barge-in, the plain-http audio question, the Alexa button, and the `Origin` the Vega app sends. It ends with a 60–90 s clip and a 6–10 s GIF.

**Who:** the operator (the stick, the phone, a speaker, filming, any tunnel) and an agent or second person at the dev machine (hub, commands, numbers). **Time:** about 90 minutes. **Never fill a number in by hand:** every number comes from `scripts/bench.mjs` over a hub log written during the run.

Produces, in a scratch folder outside the repo (they show room codes): `r1-scripted.log`, `r1-phone.log`, `r1-checks.log`, `bench-scripted.json`, `bench-phone.json`, the clip, the GIF, and the notes in [Results](#results).

## 0. Before you start

- **The stick:** in developer mode and in **TCP/IP** connection mode, on the same Wi-Fi as the dev machine (developer mode, the 6-digit code and `vega devmode enable-device` are the operator's steps). Bench troubleshooting is in [docs/vega-notes.md](../docs/vega-notes.md#a-fire-tv-stick-on-the-bench).
- **A speaker** on the TV or monitor: the echo guard and barge-in only mean something when the TV is audible.
- **Port 8790 free** on the dev machine: `ss -ltn | grep ':8790 '` prints nothing. Leave other hubs (for example one on 8791) alone.
- **Real voice needs a secure page** ([docs/https.md](../docs/https.md)):
  - an Android phone with Chrome: the developer flag for `http://<dev machine LAN IP>:8790` (recipe 1; nothing installed);
  - an iPhone: the operator starts an https tunnel to port 8790, and the hub gets `--public-url https://<tunnel host>` (recipe 2).
- **Tools:** the Vega CLI (`vega`), Node 20+, `ffmpeg`, and `espeak` (Linux) or `say` (macOS).

## 1. Build the TV app with this version

```bash
npm ci && npm pack                                   # tv-voice-bridge-0.4.0.tgz at the repo root
cd examples/vega-voice-loop/vega
npm install && npm install ../../../tv-voice-bridge-0.4.0.tgz   # refreshes a stale bridge in node_modules
npm run hub -- 127.0.0.1:8790                        # the app dials the hub through the reverse forward
npm run build                                        # build/armv7-release/tv-voice-bridge-voiceloop_armv7.vpkg
cd ../../..
```

Expect `manifest validation found 0 errors` and `info build-vega completed`.

## 2. Connect the stick

```bash
D=<stick IP>:5555
vega exec vda connect $D && vega exec vda devices    # lists "<stick IP>:5555  device"
vega device info -d $D                               # architecture: armv7l (use the aarch64 package on aarch64)
```

## 3. Hub, forward, app

```bash
node examples/vega-voice-loop/hub.mjs --port 8790 | tee r1-scripted.log          # terminal A
vega device start-port-forwarding -d $D --port 8790 --forward false             # terminal B
vega device terminate-app -d $D --appName com.tvvoicebridge.loop.main           # run-app does not restart a running app
vega run-app examples/vega-voice-loop/vega/build/armv7-release/tv-voice-bridge-voiceloop_armv7.vpkg com.tvvoicebridge.loop.main -d $D
vega device is-app-running -d $D --appName com.tvvoicebridge.loop.main
```

The TV shows VOICE LOOP, a QR and a 4-character code, and the hub prints `{"event":"join",...,"role":"screen",...}`. If the TV shows nothing, `vega device launch-app -d $D --appName com.tvvoicebridge.loop.main`. If the reverse forward does not work over Wi-Fi, rebuild with `npm run hub -- <dev machine LAN IP>:8790` (step 1) and skip the forward.

**Check: the `Origin` the Vega app sends.** Copy the `origin` field of the screen's join line into the results (`null` means no `Origin` header). The hub checks `Origin` as the CLI does and admits a client that sends none. If the TV never pairs and the hub prints `{"event":"origin-refused","origin":...}` instead of a join, copy that `origin` into the results and restart the hub with `--any-origin` for the rest of the run.

## 4. Run A: scripted phone, N=20

```bash
node examples/vega-voice-loop/phone.mjs <CODE> --port 8790 --n 20 --gap 6000    # about 2.5 minutes
```

Each utterance appears on the TV, the answer follows, the TV says it, and the hub prints a `{"event":"loop",...}` line, which the TV shows in its MEASURED rows (the current utterance shows as a pending row first). Then stop the hub (Ctrl-C) and:

```bash
node scripts/bench.mjs r1-scripted.log --label "Fire TV Stick, scripted phone" > bench-scripted.json
node scripts/bench.mjs r1-scripted.log --markdown
```

**Pass:** 20 loop lines, states all `ended`. Any `error: ...` state is a finding: record it as it is.

## 5. Run B: a real phone speaking, N≥10

```bash
node examples/vega-voice-loop/hub.mjs --port 8790 | tee r1-phone.log            # add --public-url https://<tunnel host> for an iPhone
```

The TV keeps its code (it resumes its room). On the phone, scan the TV's QR. The page should say "paired with <CODE>" and show **Hold to talk** (if it says voice is off, the secure-page step from 0 is missing). Turn on **Hands-free**, then say these, one at a time, waiting each time for the TV to finish speaking:

1. hello there
2. what time is it
3. how is the weather today
4. tell me something nice
5. what should I do next
6. can you hear me from the couch
7. say that again
8. thank you very much
9. what is the plan for tonight
10. good night

**Watch for:** the phone shows "The TV is talking; not listening to it." while the TV speaks, and the TV never receives its own words back (the hub's `said` values are only what you said). Stop the hub, then:

```bash
node scripts/bench.mjs r1-phone.log --label "Fire TV Stick, real phone (<browser and phone model>)" > bench-phone.json
```

Here `speech.end` is the browser's `speechend`, so `heardMs` (speech end → reply audible) includes the recognizer's tail. That is the number for the README's hero caption.

## 6. The checks (one hub log for all three)

```bash
RESPOND_CMD='printf "%s" "This is a long answer, so that you have time to talk over me. I will keep talking for a few more seconds, until you say something."' \
  node examples/vega-voice-loop/hub.mjs --port 8790 | tee r1-checks.log
```

1. **Barge-in.** With hands-free on, say "hello". While the TV reads the long answer, say "stop, next question please". **Pass:** the TV stops mid-line, the phone shows "Stopped the TV.", the loop line's state is `interrupted`, and the hub then gets "stop, next question please" as the next utterance. Also try a push-to-talk press while the TV talks: pressing is itself a barge-in.
2. **The Alexa button mid-reply.** Say "hello", and while the TV speaks, press the remote's Alexa button and ask nothing (or say "go back"). Record what happens: whether the app goes to the background (the hub prints `leave` for the screen), whether the reply audio stops, and, after pressing Back, whether the TV shows `paired` again and the next utterance loops. Note the timestamps.
3. **Plain-http audio in URL mode** (Amazon said a September 2026 OS update allows it; unconfirmed). Rebuild the app with the switch, run one line, then rebuild without it:

   ```bash
   (cd examples/vega-voice-loop/vega && npm run hub -- 127.0.0.1:8790 --http-url-mode && npm run build)
   vega device terminate-app -d $D --appName com.tvvoicebridge.loop.main
   vega run-app examples/vega-voice-loop/vega/build/armv7-release/tv-voice-bridge-voiceloop_armv7.vpkg com.tvvoicebridge.loop.main -d $D
   node examples/vega-voice-loop/phone.mjs <CODE> --port 8790 --n 1
   (cd examples/vega-voice-loop/vega && npm run hub -- 127.0.0.1:8790 && npm run build)   # back to the default
   ```

   **Read the loop line:** `ended` with a `sayToPlayingMs` means this OS now plays cleartext http in URL mode; `error: MediaError 4` means it still refuses. Either way the bridge's default (MSE) is unchanged; the result updates docs/vega-notes.md.

## 7. Film it (60–90 s) and cut the GIF

One take with the phone and the TV both in shot, sound on:

1. the TV's pairing screen; the phone scans the QR;
2. you speak; the words appear on the TV as you say them;
3. the answer appears, and the TV says it out loud;
4. the phone shows that it is ignoring the TV's voice (the echo guard);
5. you talk over a long answer, and it stops (barge-in);
6. the MEASURED rows on the TV.

The GIF, from the best 6–10 s (speak → answer on screen → TV speaks):

```bash
ffmpeg -ss <start s> -t 8 -i clip.mp4 -vf "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 docs/stick-loop.gif
```

Keep it under about 5 MB. Optional, for the agent beat: one real model call, with the operator's approval, by adding `RESPOND_CMD='node examples/vega-voice-loop/agents/bedrock.mjs' AWS_PROFILE=<profile>` to the hub command and saying one sentence (or `phone.mjs <CODE> --n 1`). Each call is billed to that AWS account.

## 8. Afterwards

- **Retire the filmed code:** relaunch the app (`terminate-app`, then `run-app`); the old room closes a minute later.
- `vega device stop-port-forwarding -d $D --port 8790 --forward false`; stop any tunnel.
- **Fill the placeholders from the JSON, never by hand:**
  - `README.md`: the `R1 PLACEHOLDER` block at the top (the GIF and its caption: `heardMs` p50 and p95, N, the phone and browser) and the "Fire TV Stick, real phone" column (p50 / p95 per leg from `bench-phone.json`, with `bench-scripted.json` alongside if it helps); then remove the placeholder comments and the matching check in `test/docs.test.ts`.
  - `docs/vega-notes.md`: the three **To test on the stick** items (plain-http URL mode, the Alexa button, the `Origin`).
  - The Known limits in the README.
- Keep the logs and the JSON with the run's notes, outside the repo (they contain room codes).

## Results

| Item | Result |
|---|---|
| Date, time (EDT) | |
| Stick model, architecture, Vega OS version | |
| Phone, browser, how voice was enabled (flag or tunnel) | |
| Run A: N, states, `heardMs` p50 / p95 | from `bench-scripted.json` |
| Run B: N, states, `heardMs` p50 / p95 | from `bench-phone.json` |
| Echo guard: any TV words sent back as the user's? | |
| Barge-in: stopped? state `interrupted`? | |
| Alexa button: backgrounded? recovered? | |
| Plain-http URL mode: `ended` or `MediaError 4` | |
| The Vega app's `Origin` | |
| Clip and GIF file names | |

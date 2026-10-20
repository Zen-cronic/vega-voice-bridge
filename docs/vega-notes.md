# Vega notes

What we ran into building a voice loop on Fire TV's Vega OS, and what the bridge does about each. These are platform facts and workarounds, found on the Vega Virtual Device (VVD, SDK 0.24) and a Fire TV Stick (armv7, Vega OS 2.0) between 2026-10-14 and 2026-10-20. Each note says how the bridge's current code handles it and how that was checked. Sources are Amazon's documentation and developer forum, linked inline.

> **Real-stick measurements (R1) are not in yet.** The open questions below that need the stick, such as plain-http audio after the September 2026 OS update and what happens when Alexa backgrounds the app, are marked **To test on the stick**.

## Speech in and out

- **No app-level speech-to-text.** Amazon staff: "VegaOS does not expose an app-level speech-to-text API like Android's SpeechRecognizer" ([forum 29064](https://community.amazondeveloper.com/t/speech-to-text-api-for-a-webview-app/29064)). The only platform speech-to-text is keyboard dictation: focus a `TextInput`, hold the remote's mic button, get one final string. WebView `getUserMedia` audio is "not yet supported" for third-party apps ([forum 28161](https://community.amazondeveloper.com/t/issues-with-microphone-access-for-jitsi-integration-on-vega-os/28161), 2026-07-24). [`AudioRecordStream`](https://developer.amazon.com/docs/vega-api/0.24/classes.AudioRecordStreamBuilder.amazon-devices_keplerscript-audio-lib.html) gives raw PCM behind the `com.amazon.audio.privilege.microphone.access` privilege, with no recognizer; which microphone it reaches on a stick is untested.
  - **The bridge:** the phone listens. Its browser recognizes the speech and sends text.
- **No app-level text-to-speech.** VoiceView is the only platform speech output, and `speechSynthesis` is not available ([forum 24875](https://community.amazondeveloper.com/t/tts-implementation/24875)).
  - **The bridge:** the hub makes the audio (`examples/vega-voice-loop/tts.mjs`: macOS `say`, Linux `espeak`, any command, or Amazon Polly) and sends it as a `screen.say` line; the TV plays it with `./vega`.
- **Alexa reaches an app as structured requests,** not words: Content Launcher, media controls and UI-controller selection ([KB 4341](https://community.amazondeveloper.com/t/migrating-catalog-and-voice-integration-from-fire-os-to-vega/4341), [forum 27800](https://community.amazondeveloper.com/t/is-it-posible-to-create-custom-voice-commands-on-vega/27800)). See "Why not Alexa" in the [README](../README.md#why-not).

## Audio playback (`@amazon-devices/react-native-w3cmedia`)

- **URL mode refused plain `http://`.** `AudioPlayer.src = 'http://…'` failed 7 ms later with `MediaError 4` and an empty message; the device log said `isUriSchemeSecure Got an insecure protocol/scheme http`. Staff said on 2026-10-05 that this was "fixed in one of our OS updates released in September 2026" ([forum 27667](https://community.amazondeveloper.com/t/shaka-player-fails-with-unknown-error-on-http-video/27667)); no reporter has confirmed it. **To test on the stick.**
  - **The bridge:** `./vega` never uses URL mode for http. It fetches the clip and plays it through Media Source Extensions.
- **A local-CA certificate is refused.** An https URL served with an mkcert certificate failed with `MediaError 4`; the log said `Unacceptable TLS certificate`. Only publicly trusted certificates play.
  - **The bridge:** https URLs (a presigned S3 link, a public host) play in URL mode; a laptop or LAN hub uses plain http and MSE.
- **Raw MP3 through MSE never starts,** although `MediaSource.isTypeSupported('audio/mpeg')` returns true. The demuxer reports `EndOfStream is called before initialization is completed`, or waits and then fails with `MediaError 3`. Tried with espeak, ffmpeg (44.1 kHz, no ID3) and Polly clips. Fragmented MP4 with AAC plays.
  - **The bridge:** `./vega` refuses an http MP3 up front with "Vega plays http audio only as fragmented MP4/AAC through MSE (raw MP3 never starts): serve .m4a, or an https URL", instead of the opaque `MediaError 3`. The voice-loop hub encodes with `ffmpeg -c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof -f mp4`. Measured on the VVD: `screen.say` to audio playing in 72 to 175 ms, 4 of 4 replies played to the end.
- **End the stream only after the demuxer has it.** Calling `endOfStream()` right after the first `updateend` fails; a short clip may not start until the stream is ended.
  - **The bridge:** `./vega` calls `play()` first and ends the stream on the first of `loadedmetadata`, `canplay` or `playing` (`test/vega.test.ts`, against a scripted stand-in for the player).
- **`srcObject = null` throws on a device.** Switching from an http line (MSE) to an https one by clearing `srcObject` throws.
  - **The bridge:** setting `src` replaces the stream; `./vega` never clears `srcObject`. Checked on the VVD with http, https, http, https, https, http lines in a row.
- **Speech over media.** Accessibility-usage audio ducks other audio ([forum 29107](https://community.amazondeveloper.com/t/concurrent-usage-accessibility-audio-stream-over-w3c-media-playback-supported-and-does-ducking-work-on-the-virtual-device/29107)). The bridge's player does not set an audio usage yet.

## Networking

- **The VVD's NAT address drops large WebSocket frames.** Over `ws://10.0.2.2:<port>`, frames larger than about 1.4 KB (more than one TCP segment) were lost at random, with no `onerror` or `onclose`. Over a reverse port forward, every size up to 65 KB arrived.
  - **Use:** `vega device start-port-forwarding -d VirtualDevice --port 8790 --forward false`, and connect to `ws://127.0.0.1:8790/ws`.
  - **The bridge:** the client also reassembles a message that a runtime splits across `onmessage` events, and its heartbeat drops a link that goes silent without `onclose` (`test/client.test.ts`).
- **The reverse forward works on a stick over Wi-Fi too** (`-d <stick IP>:5555`), so the app can keep `127.0.0.1:<port>` and the hub sees the stick as local (Speaking Mirror, 2026-10-20). A Fire TV Stick HD on OS 1.2 was reported to stop answering inbound LAN connections after idle ([forum 29220](https://community.amazondeveloper.com/t/29220)); the bridge's TV dials out to the hub, never the reverse.
- **The `Origin` the Vega app sends** on its WebSocket upgrade is not documented. The voice-loop hub logs it on every join, and an `Origin` it refuses as `origin-refused`. Its check, the CLI's, admits a client that sends none, or one whose `Origin` is the address it dialled (`http://127.0.0.1:8790` for `ws://127.0.0.1:8790/ws`); `--any-origin` turns it off. **To record on the stick.**

## Building and running

- **A custom Metro `resolveRequest` drops Vega's platform mapping.** The build succeeds, but the bundle has core React Native instead of `@amazon-devices/react-native-kepler`, and the app aborts on its JS thread at launch (signal 6) with no JS error in any log.
  - **The bridge:** installed from a tarball, the package needs no custom resolver; the voice-loop example uses the default Metro config. Only bundling the TypeScript source needs one, and [`examples/minimal-vega/metro.config.js`](../examples/minimal-vega/metro.config.js) re-applies the mapping first.
- **React Native 0.72 Vega apps (Metro before 0.82) ignore `exports`** unless `resolver.unstable_enablePackageExports` is on, so `tv-voice-bridge/react` and `/vega` would not resolve ([Metro docs](https://metrobundler.dev/docs/package-exports/)). Not tested here; this repo's example and CI use React Native 0.83.
- **`vega run-app` does not restart a running app.** After a rebuild it reports "Successfully launched" while the old JavaScript keeps running. Run `vega device terminate-app -d <device> --appName com.tvvoicebridge.loop.main` first.
- **A JS context can restart without a word** (seen once on the VVD, 3 s into the first audio clip; not reproduced in three later runs). The TV comes back with a new room code; the phone's client stops with `repair` a minute or two later, after the old room closes.
- **JS console output is lossy on the VVD,** so time the loop in hub clock (the hub's `loop` lines), not from the TV's logs.

## A Fire TV Stick on the bench

From the first stick run (Fire TV Stick, armv7, Vega OS 2.0, connected over Wi-Fi):

| Symptom | Cause | Fix |
|---|---|---|
| `vega device list`: "No devices found" with a USB-C cable in | The cable linked the monitor to the laptop, not the stick | Use Wi-Fi, or the stick's own USB-C port straight to the computer |
| `vega exec vda connect <IP>:5555`: "Connection refused" while `ping` answers | The stick was in USB connection mode | Developer Options, Connection Mode, TCP/IP; it reboots; connect again about 10 s later |
| `vda connect` times out | Different networks, or Wi-Fi that blocks device-to-device traffic | The same Wi-Fi for both; a phone hotspot works as a fallback |
| The stick stops responding in TCP/IP mode | A known Vega issue | Connection Mode, USB, then `vega exec vda usb` |
| `run-app` says "Successfully launched" but the TV shows nothing | Launched while the stick was still settling after the TCP/IP reboot | `vega device is-app-running -d <device> --appName <component id>`, then `vega device launch-app` |
| The stick's address changes after a router restart | DHCP | Reserve its address in the router, or read the new one on About, Network |

Check installs by the component id (`com.tvvoicebridge.loop.main`): asked by the package id, `is-app-installed` can answer "not installed" when it is.

## Backgrounding

Backgrounding suspends the JS thread. Pressing the Alexa button can background the app when Alexa shows search results ([foreground and background](https://developer.amazon.com/docs/vega/0.24/foreground-background.html)). What happens to an open WebSocket then is undocumented; the client's heartbeat and reconnect should recover it. **To test on the stick.**

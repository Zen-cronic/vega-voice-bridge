# Voice on the phone needs https

Browsers give speech recognition only to secure pages: `https://`, or `http://localhost`. A hub on your laptop serves its phone page over plain `http://192.168.x.y`, so out of the box the page says that voice is off, lists the fixes below, and offers typing. Typing works over plain http.

- **Safari 26 and later** has no `SpeechRecognition` at all on an insecure page ([Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes)).
- **Chrome** has the API but refuses to start it, and the phone page reports `insecure-context`.

Only the phone needs https. Keep the TV on plain http: on Vega, the media player plays `https://` audio only with a publicly trusted certificate (it refuses a local CA), and plain-http audio plays through Media Source Extensions as fragmented MP4/AAC, which `./vega` handles. One hub can listen on both (recipe 3).

| You want | Use |
|---|---|
| Voice on your own Android phone, now, with nothing installed | [1. Chrome's developer flag](#1-chrome-on-your-own-android-phone-the-developer-flag) |
| An iPhone, or a phone that is not yours | [2. An https tunnel](#2-an-https-tunnel) |
| Your own iPhone, with no internet in the loop | [3. A local certificate authority](#3-a-local-certificate-authority-mkcert) |
| To try voice with no phone at all | [4. localhost on the hub's computer](#4-no-phone-localhost) |

## 1. Chrome on your own Android phone: the developer flag

A per-device setting for development. Never ask a user to do this.

1. In Chrome on the phone, open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. In the text box, type the hub's origin exactly as the QR shows it, for example `http://192.168.1.20:8790` (scheme, address and port; no path).
3. Set the flag to **Enabled** and tap **Relaunch**.
4. Scan the TV's QR again. The address bar still says "Not secure", but the hold-to-talk button works.

The phone page fills in its own origin in this step when it explains why voice is off. Source: Chromium, [Deprecating powerful features on insecure origins](https://www.chromium.org/Home/chromium-security/deprecating-powerful-features-on-insecure-origins). Safari has no equivalent.

## 2. An https tunnel

A tunnel gives the hub a public `https://` address. You start it yourself; it puts the hub on the internet.

1. Start a tunnel to the hub's port with your tunnel tool, for example `ngrok http 8790`, and note its `https://` address.
2. Tell the hub, so the TV's QR carries the https link:

   ```bash
   npm run hub -- --port 8790 --public-url https://<tunnel host> --trust-proxy
   # the same from an app that installed the package:
   npx --no-install tv-voice-bridge-hub --port 8790 --public-url https://<tunnel host> --trust-proxy
   # or the Vega voice loop example:
   node examples/vega-voice-loop/hub.mjs --port 8790 --public-url https://<tunnel host>
   ```

3. Scan the QR. The phone page loads over https and connects with `wss://` on the same host.

- **Rate limits.** Everything through a tunnel arrives from the tunnel agent on loopback, so one remote address would be shared by every phone. `--trust-proxy` keys the limits on the client address the tunnel appends to `X-Forwarded-For` ([docs/deploy.md](deploy.md)). The voice loop example has no `--trust-proxy`: through a tunnel, all its phones share one rate key.
- **Origin check.** The CLI and the voice loop example both accept WebSockets from pages on `--public-url` automatically, as well as from the pages they served themselves and from clients that send no `Origin` (TV apps). A page on another site gets 403. With the CLI, a join page on another site needs `--origin https://that.site`; `--any-origin` turns the check off in both.
- **Who can join.** Anyone with the URL and the code. Codes are not authentication. Stop the tunnel when you are done, and relaunch the TV app after a recording that shows the QR, so the code that was filmed stops working once its room closes.

## 3. A local certificate authority (mkcert)

For your own iPhone on your own Wi-Fi, with no tunnel. These are mkcert's and Apple's documented steps; this repo has not run them on an iPhone.

1. On the hub's computer: `mkcert -install`, then `mkcert 192.168.1.20` (your LAN address). It writes `192.168.1.20.pem` and `192.168.1.20-key.pem`.
2. Run the hub on two listeners: http for the TV, https for phones.

   ```js
   import { readFileSync } from 'node:fs';
   import { createServer } from 'node:http';
   import { createServer as createHttpsServer } from 'node:https';
   import { BridgeHub } from 'tv-voice-bridge/hub';
   import { servePhonePage } from 'tv-voice-bridge/serve';

   const handler = (req, res) => { if (!servePhonePage(req, res)) res.writeHead(404).end(); };
   const http = createServer(handler).listen(8790);                       // the TV
   const https = createHttpsServer(
     { key: readFileSync('192.168.1.20-key.pem'), cert: readFileSync('192.168.1.20.pem') },
     handler,
   ).listen(8443);                                                        // phones
   const hub = new BridgeHub({ server: [http, https], joinUrl: (code) => `https://192.168.1.20:8443/p/${code}` });
   ```

3. On the iPhone, install mkcert's root certificate: send yourself `rootCA.pem` from the folder `mkcert -CAROOT` prints (AirDrop or mail), open it, then install the profile in **Settings → General → VPN & Device Management**.
4. Turn on full trust for it: **Settings → General → About → Certificate Trust Settings**.
5. Scan the TV's QR: it now opens `https://192.168.1.20:8443/p/<code>`.

Android Chrome and user-installed certificate authorities: not verified here; use recipe 1 on Android.

## 4. No phone: localhost

On the computer running the hub, open `http://localhost:8790/p/<code>` in Chrome or Safari (the code the TV shows). `localhost` counts as secure, so the mic works in a desktop tab, which is enough to try the loop. Desktop Chrome sends the audio to Google's speech service; see "Where speech is recognized" in the [README](../README.md#where-speech-is-recognized).

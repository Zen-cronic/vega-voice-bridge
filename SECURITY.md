# Security

vega-voice-bridge pairs a phone with a TV in the same room, the way a living room works: anyone who can see the TV can join it. It is not built to protect anything sensitive. This page says what it defends against, what it does not, and how to report a problem.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**), not a public issue. Include the version (`package.json` or the release tag), what you sent, and what happened. Reports there reach the maintainer privately.

## The model

- **The hub** is trusted: it sees every transcript and every reply. It runs no model and stores nothing. What your `onFinal` does with transcripts is your app's privacy surface.
- **The pairing code is the room's only credential.** It is 4 characters from a 31-character alphabet: 923,521 codes, drawn with the platform CSPRNG and never equal to a live room's.
- **The phone never sends audio to the hub,** only text. Its browser recognizes the speech (see "Where speech is recognized" in the [README](README.md#where-speech-is-recognized)).

## Threats, and what covers them

| Threat | What covers it | What does not |
|---|---|---|
| Someone on the network guesses the code | Per rate key, 30 wrong codes a minute; then hub-wide, 100 per 10 minutes, after which pairing pauses for every code until the window ends, so a refusal tells the guesser nothing. One rate key counts for a tenth of the hub-wide budget at most, and an IPv6 client counts as its /64. A screen naming a code counts as a guess too. | The code space is small. At the hub-wide limit a guesser gets about 14,400 guesses a day; with 10 live rooms that is roughly a 15% chance a day of landing in one. On a shared or public hub, treat codes as a convenience, not access control. |
| Someone who sees the TV (or a photo or video of the QR) | Nothing in the protocol: seeing the TV is the point. A room closes 60 s after its TV leaves, so relaunching the TV app retires a code that was filmed. | No on-screen "allow this phone?" step. Add one in your app if you need it. |
| A web page on another site, opened on a phone or laptop on your Wi-Fi, connecting to the hub (cross-site WebSocket hijacking) | The `Origin` check: the CLI accepts only pages it served itself, `--public-url`, `--join-url` and `--origin`, and the Vega voice loop example only pages it served itself and `--public-url`; `BridgeHub` has it as `allowedOrigins`. A page whose name could be re-pointed at the hub (DNS rebinding) is not trusted as same-origin unless its Host is an address, `localhost` or a `.local` name. | The library default is off. Non-browser clients can send any `Origin` they like (RFC 6455, section 10.2): the check only stops browsers. |
| A passive listener on the LAN | `wss://` and `https://` ([docs/https.md](docs/https.md)). | Over plain `ws://` and `http://`, transcripts, replies and audio are readable by anyone on the network path. The Vega TV usually stays on plain http (its media player refuses a local CA). |
| A tunnel or proxy that puts the hub on the internet | The same pairing limits; `--trust-proxy` keys them on the client address the proxy appends, never on what the client wrote. The hub never answers with a WebSocket subprotocol it was not told it may select, so a token sent as a subprotocol is not copied into response headers that proxies record. | Codes are still not authentication. Stop the tunnel when you are done. |
| A second connection taking over a phone's or TV's seat | A live `clientId` is bound to its `resumeToken`; without it, the holder is pinged and keeps its seat if it answers. | `clientId` is not a secret (it is shown to the room). |
| Error text leaking to the room | `handler-failed` says "handler failed"; the exception text goes to the hub's log (`exposeHandlerErrors` changes this, for development). | Your own `onFinal` replies are yours to sanitize. |
| Audio URLs leaking | `screen.say` URLs go to screens only; `screen.speech` notices to phones never carry them. | A URL is a bearer link: use short-lived presigned URLs, and never log the query string. |
| Flooding a hub | A frame cap (256 KiB), 100 messages a second per socket, hellos per minute per key, room and peer caps, and backpressure limits that drop captions, then disconnect a slow peer. No input, upgrade or app callback can throw out of the hub (`test/robustness.test.ts`). | The hub-wide pairing pause is itself a lever: ten addresses can pause new pairings for 10 minutes at a time. Paired peers stay connected, and peers resuming with their token still get back in. |

## Not covered

- **No end-to-end encryption.** TLS protects each device's link to the hub; the hub reads everything.
- **No password-authenticated key exchange** (PAKE) on plain-ws LANs, and no long secret in the QR. Both are planned options, not shipped.
- **No authentication of the TV to the phone,** beyond the code: a phone cannot tell a look-alike TV from the real one.
- **One hub process holds all rooms in memory.** A restart forgets them (TVs re-create their rooms on reconnect).

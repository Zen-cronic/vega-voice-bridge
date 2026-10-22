# Deploying the hub

The hub is one Node process with one dependency (`ws`). It keeps its rooms in memory, so it runs wherever Node 20 or later runs, and a restart forgets every room (TVs re-create theirs with the same code when they reconnect).

## A laptop or a box on the LAN

```bash
npm run hub -- --port 8790 --echo                # in a clone of this repo: --echo answers each final with "You said: ..."
npx --no-install tv-voice-bridge-hub --port 8790  # in an app that installed the package; never installs from npm
```

It prints the WebSocket URL and the join URL built from this machine's LAN address, and serves:

- `GET /p/<code>`: the phone page ([`examples/minimal-phone/phone.html`](../examples/minimal-phone/phone.html)); `/` and `/p/` ask for the code;
- `GET /lib/`: the package's browser modules the page imports (files of `dist/` only);
- `GET /healthz`: `{"ok":true,"rooms":<n>}`.

When `--join-url` points at your own page, add `--no-phone`. For voice on the phone the page needs https: see [https.md](https.md).

## A container

```bash
docker build -t tv-voice-bridge-hub .
docker run --rm -p 8790:8790 tv-voice-bridge-hub --public-url http://<lan-ip>:8790
```

Arguments after the image name go to the CLI. Inside a container the hub cannot see the host's LAN address, so pass `--public-url`. The image has a `HEALTHCHECK` on `/healthz`. The Dockerfile's steps were rehearsed outside a container (install, build, pack, install the tarball, start the CLI); the image itself has not been built in this repo.

## Behind a reverse proxy or a tunnel

Pass `--public-url https://your.host` (or a whole `--join-url 'https://app.example/join/{code}'`), and serve `wss://`.

**Rate limits behind a proxy (`--trust-proxy`).** Every client then reaches the hub from the proxy's address, so they would all share one rate-limit key. `--trust-proxy` keys the limits on the client address the proxy appends to `X-Forwarded-For`:

- **Which entry.** The hub reads the header from the end. The last entry is the one the proxy appended; everything before it is whatever the client sent, so it is never trusted.
- **Which proxies.** The header counts only when the socket's peer is on this machine (loopback, as a tunnel agent or a local nginx is) or a proxy named with `--proxy <addr>` (an address or a CIDR range, repeatable).
- **Two proxies** (a CDN in front of nginx, each appending): pass `--proxy-hops 2` and name the outer proxy too, with its published ranges (`--proxy 203.0.113.0/24`). The hub passes over an entry only when it is a named proxy, so a client that reaches nginx directly, skipping the CDN, is keyed on the address nginx appended, not on a header it wrote itself. Without the CDN's ranges, every CDN client shares one key: safe but coarse, and the hub warns at startup.
- **The key is the bare address.** A port the proxy appended (`203.0.113.7:51544`, `[2001:db8::7]:443`) is dropped, and an IPv6 address counts as its /64.

In your own code, `rateKey: forwardedClientKey({ proxies, hops })` from `tv-voice-bridge/hub` does the same, checking the proxy list once when it is built; `forwardedClient(req, { proxies, hops })` is the one-off form.

**Origin check.** The CLI accepts WebSockets only from pages it served itself (its own address, `--public-url`, `--join-url`) and from clients that send no `Origin` header (Node, curl). "Served itself" means the `Origin` is the address the client reached the hub at, when that is an IP address, `localhost` or a `.local` name. The Vega app on the Vega Virtual Device sends the address it dialled (`http://127.0.0.1:8790`), so it passes that way; what it sends on a Fire TV Stick is not checked yet. A page on another site gets HTTP 403, and the hub prints each refused origin once. `--origin https://app.example` adds a site; `--any-origin` turns the check off. In your own code it is `allowedOrigins` (below).

## Your own server: `BridgeHub` next to your app

```ts
import http from 'node:http';
import { BridgeHub, forwardedClientKey, localOriginPolicy } from 'tv-voice-bridge/hub';   // needs `ws`
import { lanAddress, servePhonePage } from 'tv-voice-bridge/serve';

const server = http.createServer((req, res) => {
  if (servePhonePage(req, res, { path: '/ws' })) return;     // /p/<code> and /lib/
  app(req, res);
});
const hub = new BridgeHub({
  server,                                   // or [httpServer, httpsServer]: one hub, several listeners
  joinUrl: (code) => `http://${lanAddress()}:8790/p/${code}`,
  onFinal: async (room, msg) => { /* your agent */ return { name: 'reply', ok: true, payload: {} }; },
  allowedOrigins: localOriginPolicy(['https://app.example']),
  rateKey: forwardedClientKey(),            // behind a proxy
});
server.listen(8790);
```

## Hub options

| Option | Default | What it does |
|---|---|---|
| `path` | `/ws` | WebSocket path |
| `joinUrl(code)` | none | The URL a phone opens (sent in `welcome`, for the QR) |
| `onFinal`, `onApp` | none | Your agent: return an intent to fan out, or nothing. A throw or rejection becomes `handler-failed` |
| `onJoin`, `onLeave`, `onAck`, `onRoomClose` | none | Room events; a throwing callback is logged, never propagated |
| `log(event, data)` | none | The hub's log (events below) |
| `roomGraceMs` | 60 s | A room closes this long after its last screen leaves |
| `heartbeatMs` | 15 s | Protocol ping interval; two missed pings terminate the socket |
| `conflictProbeMs` | 2 s | How long the holder of a claimed `clientId` has to answer a ping |
| `protocols` | none | WebSocket subprotocols the hub may select (the first one offered that is listed); with none listed it never answers with one |
| `allowedOrigins` | no check | Exact origins, or `(origin, req) => boolean`; other pages get 403, clients with no `Origin` always pass. `localOriginPolicy(extra)` is the CLI's |
| `rateKey(req)` | the remote address | Key for the hello and wrong-code limits |
| `ipv6RateKeyPrefix` | 64 | An IPv6 key counts as this network; 128 keys each address |
| `exposeHandlerErrors` | false | Send the handler's error text in `handler-failed` (capped at 2,000 characters) instead of "handler failed" |
| `speechNotices` | true | Send `screen.speech` to mics (the echo guard) |
| `limits.maxMessageBytes` | 256 KiB | Frame cap (a bigger frame closes that socket, 1009) |
| `limits.maxRooms` | 10,000 | Rooms the hub keeps at once |
| `limits.maxPeersPerRoom` | 32 | Peers per room |
| `limits.messagesPerSecond` | 100 | Per socket, bursts of twice this |
| `limits.hellosPerMinute` | 120 | Per rate key |
| `limits.codeMissesPerMinute` | 30 | Hellos naming a code no live room has (mic or screen), per rate key |
| `limits.hubCodeMisses` | 100 | The same misses across all keys per `hubCodeMissWindowMs` (one key counts for a tenth at most); past it, pairing pauses |
| `limits.hubCodeMissWindowMs` | 10 min | The window of `hubCodeMisses` |
| `limits.maxBufferedBytes` | 1 MiB | Above this, captions and untracked frames to a slow peer are dropped |
| `limits.maxBufferedBytesHard` | 8 MiB | Above this, the slow peer is disconnected |

`hubCodeMisses` counts TVs resuming after a hub restart as misses, so raise it for a hub that serves more than a few dozen TVs.

## What to watch

`hub.stats` counts `badMessages`, `rateLimited`, `backpressureDrops`, `backpressureCloses`, `heartbeatTimeouts`, `handlerErrors`, `roomsExpired`, `pairingPauses` and `originRefused`.

`log(event, data)` gets: `join` and `leave` (room code, role, clientId; `join` also has the `Origin` the peer connected with), `room-close`, `handler-failed` (which handler, the error text, and for an utterance its room code and `utteranceId`), `pairing-paused`, `origin-refused`, `heartbeat-timeout`, `backpressure-drop`, `backpressure-close`, and the defensive ones that should stay at zero (`hello-failed`, `message-failed`, `encode-failed`, `socket-error`, `upgrade-failed`, `wss-error`, `timer-failed`). The hub never logs transcripts, resume tokens or audio URLs.

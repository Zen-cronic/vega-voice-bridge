// Minimal vega-voice-bridge hub: serves a TV page and a phone page, echoes what the phone hears, and talks back.
//   npm run build && node examples/minimal-web-tv/server.mjs     ->  open http://localhost:8800/ on the TV
// The package imports itself by name (Node self-reference), so this resolves to dist/ when run with node.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeHub } from 'vega-voice-bridge/hub';

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, '../../dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json' };

/** This machine's first non-internal IPv4 address: what a phone on the same Wi-Fi can reach. */
export function lanIp() {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}

/** The app's understanding step. Here it echoes the words and says them back; see examples/agent for a pluggable one. */
export function echo(hub, room, msg) {
  // TV -> room speech: the screen speaks this line (browser TTS here; an https mp3 via audioUrl on Vega)
  hub.say(room, { id: `say_${msg.utteranceId}`, text: `You said: ${msg.text}`, priority: 'normal' });
  return { name: 'heard', ok: true, payload: { text: msg.text } };
}

const logStatus = (status) => console.log('[tv]', JSON.stringify(status));

export function start({ port = Number(process.env.PORT ?? 8800), host = '0.0.0.0', publicBase, onFinal = echo, onSayStatus = logStatus } = {}) {
  const server = createServer((req, res) => {
    let path = '/';
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      path = '';
    }
    let file = null;
    if (path === '/') file = join(here, 'tv.html');
    else if (path.startsWith('/p/')) file = join(here, '../minimal-phone/phone.html');
    else if (path.startsWith('/lib/')) {
      file = resolve(lib, `.${path.slice(4)}`);
      if (!file.startsWith(lib + sep)) file = null; // only files inside dist/
    }
    if (!file || !existsSync(file)) {
      res.writeHead(404).end('not found (run `npm run build` first for /lib/)');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  // The URL a phone opens: publicBase if given, else this machine's LAN address and the port actually bound.
  const reachable = host === '0.0.0.0' || host === '::' ? lanIp() : host;
  const base = () => publicBase ?? `http://${reachable}:${server.address()?.port ?? port}`;
  const hub = new BridgeHub({
    server,
    joinUrl: (code) => `${base()}/p/${code}`,
    onFinal: (room, msg, from) => onFinal(hub, room, msg, from),
    onApp: (_room, msg) => {
      if (msg.topic === 'screen.say.status') onSayStatus(msg.payload); // playback confirmed (or not) by the TV
      return null;
    },
  });
  const ready = new Promise((r) => server.listen(port, host, () => r(server.address().port)));
  return { server, hub, ready, close: () => new Promise((r) => (hub.close(), server.close(() => r()))) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = start();
  app.ready.then((port) => console.log(`TV: http://localhost:${port}/   (phone joins from the URL shown on the TV)`));
}

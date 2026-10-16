// Minimal tv-voice-bridge hub: serves a TV page and a phone page, echoes what the phone hears, and talks back.
//   npm run build && node examples/minimal-web-tv/server.mjs     ->  open http://localhost:8800/ on the TV
// The package imports itself by name (Node self-reference), so this resolves to dist/ when run with node.
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeHub } from '@rackboard/tv-voice-bridge/hub';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '../..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json' };

export function start({ port = Number(process.env.PORT ?? 8800), host = '0.0.0.0', publicBase } = {}) {
  let n = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    let file = null;
    if (path === '/') file = join(here, 'tv.html');
    else if (path.startsWith('/p/')) file = join(here, '../minimal-phone/phone.html');
    else if (path.startsWith('/lib/')) file = normalize(join(pkg, 'dist', path.slice(5)));
    if (!file || !file.startsWith(pkg) || !existsSync(file)) {
      res.writeHead(404).end('not found (run `npm run build` first for /lib/)');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  const hub = new BridgeHub({
    server,
    joinUrl: (code) => `${publicBase ?? `http://localhost:${port}`}/p/${code}`,
    // your app's understanding step: here, just echo the words back
    onFinal: (room, msg) => {
      // TV -> room speech: the screen speaks this line (browser TTS here; an https mp3 via audioUrl on Vega)
      hub.say(room, { id: `say_${++n}`, text: `You said: ${msg.text}`, priority: 'normal' });
      return { name: 'heard', ok: true, payload: { text: msg.text } };
    },
    onApp: (_room, msg) => {
      if (msg.topic === 'screen.say.status') console.log('[tv]', JSON.stringify(msg.payload));
      return null;
    },
  });
  const ready = new Promise((r) => server.listen(port, host, () => r(server.address().port)));
  return { server, hub, ready, close: () => new Promise((r) => (hub.close(), server.close(() => r()))) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = start();
  app.ready.then((port) => console.log(`TV: http://localhost:${port}/   (phone joins from the QR/URL shown on the TV)`));
}

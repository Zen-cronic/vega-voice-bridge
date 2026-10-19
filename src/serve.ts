/**
 * Serve the shipped phone page from your own HTTP server, next to a `BridgeHub`:
 *
 *   const server = createServer((req, res) => {
 *     if (servePhonePage(req, res, { path: '/ws' })) return;   // /p/<code> and /lib/
 *     ...
 *   });
 *   const hub = new BridgeHub({ server, path: '/ws', joinUrl: (code) => `http://${lanAddress()}:8790/p/${code}` });
 *
 * The CLI hub (`tv-voice-bridge-hub`) uses the same two helpers.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The phone page ships with the package; its modules are the package's own build. Both src/ and dist/ sit one
// level below the package root, so this resolves the same from either.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PHONE_PAGE = join(PACKAGE_ROOT, 'examples', 'minimal-phone', 'phone.html');
const LIB = join(PACKAGE_ROOT, 'dist');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json' };

/** The `<meta>` the phone page reads the hub's WebSocket path from. */
export const PHONE_PATH_META = 'tv-voice-bridge-path';
const PATH_META = new RegExp(`<meta name="${PHONE_PATH_META}" content="[^"]*" */?>`);

export interface ServePhonePageOptions {
  /** The hub's WebSocket path (`BridgeHub`'s `path`), written into the page so it connects there. Default `/ws`. */
  path?: string;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Serve the phone page at `/p/<code>` and the browser modules it imports at `/lib/` (files of the package's
 * `dist/` only). The page connects to the hub at `path` on its own host. Returns false when the request is for
 * neither, so the caller answers it.
 */
export function servePhonePage(req: IncomingMessage, res: ServerResponse, opts: ServePhonePageOptions = {}): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return false;
  }
  let file: string | null = null;
  if (path.startsWith('/p/')) file = PHONE_PAGE;
  else if (path.startsWith('/lib/')) {
    const f = resolve(LIB, `.${path.slice(4)}`);
    file = f.startsWith(LIB + sep) && (extname(f) === '.js' || extname(f) === '.map') ? f : '';
  } else return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return true;
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
    return true;
  }
  let body = readFileSync(file);
  if (file === PHONE_PAGE) body = Buffer.from(body.toString('utf8').replace(PATH_META, () => `<meta name="${PHONE_PATH_META}" content="${attr(opts.path ?? '/ws')}" />`), 'utf8');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** This machine's first non-internal IPv4 address: what a phone on the same Wi-Fi can reach. */
export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}

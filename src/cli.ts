#!/usr/bin/env node
/**
 * tv-voice-bridge-hub: run a hub on its own and print where phones join.
 *
 *   tv-voice-bridge-hub --port 8790 --public-url https://tv.example.com
 *
 * The hub relays transcripts, intents, acks and say lines between TVs and phones, and serves a phone page at the
 * join URL it prints. With `--echo` it also answers each final itself ("You said: ..."), which is enough to try the
 * loop. For a real app, import `BridgeHub` and pass `onFinal`. Needs the `ws` package next to this one.
 */
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BridgeHub, forwardedClient } from './hub.js';
import { lanAddress, servePhonePage } from './serve.js';

const HELP = `Usage: tv-voice-bridge-hub [options]

  --port <n>          Port to listen on (default 8790, or $PORT)
  --host <addr>       Address to bind (default 0.0.0.0)
  --path <path>       WebSocket path (default /ws); the phone page it serves connects there
  --public-url <url>  Base of the join URL phones open: <url>/p/<code>
                      (default http://<this machine's LAN address>:<port>)
  --join-url <tpl>    Full join URL template instead, with {code}, e.g. https://app.example/join/{code}
  --no-phone          Do not serve the phone page at /p/<code> (when --join-url points at your own page)
  --echo              Answer each final transcript: "You said: ..." as an intent and a say line
  --trust-proxy       Rate-limit by the client address a reverse proxy or tunnel appends to X-Forwarded-For.
                      Read only from a proxy on this machine (loopback) or one named with --proxy
  --proxy <addr>      Also trust X-Forwarded-For from a proxy at this address (repeatable)
  --proxy-hops <n>    Proxies in front of the hub, each appending to X-Forwarded-For (default 1)
  --quiet             Do not log joins and leaves
  -h, --help          Show this help

GET /p/<code> serves a phone page (hold to talk, hands-free, or type) and /lib/ the modules it imports.
Browsers allow the microphone only on https or localhost: over plain http on the LAN the page offers typing.
GET /healthz answers {"ok":true,"rooms":<n>}.`;

export interface HubCliOptions {
  port: number;
  host: string;
  path: string;
  publicUrl?: string;
  joinUrl?: string;
  echo: boolean;
  /** Serve the phone page at /p/<code>. Default true. */
  phonePage?: boolean;
  trustProxy: boolean;
  /** With trustProxy: proxy addresses trusted besides loopback. */
  proxies?: string[];
  /** With trustProxy: proxies in front of the hub. Default 1. */
  proxyHops?: number;
  quiet: boolean;
}

export function parseHubArgs(argv: string[], env: Record<string, string | undefined> = {}): HubCliOptions | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      path: { type: 'string' },
      'public-url': { type: 'string' },
      'join-url': { type: 'string' },
      echo: { type: 'boolean' },
      'no-phone': { type: 'boolean' },
      'trust-proxy': { type: 'boolean' },
      proxy: { type: 'string', multiple: true },
      'proxy-hops': { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const port = Number(values.port ?? env.PORT ?? 8790);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0..65535, got ${String(values.port ?? env.PORT)}`);
  const joinUrl = values['join-url'];
  if (joinUrl !== undefined && !joinUrl.includes('{code}')) throw new Error('--join-url must contain {code}');
  const path = values.path ?? '/ws';
  if (!path.startsWith('/')) throw new Error(`--path must start with /, got ${path}`);
  const proxyHops = Number(values['proxy-hops'] ?? 1);
  if (!Number.isInteger(proxyHops) || proxyHops < 1) throw new Error(`--proxy-hops must be a whole number from 1, got ${String(values['proxy-hops'])}`);
  return {
    port,
    host: values.host ?? '0.0.0.0',
    path,
    publicUrl: values['public-url']?.replace(/\/+$/, ''),
    joinUrl,
    echo: values.echo ?? false,
    phonePage: !values['no-phone'],
    trustProxy: values['trust-proxy'] ?? false,
    proxies: values.proxy ?? [],
    proxyHops,
    quiet: values.quiet ?? false,
  };
}

/** Start a hub on its own HTTP server. Resolves once listening, with the bound port and the join URL template. */
export async function startHubCli(o: HubCliOptions, log: (line: string) => void = (l) => console.log(l)) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: hub.rooms.size }));
      return;
    }
    if (o.phonePage !== false && servePhonePage(req, res, { path: o.path })) return;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('tv-voice-bridge hub: connect a WebSocket to ' + o.path + '\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  const reachable = o.host === '0.0.0.0' || o.host === '::' ? lanAddress() : o.host;
  const base = o.publicUrl ?? `http://${reachable}:${port}`;
  const joinUrl = (code: string) => (o.joinUrl ? o.joinUrl.split('{code}').join(code) : `${base}/p/${code}`);
  const hub: BridgeHub = new BridgeHub({
    server,
    path: o.path,
    joinUrl,
    rateKey: o.trustProxy ? (req) => forwardedClient(req, { proxies: o.proxies, hops: o.proxyHops }) : undefined,
    onFinal: o.echo
      ? (room, msg) => {
          hub.say(room, { id: `say_${msg.utteranceId}`, text: `You said: ${msg.text}`, priority: 'high' });
          return { name: 'echo', ok: true, payload: { text: msg.text } };
        }
      : undefined,
    onJoin: (room, peer) => {
      if (o.quiet) return;
      log(peer.role === 'screen' ? `room ${room.code}: TV joined; phones join at ${joinUrl(room.code)}` : `room ${room.code}: phone joined (${peer.name ?? peer.clientId})`);
    },
    onLeave: (room, peer) => {
      if (!o.quiet) log(`room ${room.code}: ${peer.role === 'screen' ? 'TV' : 'phone'} left`);
    },
  });
  log(`tv-voice-bridge hub on ws://${reachable}:${port}${o.path}`);
  log(`phones join at ${joinUrl('<CODE>')} (each TV gets its code when it connects)`);
  if (o.echo) log('echo responder on: each final is answered "You said: ..."');
  const close = () => new Promise<void>((resolve) => (hub.close(), server.close(() => resolve())));
  return { hub, server, port, joinUrl, close };
}

async function main() {
  let opts: HubCliOptions | 'help';
  try {
    opts = parseHubArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
    process.exit(2);
  }
  if (opts === 'help') {
    console.log(HELP);
    return;
  }
  const app = await startHubCli(opts);
  const stop = () => void app.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/**
 * True only when Node was started with this very file as its entry (directly, or through the
 * `tv-voice-bridge-hub` bin link, which resolves to it). Importing this module never starts a hub, whatever the
 * importer's own entry file is called.
 */
export function isEntry(argv1: string | undefined, self: string = fileURLToPath(import.meta.url)): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntry(process.argv[1])) main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

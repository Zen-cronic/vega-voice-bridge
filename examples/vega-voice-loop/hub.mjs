// The voice loop on one port: the bridge hub, the agent (offline rules, or yours with RESPOND_CMD), local
// text-to-speech, the phone page, and the loop measured in hub clock (printed, and shown on the TV).
//   node examples/vega-voice-loop/hub.mjs [--port 8790] [--public-url http://192.168.1.20:8790]
//   RESPOND_CMD='node examples/vega-voice-loop/agents/bedrock.mjs' node examples/vega-voice-loop/hub.mjs
// The Vega app reaches it at 127.0.0.1:<port> on the Virtual Device (after a reverse port forward) or at the
// LAN address on a Fire TV Stick. Replies are fragmented MP4/AAC clips served from this hub over plain http.
// The pairing QR opens the phone page on this hub, at this machine's LAN address unless --public-url says otherwise.
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeHub } from 'tv-voice-bridge/hub';
import { latency } from 'tv-voice-bridge';
import { lanAddress, servePhonePage } from 'tv-voice-bridge/serve';
import { createResponder } from './respond.mjs';
import { createTts } from './tts.mjs';

const print = (event) => console.log(JSON.stringify(event));

/**
 * Start the loop. `responder` answers each final (`createResponder()`), `tts` makes the clips (`createTts()`), and
 * `log` gets one JSON-able event per join, loop and failure. Resolves once listening.
 */
export async function startVoiceLoop({ port = 8790, host, publicUrl, responder = createResponder(), tts, log = print } = {}) {
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), '.tts');
  const voice = tts ?? createTts({ dir });
  const loops = new Map(); // say id -> what the hub saw, in hub clock
  const server = createServer((req, res) => {
    if (servePhonePage(req, res)) return; // /p/<code> and /lib/
    const m = /^\/tts\/([0-9a-f]{16})\.(m4a|mp3)$/.exec(req.url ?? '');
    const file = m && join(dir, `${m[1]}.${m[2]}`);
    if (!file || !existsSync(file)) return void res.writeHead(404).end();
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': m[2] === 'm4a' ? 'audio/mp4' : 'audio/mpeg', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  });
  let base = publicUrl;

  const hub = new BridgeHub({
    server,
    path: '/ws',
    joinUrl: (code) => `${base}/p/${code}`,
    // Each join, with the Origin header the peer connected with (none from a native TV app).
    log: (event, data) => {
      if (event === 'join') log({ event: 'join', code: data?.code, role: data?.role, origin: data?.origin ?? null });
      else if (event === 'handler-failed') log({ event: 'handler-failed', error: data?.error });
    },
    // The answer goes to the screen as soon as the agent has it; its audio follows as soon as the clip exists, so
    // the text on screen never waits for text-to-speech.
    onFinal: async (room, msg) => {
      const id = `say_${msg.utteranceId}`;
      const l = { room, text: msg.text, speechEnd: msg.hops?.find((h) => h.hop === 'speech.end')?.at ?? null, hubRecv: hub.now() };
      loops.set(id, l);
      const answer = await responder.respond(msg.text, { room: room.code });
      // A failed agent is the hub's business: the log gets why, the room gets the fallback line.
      if (answer.error) log({ event: 'respond-error', error: answer.error });
      l.replied = hub.now();
      void voice
        .clip(answer.reply)
        .catch((err) => (log({ event: 'tts-error', error: String(err?.message ?? err) }), null))
        .then((clip) => {
          l.saySent = hub.now();
          l.ttsMs = l.saySent - l.replied;
          hub.say(room, { id, text: answer.reply, audioUrl: clip ? `/tts/${clip.id}.m4a` : undefined, priority: 'high' });
        });
      return { name: 'agent.reply', ok: answer.ok, payload: { text: msg.text, reply: answer.reply, sayId: id } };
    },
    onAck: (room, msg) => {
      const l = loops.get(`say_${msg.utteranceId}`);
      if (l) l.shownMs = latency(msg.hops).span('speech.end', 'screen.render') ?? null;
    },
    onApp: (room, msg) => {
      if (msg.topic !== 'screen.say.status') return null;
      const p = msg.payload ?? {};
      const l = loops.get(p.id);
      if (!l) return null;
      if (p.state === 'playing') l.playing = p.at;
      if (['ended', 'error', 'no-audio', 'interrupted'].includes(p.state)) {
        loops.delete(p.id);
        const row = {
          said: l.text,
          shownMs: l.shownMs ?? null,
          agentMs: Math.round(l.replied - l.hubRecv),
          ttsMs: Math.round(l.ttsMs ?? 0),
          sayToPlayingMs: l.playing ? Math.round(l.playing - l.saySent) : null,
          heardMs: l.playing && l.speechEnd ? Math.round(l.playing - l.speechEnd) : null,
          replyMs: l.playing ? Math.round(p.at - l.playing) : null,
          state: p.detail ? `${p.state}: ${p.detail}` : p.state,
        };
        log({ event: 'loop', ...row });
        hub.broadcast(l.room, { type: 'app', topic: 'loop.metrics', payload: row }, ['screen']);
      }
      return null;
    },
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const bound = server.address().port;
  base = (publicUrl ?? `http://${lanAddress()}:${bound}`).replace(/\/+$/, '');
  log({ event: 'ready', port: bound, tts: voice.engine, agent: responder.engine, publicUrl: base });
  return {
    hub,
    server,
    port: bound,
    publicUrl: base,
    close: () =>
      new Promise((resolve) => {
        hub.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }).then(() => voice.close?.()),
  };
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const port = arg('--port') === undefined ? 8790 : Number(arg('--port'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0..65535, got ${arg('--port')}`);
  const loop = await startVoiceLoop({ port, publicUrl: arg('--public-url') });
  // Ctrl-C or a stop: end the renders in flight and remove their work files before exiting.
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => void loop.close().finally(() => process.exit(code)));
}

// The voice loop on one port: the bridge hub, a stub agent, local text-to-speech, and the loop measured in hub
// clock (printed, and shown on the TV).
//   node examples/vega-voice-loop/hub.mjs [--port 8790] [--public-url http://192.168.1.20:8790]
// The Vega app reaches it at 127.0.0.1:<port> on the Virtual Device (after a reverse port forward) or at the
// LAN address on a Fire TV Stick. Replies are fragmented MP4/AAC clips served from this hub over plain http.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeHub } from 'tv-voice-bridge/hub';
import { latency } from 'tv-voice-bridge';
import { createTts } from './tts.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const port = Number(arg('--port')) || 8790;
const publicUrl = (arg('--public-url') ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const dir = join(fileURLToPath(new URL('.', import.meta.url)), '.tts');
const tts = createTts({ dir });

// Your agent goes here: rules, an LLM or an MCP tool. It gets the transcript and returns what the TV says.
const respond = (text) => {
  const t = text.toLowerCase();
  if (/\btime\b/.test(t)) return `It is ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
  if (/\b(hello|hi|hey)\b/.test(t)) return 'Hello! I can hear you through your phone.';
  return `You said: ${text}`;
};

const loops = new Map(); // say id -> what the hub saw, in hub clock
const server = createServer((req, res) => {
  const m = /^\/tts\/([0-9a-f]{16})\.(m4a|mp3)$/.exec(req.url ?? '');
  const file = m && join(dir, `${m[1]}.${m[2]}`);
  if (!file || !existsSync(file)) return void res.writeHead(404).end();
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': m[2] === 'm4a' ? 'audio/mp4' : 'audio/mpeg', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
});

const hub = new BridgeHub({
  server,
  path: '/ws',
  joinUrl: (code) => `${publicUrl}/p/${code}`,
  onJoin: (room, peer) => console.log(JSON.stringify({ event: 'join', code: room.code, role: peer.role })),
  // The answer goes to the screen at once; its audio follows as soon as the clip exists, so the text on screen
  // never waits for text-to-speech.
  onFinal: (room, msg) => {
    const reply = respond(msg.text);
    const id = `say_${msg.utteranceId}`;
    const l = { room, text: msg.text, speechEnd: msg.hops?.find((h) => h.hop === 'speech.end')?.at ?? null, hubRecv: hub.now() };
    loops.set(id, l);
    void tts
      .clip(reply)
      .catch((err) => (console.log(JSON.stringify({ event: 'tts-error', error: String(err.message ?? err) })), null))
      .then((clip) => {
        l.ttsMs = hub.now() - l.hubRecv;
        l.saySent = hub.now();
        hub.say(room, { id, text: reply, audioUrl: clip ? `/tts/${clip.id}.m4a` : undefined, priority: 'high' });
      });
    return { name: 'agent.reply', ok: true, payload: { text: msg.text, reply, sayId: id } };
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
        ttsMs: Math.round(l.ttsMs ?? 0),
        sayToPlayingMs: l.playing ? Math.round(l.playing - l.saySent) : null,
        heardMs: l.playing && l.speechEnd ? Math.round(l.playing - l.speechEnd) : null,
        replyMs: l.playing ? Math.round(p.at - l.playing) : null,
        state: p.detail ? `${p.state}: ${p.detail}` : p.state,
      };
      console.log(JSON.stringify({ event: 'loop', ...row }));
      hub.broadcast(l.room, { type: 'app', topic: 'loop.metrics', payload: row }, ['screen']);
    }
    return null;
  },
});
server.listen(port, () => console.log(JSON.stringify({ event: 'ready', port, tts: tts.engine, publicUrl })));

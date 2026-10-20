// A scripted phone for measuring the loop without a person: joins the room as its mic and says each line
// (partials, then a final), leaving the TV time to answer out loud.
//   node examples/vega-voice-loop/phone.mjs <CODE> [--port 8790] [--n 4] [--gap 6000]
// --n is how many lines to say (they repeat after the fourth), --gap the milliseconds between finals.
// Its `speech.end` is stamped when the final is sent, so a real phone's recognizer tail is not included.
import WebSocket from 'ws';
import { BridgeClient, localNow } from 'tv-voice-bridge';

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const code = process.argv[2];
if (!code || code.startsWith('--')) throw new Error('usage: phone.mjs <CODE> [--port 8790] [--n 4] [--gap 6000]');
const port = Number(arg('--port', 8790));
const n = Number(arg('--n', 4));
const gap = Number(arg('--gap', 6000));
if (!Number.isInteger(n) || n < 1) throw new Error(`--n must be a whole number from 1, got ${arg('--n')}`);
const lines = ['hello there', 'what time is it', 'how is the weather today', 'tell me something nice'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const phone = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, role: 'mic', code, name: 'scripted-phone', WebSocketImpl: WebSocket });
await phone.connect();
for (let i = 0; i < n; i++) {
  const text = lines[i % lines.length];
  const words = text.split(' ');
  const id = `u${Date.now().toString(36)}`;
  for (let w = 1; w < words.length; w++) {
    phone.sendPartial(words.slice(0, w).join(' '), id);
    await pause(220);
  }
  phone.sendFinal(text, { utteranceId: id, speechEndAt: localNow() });
  await pause(gap);
}
phone.close();

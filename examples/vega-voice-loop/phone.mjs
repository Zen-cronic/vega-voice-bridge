// A scripted phone for measuring the loop without a person: joins the room as its mic and says each line
// (partials, then a final), leaving the TV time to answer out loud.
//   node examples/vega-voice-loop/phone.mjs <CODE> [--port 8790]
// Its `speech.end` is stamped when the final is sent, so a real phone's recognizer tail is not included.
import WebSocket from 'ws';
import { BridgeClient, localNow } from 'tv-voice-bridge';

const code = process.argv[2];
if (!code) throw new Error('usage: phone.mjs <CODE> [--port 8790]');
const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8790);
const lines = ['hello there', 'what time is it', 'how is the weather today', 'tell me something nice'];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const phone = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, role: 'mic', code, name: 'scripted-phone', WebSocketImpl: WebSocket });
await phone.connect();
for (const text of lines) {
  const words = text.split(' ');
  const id = `u${Date.now().toString(36)}`;
  for (let i = 1; i < words.length; i++) {
    phone.sendPartial(words.slice(0, i).join(' '), id);
    await pause(220);
  }
  phone.sendFinal(text, { utteranceId: id, speechEndAt: localNow() });
  await pause(6000);
}
phone.close();

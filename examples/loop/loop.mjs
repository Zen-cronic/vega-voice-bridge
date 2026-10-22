// The whole voice loop in one process: a hub, a TV (screen) and a phone (mic), with the hop timeline per utterance.
//   npm run example
//
// Everything is real except the two ends a terminal cannot have: the phone's recognizer is scripted (it "hears"
// the lines below), and the TV has no speaker (its player reports `playing` as soon as it starts a line, and
// `ended` after a fixed pretend length). The sockets, the hub, the clock sync, the hops, the say queue reports and
// the phone's echo guard are the library's own code. While the TV "talks", the scripted phone also hears the TV's
// reply, as a phone in the same room would, and the echo guard keeps it from coming back as a transcript.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { BridgeClient, latency } from 'vega-voice-bridge';
import { BridgeHub } from 'vega-voice-bridge/hub';
import { createPhoneMic } from 'vega-voice-bridge/phone';

// Node 22+ has a global WebSocket; Node 20 does not, so use the hub's own `ws` there.
const WebSocketImpl = globalThis.WebSocket ?? (await import('ws')).WebSocket;

const SCRIPT = ['what should I do next', 'log six reps at sixty kilos', 'how long do I rest'];
const PRETEND_AUDIO_MS = 250; // how long the speakerless TV pretends each reply plays

/** The app's understanding step: deterministic and offline. Swap in rules, an LLM or an MCP tool. */
export function respond(text) {
  if (/rest/i.test(text)) return 'Rest two minutes, then do your last set.';
  if (/log|reps/i.test(text)) return 'Logged six reps at sixty kilos.';
  return 'Next up: three sets of squats.';
}

/** A recognizer driven by the script: interim words, then the final, with speechstart and speechend events. */
class ScriptedRecognizer {
  constructor() {
    ScriptedRecognizer.current = this;
    this.results = [];
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
  }
  start() {
    this.onstart?.({});
  }
  stop() {
    this.onend?.({});
  }
  abort() {
    this.onend?.({});
  }
  push(text, isFinal) {
    let i = this.results.length - 1;
    if (i < 0 || this.results[i].isFinal) i = this.results.push(null) - 1;
    this.results[i] = { isFinal, length: 1, 0: { transcript: text } };
    this.onresult?.({ resultIndex: i, results: this.results });
  }
  /** Say a sentence: speechstart, the words one by one as interim results, speechend, then the final. */
  async speak(sentence, wordMs = 20) {
    this.onspeechstart?.({});
    const words = sentence.split(' ');
    for (let n = 1; n <= words.length; n++) {
      this.push(words.slice(0, n).join(' '), false);
      await sleep(wordMs);
    }
    this.onspeechend?.({});
    this.push(sentence, true);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => (n === null || n === undefined ? '   n/a' : `${String(Math.round(n)).padStart(4)} ms`);

export async function runLoop({ script = SCRIPT, log = (line) => console.log(line) } = {}) {
  // Hub: the app answers each final with an intent (the TV renders it) and a say line (the TV speaks it).
  const server = createServer();
  const sayAt = new Map(); // say id -> hub time it was dispatched
  const playingAt = new Map(); // say id -> hub time the TV reported playing
  const hub = new BridgeHub({
    server,
    joinUrl: (code) => `http://localhost/p/${code}`,
    onFinal: (room, msg) => {
      const reply = respond(msg.text);
      const id = `say_${msg.utteranceId}`;
      sayAt.set(id, hub.now());
      hub.say(room, { id, text: reply, priority: 'high' });
      return { name: 'reply', ok: true, payload: { text: msg.text, reply, sayId: id } };
    },
    onApp: (_room, msg) => {
      const s = msg.payload;
      if (msg.topic === 'screen.say.status' && s?.state === 'playing') playingAt.set(s.id, s.at);
      return null;
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;

  // TV: renders each intent (acked after the event loop turn that handled it) and "plays" each say line.
  const tv = new BridgeClient({ url, role: 'screen', reconnect: false, WebSocketImpl });
  const shown = [];
  tv.on('intent', (m) => {
    const receivedAt = performance.timeOrigin + performance.now();
    shown.push(m.payload.text);
    setImmediate(() => tv.ack(m, { receivedAt }));
  });
  const heardOnTv = [];
  tv.on('transcript.final', (m) => heardOnTv.push(m.text));
  tv.onSay((line) => {
    tv.reportSay({ id: line.id, state: 'loading', text: line.text });
    setImmediate(() => {
      tv.reportSay({ id: line.id, state: 'playing', text: line.text });
      setTimeout(() => tv.reportSay({ id: line.id, state: 'ended', text: line.text }), PRETEND_AUDIO_MS);
    });
  });
  const { code } = await tv.connect();

  // Phone: a mic with the scripted recognizer and the echo guard on.
  const phone = new BridgeClient({ url, role: 'mic', code, reconnect: false, WebSocketImpl });
  await phone.connect();
  await phone.syncClock();
  const mic = createPhoneMic({ client: phone, mode: 'continuous', recognizer: () => new ScriptedRecognizer(), secureContext: true, echoGuard: { tailMs: 150 } });
  const dropped = [];
  mic.on('dropped', (d) => dropped.push(d));
  mic.start();
  const waitFor = async (fn, what, limitMs = 5000) => {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > limitMs) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  };

  log(`vega-voice-bridge loop demo: hub, TV and phone in one process (room ${code})`);
  log('in-process, this machine; scripted recognizer, speakerless TV (see examples/loop/loop.mjs)');
  const rows = [];
  for (const sentence of script) {
    const acked = new Promise((resolve) => {
      const off = phone.on('ack', (a) => (off(), resolve(a)));
    });
    await ScriptedRecognizer.current.speak(sentence);
    const ack = await acked;
    const l = latency(ack.hops);
    const id = `say_${ack.utteranceId}`;
    await waitFor(() => playingAt.has(id), 'the TV to report playing');
    // The phone hears the TV's reply while it plays: the echo guard must drop it.
    await waitFor(() => mic.guarded, 'the echo guard');
    await ScriptedRecognizer.current.speak(respond(sentence), 5);
    await waitFor(() => !mic.guarded, 'the TV to finish');
    const row = {
      text: sentence,
      legs: {
        'mic.send -> hub.recv': l.span('mic.send', 'hub.recv'),
        'hub.recv -> hub.intent': l.span('hub.recv', 'hub.intent'),
        'hub.intent -> screen.recv': l.span('hub.intent', 'screen.recv'),
        'screen.recv -> screen.render': l.span('screen.recv', 'screen.render'),
      },
      speechEndToRender: l.span('speech.end', 'screen.render'),
      sayToPlaying: playingAt.get(id) - sayAt.get(id),
    };
    rows.push(row);
    log('');
    log(`"${sentence}"  ->  TV says "${respond(sentence)}"`);
    for (const [leg, v] of Object.entries(row.legs)) log(`  ${leg.padEnd(30)} ${ms(v)}`);
    log(`  ${'speech.end -> screen.render'.padEnd(30)} ${ms(row.speechEndToRender)}   (heard -> on screen)`);
    log(`  ${'say -> playing'.padEnd(30)} ${ms(row.sayToPlaying)}   (reply dispatched -> TV reports sound)`);
  }
  log('');
  const echoes = dropped.filter((d) => d.reason === 'echo' || d.reason === 'echo-text');
  log(`echo guard: ${echoes.length} of ${script.length} replies heard by the phone were dropped; the TV received ${heardOnTv.length} transcripts, all from the user`);
  mic.dispose();
  phone.close();
  tv.close();
  hub.close();
  await new Promise((r) => server.close(r));
  return { rows, dropped, heardOnTv, shown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLoop().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

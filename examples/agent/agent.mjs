// A voice back-and-forth agent: phone speech -> respond(transcript) -> the TV shows it and says the reply.
//   npm run build && node examples/agent/agent.mjs    ->  open http://localhost:8800/ on the TV, the shown URL on a phone
//
// `respond` is where your agent plugs in. It gets the final transcript and returns the text the TV should say:
//   LLM: respond = async (t) => (await llm.chat({ messages: [...history, { role: 'user', content: t }] })).text
//   MCP: respond = async (t) => (await mcp.callTool({ name: 'answer', arguments: { question: t } })).content[0].text
// The bridge never calls a model itself, and nothing here does: the default responder is offline and deterministic.
import { fileURLToPath } from 'node:url';
import { start } from '../minimal-web-tv/server.mjs';

export const echoRespond = async (transcript) => `You said: ${transcript}`;

/** Turn a responder into the hub's onFinal: time-boxed, never throws, and the TV always answers. */
export function agentTurn(respond, { timeoutMs = 8000, fallback = "Sorry, I didn't catch that." } = {}) {
  return async (hub, room, msg, from) => {
    let timer;
    let reply = fallback;
    let ok = false;
    try {
      const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('respond() timed out')), timeoutMs)));
      const answer = Promise.resolve().then(() => respond(msg.text, { room: room.code, from: from.clientId, utteranceId: msg.utteranceId }));
      const text = await Promise.race([answer, timeout]);
      if (typeof text === 'string' && text.trim()) [reply, ok] = [text.trim(), true];
    } catch {
      // keep the fallback line: a silent TV is the worst answer
    } finally {
      clearTimeout(timer);
    }
    const line = hub.say(room, { id: `reply_${msg.utteranceId}`, text: reply, priority: 'high' }); // the TV speaks
    return { name: 'agent.reply', ok, payload: { text: msg.text, reply: line.text, sayId: line.id } }; // the TV renders
  };
}

export const startAgent = ({ respond = echoRespond, timeoutMs, fallback, ...opts } = {}) =>
  start({ ...opts, onFinal: agentTurn(respond, { timeoutMs, fallback }) });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startAgent().ready.then((port) => console.log(`Agent TV: http://localhost:${port}/   (phone joins from the URL shown on the TV)`));
}

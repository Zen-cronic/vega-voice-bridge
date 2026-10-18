// examples/agent: the whole voice round trip with a stubbed `respond` (no model is called anywhere):
// phone speech -> respond(transcript) -> TV renders (ack) -> TV speaks (screen.say) -> playback confirmed (screen.say.status).
import { afterEach, expect, it, vi } from 'vitest';
import { BridgeClient, latency, type AckMsg, type IntentMsg, type SayPayload } from '../src/index.js';
// @ts-expect-error plain-JS example without type declarations
import { startAgent } from '../examples/agent/agent.mjs';

type App = { ready: Promise<number>; close: () => Promise<void> };
const open: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
});

async function pair(opts: Record<string, unknown>) {
  const statuses: unknown[] = [];
  const app = startAgent({ port: 0, host: '127.0.0.1', onSayStatus: (s: unknown) => statuses.push(s), ...opts }) as App;
  open.push(() => app.close());
  const url = `ws://127.0.0.1:${await app.ready}/ws`;
  const tv = new BridgeClient({ url, role: 'screen', reconnect: false });
  open.push(() => tv.close());
  const { code } = await tv.connect();
  const phone = new BridgeClient({ url, role: 'mic', code, reconnect: false });
  open.push(() => phone.close());
  await phone.connect();
  return { tv, phone, code, statuses };
}

it('round trip: phone speech -> respond() -> TV renders -> TV says the reply -> playback confirmed', async () => {
  const respond = vi.fn(async (t: string) => `${t.split(' ').length} words heard.`);
  const { tv, phone, code, statuses } = await pair({ respond });
  tv.on('intent', (m) => tv.ack(m, { receivedAt: performance.timeOrigin + performance.now() }));
  tv.onSay((line) => tv.reportSay({ id: line.id, state: 'playing' }));
  const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
  const intent = new Promise<IntentMsg>((r) => phone.on('intent', r));
  const ack = new Promise<AckMsg>((r) => phone.on('ack', r));

  const id = phone.sendFinal('what should I do next', { speechEndAt: performance.timeOrigin + performance.now() });

  expect(await intent).toMatchObject({ name: 'agent.reply', ok: true, payload: { text: 'what should I do next', reply: '5 words heard.' } });
  expect(respond).toHaveBeenCalledWith('what should I do next', { room: code, from: phone.clientId, utteranceId: id });
  const line = await said;
  expect(line).toMatchObject({ id: `reply_${id}`, text: '5 words heard.', priority: 'high' });
  const hops = (await ack).hops;
  expect(hops.map((h) => h.hop)).toEqual(['speech.end', 'mic.send', 'hub.recv', 'hub.intent', 'screen.recv', 'screen.render', 'hub.ack']);
  expect(latency(hops).span('speech.end', 'screen.render')).toBeGreaterThanOrEqual(0);
  await vi.waitFor(() => expect(statuses).toEqual([expect.objectContaining({ id: `reply_${id}`, state: 'playing' })]));
});

it('a responder that throws still gets an answer on the TV (the fallback line), with ok=false', async () => {
  const { tv, phone } = await pair({
    respond: () => {
      throw new Error('model unavailable');
    },
    fallback: 'One moment.',
  });
  const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
  const intent = new Promise<IntentMsg>((r) => tv.on('intent', r));
  phone.sendFinal('hello');
  expect((await said).text).toBe('One moment.');
  expect(await intent).toMatchObject({ ok: false, payload: { reply: 'One moment.' } });
});

it('a responder slower than timeoutMs is cut off with the fallback', async () => {
  const { tv, phone } = await pair({ respond: () => new Promise((r) => setTimeout(() => r('too late'), 500)), timeoutMs: 40 });
  const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
  phone.sendFinal('hello');
  expect((await said).text).toBe("Sorry, I didn't catch that.");
});

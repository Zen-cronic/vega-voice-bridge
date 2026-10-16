// Smoke test for examples/minimal-web-tv: the hub serves both pages, and a phone utterance comes back as an intent
// plus a screen.say line on the TV.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BridgeClient, type IntentMsg, type SayPayload } from '../src/index.js';
// @ts-expect-error plain-JS example without type declarations
import { start } from '../examples/minimal-web-tv/server.mjs';

let app: { ready: Promise<number>; close: () => Promise<void> };
let port = 0;
beforeAll(async () => {
  app = start({ port: 0, host: '127.0.0.1' });
  port = await app.ready;
});
afterAll(() => app.close());

it('serves the TV and phone pages', async () => {
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('minimal TV');
  expect(await (await fetch(`http://127.0.0.1:${port}/p/ABCD`)).text()).toContain('phone mic');
});

it('phone utterance -> intent on the TV + the TV says it back', async () => {
  const tv = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, role: 'screen', reconnect: false });
  const { code } = await tv.connect();
  const phone = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, role: 'mic', code, reconnect: false });
  await phone.connect();
  const intent = new Promise<IntentMsg>((r) => tv.on('intent', r));
  const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
  phone.sendFinal('six with ten pounds');
  expect((await intent).payload).toEqual({ text: 'six with ten pounds' });
  expect((await said).text).toBe('You said: six with ten pounds');
  tv.close();
  phone.close();
});

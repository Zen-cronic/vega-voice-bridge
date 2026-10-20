// Smoke test for examples/minimal-web-tv: the hub serves both pages, and a phone utterance comes back as an intent
// plus a screen.say line on the TV.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BridgeClient, type IntentMsg, type SayPayload } from '../src/index.js';
// @ts-expect-error plain-JS example without type declarations
import { lanIp, start } from '../examples/minimal-web-tv/server.mjs';

let app: { ready: Promise<number>; close: () => Promise<void> };
let port = 0;
beforeAll(async () => {
  app = start({ port: 0, host: '0.0.0.0' });
  port = await app.ready;
});
afterAll(() => app.close());

it('serves the TV and phone pages; /lib/ serves only dist/', async () => {
  expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('minimal TV');
  expect(await (await fetch(`http://127.0.0.1:${port}/p/ABCD`)).text()).toContain('phone mic');
  for (const escape of ['/lib/..%2Fpackage.json', '/lib/%2e%2e/src/hub.ts', '/lib/..%2F..%2Fpackage.json'])
    expect((await fetch(`http://127.0.0.1:${port}${escape}`)).status).toBe(404);
});

it('the TV page draws the pairing QR from the join URL with ./qr, which /lib/ serves', async () => {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  expect(html).toContain("import { qrMatrix, qrSvg } from '/lib/qr.js';");
  expect(html).toContain('qrSvg(qrMatrix(w.joinUrl)');
  const lib = await fetch(`http://127.0.0.1:${port}/lib/qr.js`);
  if (lib.status === 200) expect(await lib.text()).toContain('export function qrSvg'); // dist/ exists once built
});

it('M38: the join URL points at the LAN address and the bound port, not localhost:0', async () => {
  const tv = new BridgeClient({ url: `ws://127.0.0.1:${port}/ws`, role: 'screen', reconnect: false });
  const { code, joinUrl } = await tv.connect();
  expect(joinUrl).toBe(`http://${lanIp() as string}:${port}/p/${code}`);
  tv.close();
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

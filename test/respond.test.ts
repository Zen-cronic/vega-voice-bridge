// examples/vega-voice-loop: the agent behind RESPOND_CMD, the loop's answer when it fails, and its hub's Origin
// check. No model is called: every command here is a shell one-liner or a stand-in for the AWS CLI.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BridgeClient, type BridgeMessage, type IntentMsg, type SayPayload } from '../src/index.js';
// @ts-expect-error: a plain .mjs example module
import { FALLBACK, cleanReply, createResponder, offlineRespond, runCommand } from '../examples/vega-voice-loop/respond.mjs';
// @ts-expect-error: a plain .mjs example module
import { startVoiceLoop } from '../examples/vega-voice-loop/hub.mjs';

type Answer = { reply: string; ok: boolean; source: string; error?: string };
type Responder = { engine: string; respond: (text: string, o?: { room?: string }) => Promise<Answer> };
const open: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'tvb-respond-'));
  open.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RESPOND_CMD: your agent as a command', () => {
  it('without RESPOND_CMD the offline rules answer', async () => {
    const r = createResponder({ env: {} }) as Responder;
    expect(r.engine).toBe('offline rules');
    expect(await r.respond('hello there')).toEqual({ reply: offlineRespond('hello there'), ok: true, source: 'offline' });
    expect((await r.respond('what time is it')).reply).toMatch(/^It is /);
  });

  it('the command runs in exactly the environment the responder was given', async () => {
    const r = createResponder({ env: { PATH: process.env.PATH, ONLY_HERE: 'yes', RESPOND_CMD: 'printf "%s|%s" "$ONLY_HERE" "${HOME:-none}"' } }) as Responder;
    expect((await r.respond('x')).reply).toBe('yes|none');
  });

  it('the command gets the transcript on stdin and in $TEXT, and its stdout is the reply', async () => {
    const r = createResponder({ env: { RESPOND_CMD: 'read -r line; printf "heard: %s / %s" "$line" "$TEXT"' } }) as Responder;
    expect(await r.respond('what should I do next')).toEqual({ reply: 'heard: what should I do next / what should I do next', ok: true, source: 'command' });
  });

  it('$HISTORY_FILE holds the room\'s last turns as JSON, private to the user, removed after each call', async () => {
    const dir = scratch();
    const cmd = `node -e "const f=process.env.HISTORY_FILE; const fs=require('fs'); process.stdout.write((fs.statSync(f).mode & 0o777).toString(8) + ' ' + fs.readFileSync(f,'utf8'))"`;
    const r = createResponder({ env: { ...process.env, RESPOND_CMD: cmd }, historyTurns: 1, dir }) as Responder;
    expect((await r.respond('one', { room: 'K7QF' })).reply).toBe('600 []');
    expect((await r.respond('two', { room: 'K7QF' })).reply).toBe('600 [{"role":"user","content":"one"},{"role":"assistant","content":"600 []"}]');
    // historyTurns: 1 keeps only the last turn; another room has its own.
    expect(JSON.parse((await r.respond('three', { room: 'K7QF' })).reply.slice(4))).toEqual([
      { role: 'user', content: 'two' },
      { role: 'assistant', content: '600 [{"role":"user","content":"one"},{"role":"assistant","content":"600 []"}]' },
    ]);
    expect((await r.respond('elsewhere', { room: 'ZZZZ' })).reply).toBe('600 []');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a command that fails, prints nothing or is too slow gives the fallback line, ok=false, and the reason for the log', async () => {
    const dir = scratch();
    for (const [cmd, why] of [
      ['false', /exited 1/],
      ['echo "model unavailable" >&2; exit 3', /exited 3: model unavailable/],
      ['true', /printed nothing/],
      ['nonexistent-command-xyz', /exited 127/],
    ] as const) {
      const a = await (createResponder({ env: { ...process.env, RESPOND_CMD: cmd }, dir }) as Responder).respond('hello');
      expect(a, cmd).toMatchObject({ reply: FALLBACK, ok: false, source: 'command' });
      expect(a.error, cmd).toMatch(why);
    }
    // Too slow: cut off at the timeout, and whatever the shell started is stopped too.
    const mark = join(dir, 'late');
    const t0 = Date.now();
    const slow = await (createResponder({ env: { ...process.env, RESPOND_CMD: `sleep 1 && touch ${mark}; echo late` }, timeoutMs: 100, dir: scratch() }) as Responder).respond('hello');
    expect(Date.now() - t0).toBeLessThan(900);
    expect(slow).toMatchObject({ reply: FALLBACK, ok: false, error: expect.stringMatching(/timed out after 100 ms/) });
    await sleep(1300);
    expect(existsSync(mark)).toBe(false);
  });

  it('the reply is cleaned for speech: no terminal colour codes, one line, capped at a word', () => {
    expect(cleanReply('\x1b[1mBold\x1b[0m answer\n\nwith  lines ')).toBe('Bold answer with lines');
    const long = cleanReply('word '.repeat(300), 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('word…')).toBe(true);
  });

  it('runCommand rejects on a non-zero exit with the start of stderr', async () => {
    await expect(runCommand('echo nope >&2; exit 2')).rejects.toThrow(/exited 2: nope/);
    expect(await runCommand('cat', { input: 'echoed' })).toBe('echoed');
  });

  it('L158: a character split across two writes comes back whole, on stdout and stderr, and maxBytes counts bytes', async () => {
    // "é" is \303\251 in UTF-8 and "à" is \303\240: each first write ends inside one, as a streaming model runner's can.
    expect(await runCommand("printf 'Caf\\303'; sleep 0.2; printf '\\251 ouvert.'")).toBe('Café ouvert.');
    await expect(runCommand("printf 'd\\303' >&2; sleep 0.2; printf '\\251j\\303' >&2; sleep 0.2; printf '\\240 vu' >&2; exit 1")).rejects.toThrow(/exited 1: déjà vu$/);
    // Two bytes a character: a 4-byte cap keeps two of them.
    expect(await runCommand("printf 'ééé'", { maxBytes: 4 })).toBe('éé');
  });
});

describe('agents/bedrock.mjs (against a stand-in for the AWS CLI)', () => {
  it('sends the history plus the new words as Converse messages, in files, and prints the model text', async () => {
    const bin = scratch();
    const seen = join(bin, 'seen.json');
    // The stand-in records its arguments and the files they point at, then answers like `aws bedrock-runtime converse`.
    writeFileSync(
      join(bin, 'aws'),
      `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const file = (flag) => JSON.parse(fs.readFileSync(a[a.indexOf(flag) + 1].slice('file://'.length), 'utf8'));
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: a, messages: file('--messages'), system: file('--system'), config: file('--inference-config') }));
process.stdout.write(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'It is sunny today.' }] } }, stopReason: 'end_turn' }));
`,
    );
    chmodSync(join(bin, 'aws'), 0o755);
    const script = fileURLToPath(new URL('../examples/vega-voice-loop/agents/bedrock.mjs', import.meta.url));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AWS_REGION: 'us-west-2' };
    // First prove the command sees the stand-in, not a real AWS CLI.
    expect((await (createResponder({ env: { ...env, RESPOND_CMD: 'command -v aws' } }) as Responder).respond('x')).reply).toBe(join(bin, 'aws'));
    const r = createResponder({ env: { ...env, RESPOND_CMD: `node ${script}` } }) as Responder;
    expect(await r.respond('hello', { room: 'K7QF' })).toEqual({ reply: 'It is sunny today.', ok: true, source: 'command' });
    expect(await r.respond('file:///etc/passwd is what I said', { room: 'K7QF' })).toMatchObject({ reply: 'It is sunny today.' });
    const call = JSON.parse(readFileSync(seen, 'utf8'));
    expect(call.args.slice(0, 6)).toEqual(['bedrock-runtime', 'converse', '--region', 'us-west-2', '--model-id', 'us.amazon.nova-lite-v1:0']);
    expect(call.messages).toEqual([
      { role: 'user', content: [{ text: 'hello' }] },
      { role: 'assistant', content: [{ text: 'It is sunny today.' }] },
      { role: 'user', content: [{ text: 'file:///etc/passwd is what I said' }] },
    ]);
    // The transcript never appears as an argument value the CLI would load.
    expect(call.args.join(' ')).not.toContain('/etc/passwd');
    expect(call.system[0].text).toMatch(/short spoken sentences/);
    expect(call.config.maxTokens).toBe(160);
  });

  it('a CLI failure is a non-zero exit, so the loop says the fallback line', async () => {
    const bin = scratch();
    writeFileSync(join(bin, 'aws'), '#!/bin/sh\necho "Unable to locate credentials" >&2\nexit 255\n');
    chmodSync(join(bin, 'aws'), 0o755);
    const script = fileURLToPath(new URL('../examples/vega-voice-loop/agents/bedrock.mjs', import.meta.url));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    expect((await (createResponder({ env: { ...env, RESPOND_CMD: 'command -v aws' } }) as Responder).respond('x')).reply).toBe(join(bin, 'aws'));
    const a = await (createResponder({ env: { ...env, RESPOND_CMD: `node ${script}` } }) as Responder).respond('hello');
    expect(a).toMatchObject({ reply: FALLBACK, ok: false, error: expect.stringMatching(/Unable to locate credentials/) });
  });
});

describe('the voice loop when the agent fails (RESPOND_CMD=false)', () => {
  it('the TV shows and says the fallback line, the phone sees no error, and the hub log has the reason', async () => {
    const events: Array<Record<string, unknown>> = [];
    const tts = { engine: 'none (test)', clip: async () => null, close: async () => undefined };
    const loop = await startVoiceLoop({ port: 0, host: '127.0.0.1', responder: createResponder({ env: { ...process.env, RESPOND_CMD: 'echo "boom: secret prompt" >&2; false' } }), tts, log: (e: Record<string, unknown>) => events.push(e) });
    open.push(() => loop.close());
    const url = `ws://127.0.0.1:${loop.port}/ws`;
    const tv = new BridgeClient({ url, role: 'screen', reconnect: false });
    open.push(() => tv.close());
    const { code } = await tv.connect();
    const phone = new BridgeClient({ url, role: 'mic', code, reconnect: false });
    open.push(() => phone.close());
    await phone.connect();
    const toPhone: BridgeMessage[] = [];
    phone.on('error', (m) => toPhone.push(m));
    phone.on('intent', (m) => toPhone.push(m));
    const intent = new Promise<IntentMsg>((r) => tv.on('intent', r));
    const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
    phone.sendFinal('what time is it');
    expect(await intent).toMatchObject({ name: 'agent.reply', ok: false, payload: { text: 'what time is it', reply: FALLBACK } });
    expect((await said).text).toBe(FALLBACK);
    await sleep(50);
    expect(toPhone.filter((m) => m.type === 'error')).toEqual([]);
    expect(JSON.stringify(toPhone)).not.toContain('secret prompt');
    expect(events).toContainEqual({ event: 'respond-error', error: expect.stringMatching(/exited 1: boom: secret prompt/) });
    expect(events.find((e) => e.event === 'ready')).toMatchObject({ agent: 'command (echo)', tts: 'none (test)' });
    expect(events.filter((e) => e.event === 'join').map((e) => [e.role, e.origin])).toEqual([
      ['screen', null],
      ['mic', null],
    ]);
  });

  it('a working command answers on the TV', async () => {
    const tts = { engine: 'none (test)', clip: async () => null, close: async () => undefined };
    const loop = await startVoiceLoop({ port: 0, host: '127.0.0.1', responder: createResponder({ env: { ...process.env, RESPOND_CMD: 'printf "The agent heard: %s" "$TEXT"' } }), tts, log: () => undefined });
    open.push(() => loop.close());
    const url = `ws://127.0.0.1:${loop.port}/ws`;
    const tv = new BridgeClient({ url, role: 'screen', reconnect: false });
    open.push(() => tv.close());
    const { code } = await tv.connect();
    const phone = new BridgeClient({ url, role: 'mic', code, reconnect: false });
    open.push(() => phone.close());
    await phone.connect();
    const said = new Promise<Required<SayPayload>>((r) => tv.onSay(r));
    phone.sendFinal('hello');
    expect((await said).text).toBe('The agent heard: hello');
  });
});

describe("the voice loop hub's Origin check, the CLI's", () => {
  const tts = { engine: 'none (test)', clip: async () => null, close: async () => undefined };
  const opened = (port: number, origin?: string) =>
    new Promise<'open' | number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: origin ? { origin } : {} });
      ws.on('open', () => (resolve('open'), ws.terminate()));
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => undefined);
    });

  it('L159: its own pages, the --public-url page and clients with no Origin connect; a page on another site gets 403, logged once', async () => {
    const events: Array<Record<string, unknown>> = [];
    const loop = await startVoiceLoop({ port: 0, host: '127.0.0.1', publicUrl: 'https://tv.example/', responder: createResponder({ env: {} }), tts, log: (e: Record<string, unknown>) => events.push(e) });
    open.push(() => loop.close());
    expect(await opened(loop.port)).toBe('open'); // the Vega app, the scripted phone: no Origin
    expect(await opened(loop.port, `http://127.0.0.1:${loop.port}`)).toBe('open'); // the phone page this hub served
    expect(await opened(loop.port, 'https://tv.example')).toBe('open'); // the same page through the tunnel
    expect(await opened(loop.port, 'https://evil.example')).toBe(403);
    expect(await opened(loop.port, 'https://evil.example')).toBe(403);
    expect(loop.hub.stats.originRefused).toBe(2);
    expect(events.filter((e) => e.event === 'origin-refused')).toEqual([{ event: 'origin-refused', origin: 'https://evil.example' }]);
    expect(events.find((e) => e.event === 'ready')).toMatchObject({ publicUrl: 'https://tv.example', originCheck: 'pages this hub served, and https://tv.example' });
  });

  it('anyOrigin (--any-origin) turns it off', async () => {
    const events: Array<Record<string, unknown>> = [];
    const loop = await startVoiceLoop({ port: 0, host: '127.0.0.1', anyOrigin: true, responder: createResponder({ env: {} }), tts, log: (e: Record<string, unknown>) => events.push(e) });
    open.push(() => loop.close());
    expect(await opened(loop.port, 'https://evil.example')).toBe('open');
    expect(events.find((e) => e.event === 'ready')).toMatchObject({ originCheck: 'off (--any-origin)' });
  });
});

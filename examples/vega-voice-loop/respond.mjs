// What the TV answers: offline rules by default, or your agent as a command (RESPOND_CMD).
//
//   RESPOND_CMD='<any shell command>' node examples/vega-voice-loop/hub.mjs
//
// The command gets the transcript on stdin and in $TEXT, and the room's last turns in $HISTORY_FILE (a JSON array of
// {role: "user" | "assistant", content}), and prints the reply on stdout. It has 8 seconds. If it fails, times out or
// prints nothing, the TV still answers, with "Sorry, I didn't catch that.", and the reason goes to the hub's log,
// never to the phone or the TV. agents/bedrock.mjs is a ready command for Amazon Bedrock (see the README).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FALLBACK = "Sorry, I didn't catch that.";

/** The offline rules: deterministic, no network. */
export function offlineRespond(text) {
  const t = text.toLowerCase();
  if (/\btime\b/.test(t)) return `It is ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
  if (/\b(hello|hi|hey)\b/.test(t)) return 'Hello! I can hear you through your phone.';
  return `You said: ${text}`;
}

/**
 * Run `cmd` with `sh -c`: `input` on stdin, in exactly the environment `env` (default: this process's).
 * Resolves stdout; rejects on a non-zero exit or the timeout.
 */
export function runCommand(cmd, { input = '', env = process.env, timeoutMs = 8000, maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout also stops whatever the shell started (an AWS CLI call, a model runner).
    const child = spawn('sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => finish(() => (killGroup(), reject(new Error(`RESPOND_CMD timed out after ${timeoutMs} ms`)))), timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < maxBytes) out += d;
    });
    child.stderr.on('data', (d) => {
      if (err.length < 2000) err += d;
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code, signal) =>
      finish(() => (code === 0 ? resolve(out) : reject(new Error(`RESPOND_CMD exited ${signal ?? code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''}`)))),
    );
    child.stdin.on('error', () => undefined); // a command that never reads stdin
    child.stdin.end(input);
  });
}

/** A reply fit to be said: no terminal colour codes, one line, at most `max` characters (cut at a word). */
export function cleanReply(out, max = 600) {
  const text = String(out)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * The hub's responder: `respond(text, { room })` resolves `{ reply, ok, source, error? }` and never rejects.
 * `source` is `offline` (no RESPOND_CMD) or `command`; `ok` is false when the command failed and `reply` is the
 * fallback line.
 */
export function createResponder({ env = process.env, timeoutMs = 8000, historyTurns = 6, maxReplyChars = 600, dir = tmpdir(), run = runCommand } = {}) {
  const cmd = env.RESPOND_CMD?.trim();
  const histories = new Map(); // room code -> [{ role, content }], the last historyTurns turns
  return {
    engine: cmd ? `command (${cmd.split(/\s+/)[0]})` : 'offline rules',
    async respond(text, { room = '' } = {}) {
      if (!cmd) return { reply: offlineRespond(text), ok: true, source: 'offline' };
      const history = histories.get(room) ?? [];
      const file = join(dir, `tvb-history-${process.pid}-${randomBytes(6).toString('hex')}.json`);
      try {
        writeFileSync(file, JSON.stringify(history), { mode: 0o600 });
        // The command runs in the environment given here (default: the hub's), never a different one.
        const reply = cleanReply(await run(cmd, { input: text, env: { ...env, TEXT: text, HISTORY_FILE: file }, timeoutMs }), maxReplyChars);
        if (!reply) throw new Error('RESPOND_CMD printed nothing');
        history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
        histories.set(room, history.slice(-2 * historyTurns));
        if (histories.size > 1000) histories.delete(histories.keys().next().value);
        return { reply, ok: true, source: 'command' };
      } catch (err) {
        return { reply: FALLBACK, ok: false, source: 'command', error: String(err?.message ?? err) };
      } finally {
        rmSync(file, { force: true });
      }
    },
  };
}

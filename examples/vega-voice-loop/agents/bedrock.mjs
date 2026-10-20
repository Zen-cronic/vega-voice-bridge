#!/usr/bin/env node
// A RESPOND_CMD for the voice loop: one Amazon Bedrock Converse call per utterance, through the AWS CLI and its
// usual credentials (AWS_PROFILE, or the default chain). No SDK is bundled, and nothing calls a model unless you
// run the hub with this command.
//
//   RESPOND_CMD='node examples/vega-voice-loop/agents/bedrock.mjs' AWS_PROFILE=<your profile> node examples/vega-voice-loop/hub.mjs
//
// Reads the transcript on stdin and the room's last turns from $HISTORY_FILE (both written by the hub), prints the
// reply. BEDROCK_MODEL (default us.amazon.nova-lite-v1:0, a cross-Region inference profile id), AWS_REGION (default
// us-east-1), BEDROCK_MAX_TOKENS (default 160). Each call is billed to your AWS account.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYSTEM = 'You are the voice of a TV app. The user speaks to you through their phone, and the TV says your answer out loud. Answer in one or two short spoken sentences, with no lists, markdown or emoji.';

const text = readFileSync(0, 'utf8').trim();
let history = [];
try {
  history = JSON.parse(readFileSync(process.env.HISTORY_FILE ?? '', 'utf8'));
} catch {
  history = [];
}
// Converse wants turns that alternate, starting with the user, each content a list of text blocks.
const messages = [...history, { role: 'user', content: text }]
  .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
  .map((m) => ({ role: m.role, content: [{ text: m.content }] }));
while (messages.length && messages[0].role !== 'user') messages.shift();

// The request goes to the CLI in files (file://), never as argument values, so a transcript that happens to
// start with file:// or a URL is sent as text.
const dir = mkdtempSync(join(tmpdir(), 'tvb-bedrock-'));
try {
  writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages), { mode: 0o600 });
  writeFileSync(join(dir, 'system.json'), JSON.stringify([{ text: SYSTEM }]), { mode: 0o600 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxTokens: Number(process.env.BEDROCK_MAX_TOKENS) || 160, temperature: 0.5 }), { mode: 0o600 });
  const args = [
    'bedrock-runtime', 'converse',
    '--region', process.env.AWS_REGION || 'us-east-1',
    '--model-id', process.env.BEDROCK_MODEL || 'us.amazon.nova-lite-v1:0',
    '--messages', `file://${join(dir, 'messages.json')}`,
    '--system', `file://${join(dir, 'system.json')}`,
    '--inference-config', `file://${join(dir, 'config.json')}`,
    '--output', 'json',
  ];
  const out = await new Promise((resolve, reject) =>
    execFile('aws', args, { env: { ...process.env, AWS_CLI_FILE_ENCODING: 'UTF-8' }, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`aws: ${(stderr || err.message).trim()}`)) : resolve(stdout),
    ),
  );
  const reply = (JSON.parse(out).output?.message?.content ?? []).map((c) => c.text ?? '').join(' ').trim();
  if (!reply) throw new Error('Bedrock returned no text');
  process.stdout.write(reply);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

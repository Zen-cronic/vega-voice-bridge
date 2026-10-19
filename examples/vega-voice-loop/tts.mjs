// Local text-to-speech for the voice loop, as clips a Vega screen can play from a plain-http hub:
// fragmented MP4 with AAC (Vega's MSE demuxes it; raw MP3 never starts) plus an MP3 for browsers.
//   engine: macOS `say` (the system voices), Linux `espeak`, TTS_CMD (any command that writes a WAV to $OUT
//   from the text in $TEXT), or TTS_ENGINE=polly (Amazon Polly through the AWS CLI, using its usual credentials:
//   POLLY_VOICE, default Ruth; POLLY_ENGINE, default generative; AWS_REGION, default us-east-1).
//   ffmpeg does the encoding.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const exec = (cmd, args, env) => new Promise((resolve, reject) => execFile(cmd, args, { env: { ...process.env, ...env } }, (err, _o, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`.trim())) : resolve())));

export function ttsEngine(env = process.env, { run = exec, os = platform() } = {}) {
  if (env.TTS_CMD) return { name: 'custom', render: (text, base) => run('sh', ['-c', env.TTS_CMD], { TEXT: text, OUT: `${base}.wav` }).then(() => `${base}.wav`) };
  if (env.TTS_ENGINE === 'polly') {
    const voice = env.POLLY_VOICE || 'Ruth';
    const engine = env.POLLY_ENGINE || 'generative';
    const region = env.AWS_REGION || 'us-east-1';
    return {
      name: `polly (${engine} ${voice})`,
      // The text goes to the AWS CLI in a file (--text file://<path>), never as the value itself: the CLI reads a
      // value that starts with file:// or fileb:// (and, in v1, fetches http(s)://) instead of using it, so a reply
      // that began with one would be replaced by that file. A file's contents are used as they are.
      render: async (text, base) => {
        const input = `${base}.polly.txt`;
        writeFileSync(input, text, { encoding: 'utf8', mode: 0o600 });
        try {
          await run('aws', ['polly', 'synthesize-speech', '--region', region, '--engine', engine, '--voice-id', voice, '--output-format', 'mp3', '--sample-rate', '24000', '--text', `file://${input}`, `${base}.polly.mp3`], { AWS_CLI_FILE_ENCODING: 'UTF-8' });
        } finally {
          rmSync(input, { force: true });
        }
        return `${base}.polly.mp3`;
      },
    };
  }
  if (os === 'darwin') {
    const voice = env.TTS_VOICE ? ['-v', env.TTS_VOICE] : [];
    return { name: `say${env.TTS_VOICE ? ` (${env.TTS_VOICE})` : ''}`, render: (text, base) => run('say', [...voice, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', `${base}.wav`, text]).then(() => `${base}.wav`) };
  }
  return { name: 'espeak', render: (text, base) => run('espeak', ['-s', '165', '-w', `${base}.wav`, text]).then(() => `${base}.wav`) };
}

/**
 * Make (or reuse) the clips for `text`; returns the file id. Two requests for the same clip while it renders share
 * one render (two phones in a room, or the same reply twice), and each render works in files of its own, so one
 * finishing never removes what another is still reading.
 */
export function createTts({ dir, engine = ttsEngine(), run = exec } = {}) {
  mkdirSync(dir, { recursive: true });
  const inFlight = new Map();
  let seq = 0;
  const make = async (id, text) => {
    const base = join(dir, id);
    if (existsSync(`${base}.m4a`)) return { id, cached: true };
    const work = join(dir, `${id}.${process.pid}-${++seq}`);
    let src;
    try {
      src = await engine.render(text, work);
      await run('ffmpeg', ['-loglevel', 'error', '-i', src, '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', '-y', `${base}.m4a`]);
      await run('ffmpeg', ['-loglevel', 'error', '-i', src, '-codec:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-y', `${base}.mp3`]);
    } finally {
      if (src) rmSync(src, { force: true });
    }
    return { id, cached: false };
  };
  return {
    engine: engine.name,
    clip(text) {
      const id = createHash('sha256').update(`${engine.name}\n${text}`).digest('hex').slice(0, 16);
      const pending = inFlight.get(id);
      if (pending) return pending;
      const p = make(id, text).finally(() => inFlight.delete(id));
      inFlight.set(id, p);
      return p;
    },
  };
}

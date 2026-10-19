// Local text-to-speech for the voice loop, as clips a Vega screen can play from a plain-http hub:
// fragmented MP4 with AAC (Vega's MSE demuxes it; raw MP3 never starts) plus an MP3 for browsers.
//   engine: macOS `say` (the system voices), Linux `espeak`, or TTS_CMD (any command that writes a WAV to $OUT
//   from the text in $TEXT). ffmpeg does the encoding.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args, env) => new Promise((resolve, reject) => execFile(cmd, args, { env: { ...process.env, ...env } }, (err, _o, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`.trim())) : resolve())));

export function ttsEngine(env = process.env) {
  if (env.TTS_CMD) return { name: 'custom', wav: (text, out) => run('sh', ['-c', env.TTS_CMD], { TEXT: text, OUT: out }) };
  if (platform() === 'darwin') {
    const voice = env.TTS_VOICE ? ['-v', env.TTS_VOICE] : [];
    return { name: `say${env.TTS_VOICE ? ` (${env.TTS_VOICE})` : ''}`, wav: (text, out) => run('say', [...voice, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, text]) };
  }
  return { name: 'espeak', wav: (text, out) => run('espeak', ['-s', '165', '-w', out, text]) };
}

/** Make (or reuse) the clips for `text`; returns the file id. */
export function createTts({ dir, engine = ttsEngine() } = {}) {
  mkdirSync(dir, { recursive: true });
  return {
    engine: engine.name,
    async clip(text) {
      const id = createHash('sha256').update(`${engine.name}\n${text}`).digest('hex').slice(0, 16);
      const base = join(dir, id);
      if (existsSync(`${base}.m4a`)) return { id, cached: true };
      await engine.wav(text, `${base}.wav`);
      await run('ffmpeg', ['-loglevel', 'error', '-i', `${base}.wav`, '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', '-y', `${base}.m4a`]);
      await run('ffmpeg', ['-loglevel', 'error', '-i', `${base}.wav`, '-codec:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-y', `${base}.mp3`]);
      rmSync(`${base}.wav`, { force: true });
      return { id, cached: false };
    },
  };
}

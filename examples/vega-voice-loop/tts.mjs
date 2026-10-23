// Local text-to-speech for the voice loop, as clips a Vega screen can play from a plain-http hub:
// fragmented MP4 with AAC (Vega's MSE demuxes it; raw MP3 never starts) plus an MP3 for browsers.
//   engine: macOS `say` (the system voices), Linux `espeak`, TTS_CMD (any command that writes a WAV to $OUT
//   from the text in $TEXT), or TTS_ENGINE=polly (Amazon Polly through the AWS CLI, using its usual credentials:
//   POLLY_VOICE, default Ruth; POLLY_ENGINE, default generative; AWS_REGION, default us-east-1).
//   ffmpeg does the encoding.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

// `signal` (an AbortSignal) stops the command: createTts's close() uses it when the hub shuts down.
const exec = (cmd, args, env, { signal } = {}) => new Promise((resolve, reject) => execFile(cmd, args, { env: { ...process.env, ...env }, signal }, (err, _o, stderr) => (err ? reject(new Error(`${cmd}: ${stderr || err.message}`.trim())) : resolve())));

// The reply is the agent's text, so it must never be read as an option: a reply of "-f<path>" would make the
// engine read that file aloud. espeak takes "--"; for say, a leading space keeps the text a plain argument.
const asText = (text) => (text.startsWith('-') ? ` ${text}` : text);

export function ttsEngine(env = process.env, { run = exec, os = platform() } = {}) {
  // Each engine lists the files a render may leave at `base` (outputs), so a failed render's files are removed by
  // name, without listing the cache.
  const wav = (base) => [`${base}.wav`];
  if (env.TTS_CMD) return { name: 'custom', outputs: wav, render: (text, base, o) => run('sh', ['-c', env.TTS_CMD], { TEXT: text, OUT: `${base}.wav` }, o).then(() => `${base}.wav`) };
  if (env.TTS_ENGINE === 'polly') {
    const voice = env.POLLY_VOICE || 'Ruth';
    const engine = env.POLLY_ENGINE || 'generative';
    const region = env.AWS_REGION || 'us-east-1';
    return {
      name: `polly (${engine} ${voice})`,
      outputs: (base) => [`${base}.polly.mp3`, `${base}.polly.txt`],
      // The text goes to the AWS CLI in a file (--text file://<path>), never as the value itself: the CLI reads a
      // value that starts with file:// or fileb:// (and, in v1, fetches http(s)://) instead of using it, so a reply
      // that began with one would be replaced by that file. A file's contents are used as they are.
      render: async (text, base, o) => {
        const input = `${base}.polly.txt`;
        writeFileSync(input, text, { encoding: 'utf8', mode: 0o600 });
        try {
          await run('aws', ['polly', 'synthesize-speech', '--region', region, '--engine', engine, '--voice-id', voice, '--output-format', 'mp3', '--sample-rate', '24000', '--text', `file://${input}`, `${base}.polly.mp3`], { AWS_CLI_FILE_ENCODING: 'UTF-8' }, o);
        } finally {
          rmSync(input, { force: true });
        }
        return `${base}.polly.mp3`;
      },
    };
  }
  if (os === 'darwin') {
    const voice = env.TTS_VOICE ? ['-v', env.TTS_VOICE] : [];
    return { name: `say${env.TTS_VOICE ? ` (${env.TTS_VOICE})` : ''}`, outputs: wav, render: (text, base, o) => run('say', [...voice, '--file-format=WAVE', '--data-format=LEI16@22050', '-o', `${base}.wav`, asText(text)], undefined, o).then(() => `${base}.wav`) };
  }
  return { name: 'espeak', outputs: wav, render: (text, base, o) => run('espeak', ['-s', '165', '-w', `${base}.wav`, '--', text], undefined, o).then(() => `${base}.wav`) };
}

// Work files are named `<clip id>.<pid>-<instance token>-<n>.<ext>`, so two instances (in one process or two)
// never share one. 0.3.4 named them `<clip id>.<pid>-<n>.<ext>`.
const WORK_RE = /^[0-9a-f]{16}\.(\d+)-(?:([0-9a-f]{8})-)?\d+\./;
const liveTokens = new Set(); // the instances made in this process
let renders = 0; // across instances, so a work name is never reused in this process

const alive = (pid) => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const remove = (f) => {
  try {
    rmSync(f, { force: true });
  } catch {
    // Cleanup never replaces the render's own result or error.
  }
};

/** Remove the work files a killed process left in `dir` (any file of a process that is gone, or of an instance this process no longer has). */
export function sweepWorkFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of names) {
    const m = WORK_RE.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    const stale = pid === process.pid ? !m[2] || !liveTokens.has(m[2]) : !alive(pid);
    if (!stale) continue;
    remove(join(dir, f));
    n++;
  }
  return n;
}

// A clip is served from the cache only when its marker matches both files: written after both were moved into
// place, it holds their sizes. A clip from before 0.3.5 (no marker), or one cut short later, is rendered again.
const isCached = (base) => {
  try {
    const ok = JSON.parse(readFileSync(`${base}.ok`, 'utf8'));
    const m4a = statSync(`${base}.m4a`).size;
    const mp3 = statSync(`${base}.mp3`).size;
    return m4a > 0 && mp3 > 0 && ok.m4a === m4a && ok.mp3 === mp3;
  } catch {
    return false;
  }
};

/**
 * Make (or reuse) the clips for `text`; returns the file id. Two requests for the same clip while it renders share
 * one render (two phones in a room, or the same reply twice), and each render works in files of its own, so one
 * finishing never removes what another is still reading, even across instances. Both clips are encoded into work
 * files and moved into place only when both succeeded, so an encode that fails or is killed partway never leaves a
 * partial clip to be served from the cache; a render removes its own leftovers (its WAV or Polly files, a
 * half-written clip) by name. Work files a killed process left are swept when an instance starts. close() stops
 * the renders in flight and removes their files: the example hub calls it on SIGINT and SIGTERM.
 */
export function createTts({ dir, engine = ttsEngine(), run = exec } = {}) {
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(4).toString('hex');
  liveTokens.add(token);
  sweepWorkFiles(dir);
  const inFlight = new Map();
  const working = new Set(); // this instance's work bases still in use
  const abort = new AbortController();
  const ownFiles = (work) => [`${work}.m4a`, `${work}.mp3`, `${work}.ok`, ...(engine.outputs ? engine.outputs(work) : [`${work}.wav`])];
  const make = async (id, text) => {
    const base = join(dir, id);
    if (isCached(base)) return { id, cached: true };
    if (abort.signal.aborted) throw new Error('tts: closed');
    const work = join(dir, `${id}.${process.pid}-${token}-${++renders}`);
    working.add(work);
    const o = { signal: abort.signal };
    let src;
    try {
      src = await engine.render(text, work, o);
      await run('ffmpeg', ['-loglevel', 'error', '-i', src, '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', '-y', `${work}.m4a`], undefined, o);
      await run('ffmpeg', ['-loglevel', 'error', '-i', src, '-codec:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-f', 'mp3', '-y', `${work}.mp3`], undefined, o);
      const sizes = { m4a: statSync(`${work}.m4a`).size, mp3: statSync(`${work}.mp3`).size };
      if (!sizes.m4a || !sizes.mp3) throw new Error('ffmpeg: wrote an empty clip');
      writeFileSync(`${work}.ok`, JSON.stringify(sizes));
      remove(`${base}.ok`);
      renameSync(`${work}.mp3`, `${base}.mp3`);
      renameSync(`${work}.m4a`, `${base}.m4a`);
      renameSync(`${work}.ok`, `${base}.ok`); // last: until it is there, the clip is not cached
    } finally {
      for (const f of new Set([...ownFiles(work), ...(src ? [src] : [])])) remove(f);
      working.delete(work);
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
    /** Stop the renders in flight (their commands get the abort signal), wait up to `waitMs` for them, and remove their files. */
    async close({ waitMs = 2000 } = {}) {
      abort.abort();
      let timer;
      await Promise.race([Promise.allSettled([...inFlight.values()]), new Promise((res) => (timer = setTimeout(res, waitMs)))]);
      clearTimeout(timer);
      for (const work of working) for (const f of ownFiles(work)) remove(f);
      liveTokens.delete(token);
    },
  };
}

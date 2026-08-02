// whisper.cpp engine: an optional accelerator for local ASR.
//
// The bundled transformers.js path needs no install and downloads its own model,
// so it stays the fallback and nothing breaks without this. But when a whisper.cpp
// build is present it is better on every axis that matters here: it runs on the GPU
// (CUDA/Vulkan builds), it can load large-v3 rather than small, and it ships Silero
// VAD — real voice-activity detection, which is the actual fix for the hallucination
// loops and non-speech garbage that plague long recordings with music under speech.
//
// Measured on 60s of gameplay audio (ground truth 132 words):
//   transformers.js small + denoise → 33 words, 0.5x realtime
//   whisper.cpp large-v3-turbo + VAD → 69 words, ~35x realtime
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getKey } from '../keystore.ts';
import { srtToTranscript } from '../../src/transcript/srt.ts';
import { IMPOSSIBLE_REPEATS_PER_SECOND, collapseRepeats, findRepeatRuns, normalize, type RepeatRun } from '../../src/transcript/repeats.ts';
import type { TranscriptResult, TranscriptWord } from '../../src/transcript/types.ts';

const DEFAULT_ROOT = join(homedir(), 'whisper.cpp');

export interface CppPaths {
  root: string;
  bin: string;
  model: string;
  vadModel: string;
}

/** Configured paths, else the conventional ~/whisper.cpp layout. */
export function cppPaths(): CppPaths {
  const root = getKey('WHISPER_CPP_DIR') || DEFAULT_ROOT;
  const model = getKey('WHISPER_CPP_MODEL') || join(root, 'models', 'ggml-large-v3-turbo.bin');
  const vad = getKey('WHISPER_CPP_VAD_MODEL') || join(root, 'models', 'ggml-silero-v6.2.0.bin');
  const bin = getKey('WHISPER_CPP_BIN')
    || join(root, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  return { root, bin, model, vadModel: vad };
}

export interface CppStatus extends CppPaths {
  binPresent: boolean;
  modelPresent: boolean;
  vadPresent: boolean;
  /** Usable for transcription (VAD is optional but strongly recommended). */
  ready: boolean;
  /** True when GPU offload libraries sit next to the binary. */
  gpu: boolean;
}

export function cppStatus(): CppStatus {
  const paths = cppPaths();
  const binPresent = existsSync(paths.bin);
  const modelPresent = existsSync(paths.model);
  const vadPresent = existsSync(paths.vadModel);
  // A CUDA build ships ggml-cuda next to the binary; Vulkan builds ship ggml-vulkan.
  const gpu = binPresent && ['ggml-cuda.dll', 'libggml-cuda.so', 'ggml-vulkan.dll', 'libggml-vulkan.so']
    .some((lib) => existsSync(join(paths.root, lib)));
  return { ...paths, binPresent, modelPresent, vadPresent, ready: binPresent && modelPresent, gpu };
}

// ── Setup ────────────────────────────────────────────────────────────────────
// Models come from the official ggml-org HuggingFace repo. The BINARY is not
// auto-downloaded: which build is correct depends on the machine's GPU and driver
// (CUDA vs Vulkan vs CPU-only), picking wrong silently falls back to slow CPU or
// fails to load, and fetching+running an executable on the user's behalf is a
// bigger step than fetching model weights. So models are one click, and the
// binary is a guided step the user completes.
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export interface DownloadableModel {
  id: string;
  file: string;
  url: string;
  approxBytes: number;
  label: string;
}

export const MODELS: readonly DownloadableModel[] = [
  {
    id: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    url: `${MODEL_BASE}/ggml-large-v3-turbo.bin`,
    approxBytes: 1_624_555_275,
    label: 'large-v3-turbo — best accuracy per second (recommended)',
  },
  {
    id: 'large-v3',
    file: 'ggml-large-v3.bin',
    url: `${MODEL_BASE}/ggml-large-v3.bin`,
    approxBytes: 3_095_033_483,
    label: 'large-v3 — most accurate, roughly 2x slower than turbo',
  },
  {
    id: 'medium',
    file: 'ggml-medium.bin',
    url: `${MODEL_BASE}/ggml-medium.bin`,
    approxBytes: 1_533_763_059,
    label: 'medium — smaller, noticeably weaker on noisy audio',
  },
];

/** Silero VAD. Small, and the single biggest quality win on long recordings. */
export const VAD_MODEL: DownloadableModel = {
  id: 'silero-vad',
  file: 'ggml-silero-v5.1.2.bin',
  url: `${MODEL_BASE}/ggml-silero-v5.1.2.bin`,
  approxBytes: 885_098,
  label: 'Silero VAD — skips non-speech (strongly recommended)',
};

export interface DownloadProgress {
  active: boolean;
  file: string;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  error: string | null;
  done: boolean;
}

let download: DownloadProgress = {
  active: false, file: '', receivedBytes: 0, totalBytes: 0, percent: 0, error: null, done: false,
};

export function downloadProgress(): DownloadProgress {
  return download;
}

/** Stream a model to disk via a .part file, renamed only on success. */
export async function downloadModel(model: DownloadableModel, targetDir: string): Promise<void> {
  if (download.active) throw new Error('a download is already running');
  const { mkdir, rename, unlink } = await import('node:fs/promises');
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');

  await mkdir(targetDir, { recursive: true });
  const finalPath = join(targetDir, model.file);
  const partPath = `${finalPath}.part`;

  download = {
    active: true, file: model.file, receivedBytes: 0,
    totalBytes: model.approxBytes, percent: 0, error: null, done: false,
  };
  try {
    const res = await fetch(model.url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${model.url}`);
    const total = Number(res.headers.get('content-length')) || model.approxBytes;
    download = { ...download, totalBytes: total };

    let received = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        received += chunk.length;
        download = {
          ...download,
          receivedBytes: received,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        };
        controller.enqueue(chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body.pipeThrough(counter) as never),
      createWriteStream(partPath),
    );
    await rename(partPath, finalPath);
    download = { ...download, active: false, done: true, percent: 100 };
  } catch (err) {
    await unlink(partPath).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    download = { ...download, active: false, error: message, done: false };
    throw err;
  }
}

/** Characters per subtitle segment. 0 disables the cap (whisper's own
 * sentence-length segments). Default follows the value that works well for
 * on-screen subtitle lines. */
function maxLenChars(): number {
  const raw = getKey('WHISPER_CPP_MAX_LEN');
  if (raw === '') return DEFAULT_MAX_LEN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_LEN;
}

const DEFAULT_MAX_LEN = 18;

export interface CppRunOptions {
  language: string;
  threads?: number;
  /** Called with the furthest audio-second whisper.cpp has emitted so far. */
  onProgress?: (doneSec: number) => void;
  /** Diagnostics worth logging (e.g. how many repeat runs were repaired). */
  onNote?: (note: string) => void;
}

/** whisper-cli loads its ggml/CUDA backends as DLLs. Spawned from the dev server
 * it inherits a PATH that may contain a DIFFERENT CUDA runtime, and loading a
 * mismatched cudart/cublas ahead of the ones shipped beside the binary crashes
 * ggml (exit 0xC0000409) — while the same command run from a shell in that
 * directory succeeds. Put the install root first so its own DLLs always win. */
function childEnv(status: CppStatus): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':';
  const key = process.platform === 'win32' ? 'Path' : 'LD_LIBRARY_PATH';
  const current = process.env[key] ?? process.env.PATH ?? '';
  return { ...process.env, [key]: `${status.root}${sep}${current}` };
}

/** Bounded so a pathological file cannot turn into hundreds of extra passes.
 * Windows are 1-3s and whisper.cpp runs ~23x realtime, so this is cheap. */
const MAX_REPAIR_WINDOWS = 48;
/** Attempts per window before concluding the repetition is genuine. Retries
 * raise the temperature, since an identical re-run is deterministic and would
 * just reproduce the same output. */
const REPAIR_TEMPERATURES = [0, 0.2, 0.4, 0.6];
/** Context around the run; the decoder needs a run-up to latch on. */
const REPAIR_PAD_SEC = 2;

/**
 * Re-transcribe one window up to REPAIR_TEMPERATURES.length times, looking for a
 * pass that does NOT reproduce the repetition.
 *
 * Returns the corrected words, or null when every attempt still repeats — which
 * is the useful answer too: the repetition is really in the audio, so the caller
 * keeps the original rather than deleting speech that was actually said.
 */
async function repairWindow(
  status: CppStatus,
  wavPath: string,
  dir: string,
  fromSec: number,
  toSec: number,
  language: string,
  run: RepeatRun,
): Promise<TranscriptWord[] | null> {
  const target = normalize(run.text);
  for (let attempt = 0; attempt < REPAIR_TEMPERATURES.length; attempt++) {
    try {
      const words = await transcribeWindow(
        status, wavPath, dir, fromSec, toSec, language,
        REPEAT_TEMP(attempt), attempt,
      );
      if (!words.length) continue;
      // Accept a rewrite only if it is strictly cleaner. Checking just the target
      // word is not enough: a higher temperature can drop THIS stutter while
      // hallucinating a different one, which is how repairs were importing new
      // runs ("No," 12x) that the original pass never produced.
      const fresh = findRepeatRuns(words);
      const stillRepeats = fresh.some((r) => normalize(r.text) === target);
      if (!stillRepeats && fresh.length === 0) return words;
    } catch {
      // Treat a failed attempt as inconclusive and try the next temperature.
    }
  }
  return null;
}

const REPEAT_TEMP = (attempt: number): number =>
  REPAIR_TEMPERATURES[Math.min(attempt, REPAIR_TEMPERATURES.length - 1)];

/** Re-transcribe one window of the already-decoded WAV, returned on the
 * ORIGINAL timeline (whisper reports from zero within the cut). */
async function transcribeWindow(
  status: CppStatus,
  wavPath: string,
  dir: string,
  fromSec: number,
  toSec: number,
  language: string,
  temperature: number,
  attempt: number,
): Promise<TranscriptWord[]> {
  const cut = join(dir, `repair-${Math.round(fromSec)}-${attempt}.wav`);
  const base = join(dir, `repair-${Math.round(fromSec)}-${attempt}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-ss', String(fromSec), '-t', String(Math.max(1, toSec - fromSec)),
      '-i', wavPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', cut,
    ], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg cut exit ${code}`))));
  });

  const args = ['-m', status.model, '-f', cut, '-of', base, '-osrt',
    '-l', language || 'auto', '-t', '8',
    '--entropy-thold', '2.4', '--logprob-thold', '-1.0',
    // A deterministic re-run reproduces the same stutter, so each retry warms up.
    '-tp', String(temperature)];
  const repairMaxLen = maxLenChars();
  if (repairMaxLen > 0) args.push('--max-len', String(repairMaxLen), '--split-on-word');
  if (status.vadPresent) args.push('--vad', '--vad-model', status.vadModel);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(status.bin, args, { cwd: status.root, stdio: 'ignore', env: childEnv(status) });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper-cli exit ${code}`))));
  });

  const offset = fromSec * 1000;
  const { words } = srtToTranscript(await readFile(`${base}.srt`, 'utf8'));
  return words.map((w) => ({
    ...w, start: Math.round(w.start + offset), end: Math.round(w.end + offset),
  }));
}

/** Replace every word inside [fromMs, toMs) with `replacement`, keeping order. */
function spliceWindow(
  words: readonly TranscriptWord[],
  fromMs: number,
  toMs: number,
  replacement: readonly TranscriptWord[],
): TranscriptWord[] {
  const before = words.filter((w) => w.end <= fromMs);
  const after = words.filter((w) => w.start >= toMs);
  return [...before, ...replacement, ...after];
}

function decodeToWav(inputPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-y', wavPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg decode exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** `[00:00:30.230 --> 00:00:32.110]` on stderr as each segment lands. */
const SEGMENT_LINE = /\[\d\d:(\d\d):(\d\d)\.(\d{3})\s*-->\s*\d\d:(\d\d):(\d\d)\.(\d{3})\]/g;

export async function transcribeWithCpp(
  audioPath: string,
  opts: CppRunOptions,
): Promise<TranscriptResult> {
  const status = cppStatus();
  if (!status.ready) throw new Error('whisper.cpp is not installed or its model is missing');

  const dir = await mkdtemp(join(tmpdir(), 'occ-whisper-'));
  const outBase = join(dir, 'out');
  try {
    // whisper-cli reads 16k mono PCM WAV, not containers — handed an .mp4 it
    // writes no output at all. Decode first (~110MB for an hour, temp only).
    const wavPath = join(dir, 'in.wav');
    await decodeToWav(audioPath, wavPath);

    const args = [
      '-m', status.model,
      '-f', wavPath,
      '-of', outBase,
      '-osrt',
      // 'auto' lets whisper.cpp detect; an explicit code is far more reliable.
      '-l', opts.language || 'auto',
      '-t', String(opts.threads && opts.threads > 0 ? opts.threads : 8),
      // Same thresholds as a known-good local pipeline: they suppress the
      // low-confidence runs that turn into repetition loops.
      '--entropy-thold', '2.4',
      '--logprob-thold', '-1.0',
    ];
    // --max-len caps CHARACTERS per segment, so whisper.cpp splits at the source
    // and every short line carries its own model timing. Doing this in the UI
    // instead would only reflow display text over one long interpolated cue.
    const maxLen = maxLenChars();
    // --split-on-word: without it the cap lands on TOKEN boundaries and cuts
    // words in half ("kembali" -> "kemb" / "ali").
    if (maxLen > 0) args.push('--max-len', String(maxLen), '--split-on-word');
    if (status.vadPresent) args.push('--vad', '--vad-model', status.vadModel);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(status.bin, args, { cwd: status.root, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(status) });
      let stderr = '';
      const scan = (text: string): void => {
        if (!opts.onProgress) return;
        for (const m of text.matchAll(SEGMENT_LINE)) {
          const endSec = Number(m[4]) * 60 + Number(m[5]) + Number(m[6]) / 1000;
          opts.onProgress(endSec);
        }
      };
      // Progress lines arrive on stderr on some builds and stdout on others.
      child.stdout?.on('data', (c: Buffer) => scan(String(c)));
      child.stderr?.on('data', (c: Buffer) => { const s = String(c); stderr += s; scan(s); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`whisper-cli exit ${code}: ${stderr.slice(-400)}`));
      });
    });

    const srt = await readFile(`${outBase}.srt`, 'utf8');
    // Reuse the subtitle importer: whisper.cpp gives cue-level timings, and
    // srtToTranscript already divides a cue across its words by length.
    const result = srtToTranscript(srt);
    if (!result.words.length) throw new Error('whisper.cpp produced no usable segments');

    // Repeat runs ("Kayu Kayu Kayu Kayu") are usually a decode artifact, but not
    // always — people really do repeat themselves. Rather than guess from the
    // rate alone, VERIFY: re-transcribe just that window in isolation, where the
    // decoder starts fresh. If the repetition survives an independent pass it is
    // in the audio, so it is kept. Only a pass that disagrees replaces anything.
    let words = [...result.words];
    const runs = findRepeatRuns(words);
    let repaired = 0;
    let confirmed = 0;
    let forced = 0;
    for (const run of runs.slice(0, MAX_REPAIR_WINDOWS)) {
      const from = Math.max(0, run.startMs / 1000 - REPAIR_PAD_SEC);
      const to = run.endMs / 1000 + REPAIR_PAD_SEC;
      const fixed = await repairWindow(status, wavPath, dir, from, to, opts.language, run);
      if (fixed) {
        words = spliceWindow(words, from * 1000, to * 1000, fixed);
        repaired += 1;
      } else if (run.rate >= IMPOSSIBLE_REPEATS_PER_SECOND) {
        // Every attempt agreed — but at this rate the word cannot be spoken, so
        // the agreement is the same failure recurring, not evidence. Collapse.
        words = collapseRepeats(words, { maxRepeatsPerSecond: IMPOSSIBLE_REPEATS_PER_SECOND }).words;
        forced += 1;
      } else {
        confirmed += 1;
      }
    }
    if (runs.length) {
      opts.onNote?.(`repeat runs: ${runs.length}, rewritten ${repaired}, collapsed as impossible ${forced}, confirmed real ${confirmed}`);
    }

    return { ...result, words, text: words.map((w) => w.text).join(' ') };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

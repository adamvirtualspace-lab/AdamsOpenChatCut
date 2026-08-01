import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { getKey } from '../keystore.ts';
import { resolveUploadFile, uploadDir } from '../media-dir.ts';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const MODEL_MAP: Record<string, string> = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
  medium: 'Xenova/whisper-medium',
  large: 'Xenova/whisper-large-v3',
};

let whisperModel: any = null;
let loadedModelId = '';
let modelLoadPromise: Promise<any> | null = null;
let modelError: string | null = null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function resolveModelId(): string {
  const raw = getKey('WHISPER_MODEL') || 'tiny';
  return MODEL_MAP[raw] || MODEL_MAP.tiny;
}

async function loadModel(): Promise<any> {
  const modelId = resolveModelId();
  if (whisperModel && loadedModelId === modelId) return whisperModel;
  if (modelLoadPromise) {
    const m = await modelLoadPromise;
    if (loadedModelId === modelId) return m;
  }
  modelLoadPromise = (async () => {
    modelError = null;
    const id = resolveModelId();
    try {
      const mod = await import('@huggingface/transformers');
      whisperModel = await mod.pipeline('automatic-speech-recognition', id);
      loadedModelId = id;
      return whisperModel;
    } catch (err) {
      modelError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  })();
  return modelLoadPromise;
}

// Speech band + spectral denoise, mirroring the isolate-voice chain. Game audio,
// music and room noise are what push Whisper into repetition loops; band-limiting
// to speech measurably recovers more words on noisy source (77 → 107 on a 60s
// gameplay sample). Opt-in, because on clean studio audio denoising can cost
// accuracy rather than add it.
const DENOISE_FILTER = 'highpass=f=80,lowpass=f=8000,afftdn=nr=12:nf=-25:tn=1';

function denoiseEnabled(): boolean {
  return getKey('WHISPER_DENOISE') === '1';
}

function decodeAudio(inputPath: string, filter: string | null): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      ...(filter ? ['-af', filter] : []),
      '-f', 's16le',
      '-ac', '1',
      '-ar', '16000',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode exit ${code}: ${stderr.slice(-300)}`));
        return;
      }
      const raw = Buffer.concat(chunks);
      const samples = new Float32Array(raw.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = raw.readInt16LE(i * 2) / 32768;
      }
      resolve(samples);
    });
  });
}

// Transcription is one long blocking POST, so progress is published here and
// polled separately. Only one run happens at a time (the model is a singleton),
// so a single record is enough.
interface WhisperProgress {
  active: boolean;
  file: string;
  /** Audio length in seconds, known once ffmpeg has decoded it. */
  totalSec: number;
  /** Audio seconds whose chunk has come back from the model. */
  doneSec: number;
  startedAt: number;
  phase: 'decoding' | 'loading-model' | 'transcribing' | 'done' | 'error';
}

const NO_PROGRESS: WhisperProgress = {
  active: false, file: '', totalSec: 0, doneSec: 0, startedAt: 0, phase: 'done',
};
let progress: WhisperProgress = { ...NO_PROGRESS };
/** Audio seconds each model.generate() call advances, for the run in flight. */
let stepSecForRun = 0;

/** transformers.js exposes no per-chunk hook for a long ASR call — its chunk
 * loop just calls model.generate() once per window. Counting those calls is the
 * only way to report real progress, so wrap generate once per loaded model.
 * Progress-only: the return value is passed straight through. */
function instrumentChunkProgress(pipe: any): void {
  const model = pipe?.model;
  if (!model || model.__ccProgressWrapped) return;
  const original = model.generate.bind(model);
  model.generate = async (...args: unknown[]) => {
    const out = await original(...args);
    if (progress.active && stepSecForRun > 0) {
      progress = {
        ...progress,
        doneSec: Math.min(progress.totalSec, progress.doneSec + stepSecForRun),
      };
    }
    return out;
  };
  model.__ccProgressWrapped = true;
}

function progressReport(): Record<string, unknown> {
  const { active, file, totalSec, doneSec, startedAt, phase } = progress;
  const elapsedSec = startedAt ? (Date.now() - startedAt) / 1000 : 0;
  // Rate is audio-seconds per wall-second; only meaningful once work has landed.
  const rate = doneSec > 0 && elapsedSec > 0 ? doneSec / elapsedSec : 0;
  const remainingSec = rate > 0 ? Math.max(0, (totalSec - doneSec) / rate) : null;
  return {
    active,
    file,
    phase,
    totalSec: Math.round(totalSec),
    doneSec: Math.round(doneSec),
    percent: totalSec > 0 ? Math.min(100, Math.round((doneSec / totalSec) * 100)) : 0,
    elapsedSec: Math.round(elapsedSec),
    etaSec: remainingSec === null ? null : Math.round(remainingSec),
    speed: rate ? Number(rate.toFixed(2)) : null,
  };
}

export function whisperPlugin(): Plugin {
  return {
    name: 'openchatcut-whisper',
    configureServer(server) {
      server.middlewares.use('/api/transcribe-local/progress', (_req, res) => {
        sendJson(res, 200, progressReport());
      });

      server.middlewares.use('/api/transcribe-local/status', (_req, res) => {
        sendJson(res, 200, {
          ready: whisperModel !== null,
          model: loadedModelId || resolveModelId(),
          error: modelError,
          loading: modelLoadPromise !== null && whisperModel === null,
        });
      });

      server.middlewares.use('/api/transcribe-local', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJson(req)) as { path?: string; language?: string };
          const src = String(body.path ?? '').trim();
          const language = String(body.language ?? '').trim().toLowerCase();
          if (!src.startsWith('/media/uploads/')) {
            sendJson(res, 400, { error: 'path must be /media/uploads/<name>' });
            return;
          }
          const name = src.replace('/media/uploads/', '');
          let diskPath = resolveUploadFile(name);
          if (!diskPath) {
            const dir = uploadDir();
            const candidate = join(dir, name);
            if (existsSync(candidate)) diskPath = candidate;
          }
          if (!diskPath) {
            sendJson(res, 404, { error: `file not found: ${name}` });
            return;
          }

          progress = {
            active: true, file: basename(diskPath), totalSec: 0, doneSec: 0,
            startedAt: Date.now(), phase: 'loading-model',
          };
          const pipe = await loadModel();
          instrumentChunkProgress(pipe);
          server.config.logger.info(
            `[whisper] transcribing ${basename(diskPath)} with ${loadedModelId}`
            + ` (lang: ${language || 'auto'}, denoise: ${denoiseEnabled() ? 'on' : 'off'})`,
          );

          progress = { ...progress, phase: 'decoding' };
          const denoise = denoiseEnabled();
          let audio: Float32Array;
          try {
            audio = await decodeAudio(diskPath, denoise ? DENOISE_FILTER : null);
          } catch (filterErr) {
            // afftdn is missing from some ffmpeg builds — never fail the whole
            // run over an optional filter; fall back to the plain decode.
            if (!denoise) throw filterErr;
            server.config.logger.warn(`[whisper] denoise filter failed, decoding raw: ${String(filterErr)}`);
            audio = await decodeAudio(diskPath, null);
          }
          const CHUNK_S = 30;
          const STRIDE_S = 5;
          // Each chunk overlaps its neighbours by `stride` on both sides, so the
          // window advances by chunk - 2*stride of genuinely new audio.
          const stepSec = CHUNK_S - 2 * STRIDE_S;
          stepSecForRun = stepSec;
          progress = {
            ...progress,
            phase: 'transcribing',
            totalSec: audio.length / 16000,
            startedAt: Date.now(),
          };
          const result: any = await pipe(audio, {
            return_timestamps: 'word',
            chunk_length_s: CHUNK_S,
            stride_length_s: STRIDE_S,
            // Without an explicit language Whisper assumes English and returns
            // garbage for other languages. Omitting it entirely (language: '')
            // lets Whisper auto-detect instead.
            ...(language ? { language, task: 'transcribe' } : {}),
            // Whisper degenerates into repetition loops ("BABY BABY BABY…") over
            // music, game audio, and silence — anything without speech. Two guards:
            // don't feed the previous chunk's text back in as a prompt (that is what
            // lets a loop persist across chunks), and forbid repeating any 3-gram.
            condition_on_prev_tokens: false,
            no_repeat_ngram_size: 3,
          });

          const fullText = result.text ?? '';
          const chunks: Array<{ timestamp: [number, number]; text: string }> = result.chunks ?? [];

          const words = chunks
            .filter((c) => c.timestamp && c.timestamp[0] != null && c.timestamp[1] != null)
            .map((c) => ({
              text: (c.text ?? '').trim(),
              start: Math.round(c.timestamp[0] * 1000),
              end: Math.round(c.timestamp[1] * 1000),
            }))
            .filter((w) => w.text.length > 0);

          progress = { ...progress, active: false, doneSec: progress.totalSec, phase: 'done' };
          sendJson(res, 200, {
            text: fullText,
            words,
            utterances: [],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          progress = { ...progress, active: false, phase: 'error' };
          server.config.logger.error(`[whisper] ${message}`);
          if (/ENOENT|spawn ffmpeg/i.test(message)) {
            sendJson(res, 503, { error: 'ffmpeg not available', message });
          } else if (/model|pipeline|onnx/i.test(message)) {
            sendJson(res, 502, { error: 'whisper model error', message });
          } else {
            sendJson(res, 500, { error: 'transcription failed', message });
          }
        }
      });
    },
  };
}

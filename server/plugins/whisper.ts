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

function decodeAudio(inputPath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
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

export function whisperPlugin(): Plugin {
  return {
    name: 'openchatcut-whisper',
    configureServer(server) {
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

          const pipe = await loadModel();
          server.config.logger.info(
            `[whisper] transcribing ${basename(diskPath)} with ${loadedModelId} (lang: ${language || 'auto'})`,
          );

          const audio = await decodeAudio(diskPath);
          const result: any = await pipe(audio, {
            return_timestamps: 'word',
            chunk_length_s: 30,
            stride_length_s: 5,
            // Without an explicit language Whisper assumes English and returns
            // garbage for other languages. Omitting it entirely (language: '')
            // lets Whisper auto-detect instead.
            ...(language ? { language, task: 'transcribe' } : {}),
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

          sendJson(res, 200, {
            text: fullText,
            words,
            utterances: [],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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

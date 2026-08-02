import type { TranscriptResult } from './types';
import { getMediaBlob } from '../persist/mediaBlobStore';

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi|mpeg|mpg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
const LARGE_AUDIO_BYTES = 40 * 1024 * 1024;
const POLL_MS = 1000;

export class TranscriptionError extends Error {
  readonly code: 'source-unavailable' | 'service-unavailable';
  readonly detail?: string;

  constructor(code: 'source-unavailable' | 'service-unavailable', detail?: string) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'TranscriptionError';
    this.code = code;
    this.detail = detail;
  }
}

/** Live progress for a local run, polled while the blocking POST is in flight. */
export interface WhisperProgress {
  phase: 'decoding' | 'loading-model' | 'transcribing' | 'done' | 'error';
  percent: number;
  doneSec: number;
  totalSec: number;
  etaSec: number | null;
  /** Audio seconds processed per wall-clock second. */
  speed: number | null;
}

export interface TranscribeOptions {
  languageCode?: string | 'auto';
  asrPath?: string | null;
  onProgress?: (progress: WhisperProgress) => void;
}

export async function loadTranscriptionSource(path: string): Promise<Blob> {
  let responseError: Error | null = null;
  try {
    const res = await fetch(path);
    const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
    if (res.ok && !isHtml) return res.blob();
    responseError = new Error(`HTTP ${res.status}`);
  } catch (error) {
    responseError = error instanceof Error ? error : new Error(String(error));
  }
  const cached = await getMediaBlob(path);
  if (cached?.blob.size) return cached.blob;
  throw new TranscriptionError('source-unavailable', responseError?.message);
}

async function extractAudioForAsr(src: string): Promise<string | null> {
  if (!src.startsWith('/media/uploads/')) return null;
  try {
    const res = await fetch('/api/extract-audio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { path?: string; ok?: boolean };
    return data.path && data.path.startsWith('/media/uploads/') ? data.path : null;
  } catch {
    return null;
  }
}

async function headBytes(path: string): Promise<number | null> {
  try {
    const r = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') ?? '');
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

async function shouldExtractForAsr(path: string): Promise<boolean> {
  if (VIDEO_EXT.test(path)) return true;
  if (!AUDIO_EXT.test(path)) return true;
  const bytes = await headBytes(path);
  return bytes != null && bytes > LARGE_AUDIO_BYTES;
}

/** Whisper wants a bare ISO-639-1 code ('zh'), not a locale ('zh-CN') or 'auto'.
 * Returning null means "let Whisper auto-detect" rather than silently falling
 * back to English, which is what an unset language does. */
function normalizeLanguage(code: string | undefined): string | null {
  if (!code) return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return base && base !== 'auto' ? base : null;
}

export async function transcribePath(
  path: string,
  _onWait?: () => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  let source = path;
  if (opts.asrPath && opts.asrPath.startsWith('/media/')) {
    source = opts.asrPath;
  } else if (await shouldExtractForAsr(path)) {
    const extracted = await extractAudioForAsr(path);
    if (extracted) source = extracted;
  }

  const language = normalizeLanguage(opts.languageCode);
  // The server runs the whole file in one blocking call, so progress is polled
  // from a side channel rather than streamed on this response.
  const poll = opts.onProgress
    ? setInterval(() => {
      void fetch('/api/transcribe-local/progress', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((p: WhisperProgress | null) => { if (p) opts.onProgress?.(p); })
        .catch(() => { /* a dropped poll is not worth surfacing */ });
    }, POLL_MS)
    : null;

  let r: Response;
  try {
    r = await fetch('/api/transcribe-local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(language ? { path: source, language } : { path: source }),
    });
  } finally {
    if (poll) clearInterval(poll);
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    if (r.status === 503 || r.status === 502) {
      throw new TranscriptionError('service-unavailable', d.message || `whisper unavailable (HTTP ${r.status})`);
    }
    throw new Error(d.message || `transcription failed: HTTP ${r.status}`);
  }
  return r.json();
}

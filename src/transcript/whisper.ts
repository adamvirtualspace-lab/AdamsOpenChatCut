import type { TranscriptResult } from './types';
import { getMediaBlob } from '../persist/mediaBlobStore';

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v|avi|mpeg|mpg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;
const LARGE_AUDIO_BYTES = 40 * 1024 * 1024;

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

export interface TranscribeOptions {
  languageCode?: string | 'auto';
  asrPath?: string | null;
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
  const r = await fetch('/api/transcribe-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(language ? { path: source, language } : { path: source }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    if (r.status === 503 || r.status === 502) {
      throw new TranscriptionError('service-unavailable', d.message || `whisper unavailable (HTTP ${r.status})`);
    }
    throw new Error(d.message || `transcription failed: HTTP ${r.status}`);
  }
  return r.json();
}

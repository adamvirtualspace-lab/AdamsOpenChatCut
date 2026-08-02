// Transcription routing read from the server keystore, cached for the session.
//
// One resolver for the whole app: transcribe-jobs (UI path) and transcript-tools
// (agent path) previously kept independent caches, so a provider switch only took
// effect in one of them.
export type TranscriptionProvider = 'assemblyai' | 'whisper';

export interface TranscriptionSettings {
  provider: TranscriptionProvider;
  /** ISO-639-1 code, or '' meaning "let the engine detect it". */
  language: string;
}

const FALLBACK: TranscriptionSettings = { provider: 'assemblyai', language: '' };

let cached: TranscriptionSettings | null = null;
let inFlight: Promise<TranscriptionSettings> | null = null;

/** 'id', 'zh-CN' → 'zh', 'auto'/'' → '' (detect). */
export function normalizeLanguage(code: string | undefined | null): string {
  if (!code) return '';
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return base && base !== 'auto' ? base : '';
}

export async function transcriptionSettings(): Promise<TranscriptionSettings> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await fetch('/api/keys');
      if (r.ok) {
        const data = (await r.json()) as { models?: Record<string, string> };
        cached = {
          provider: data.models?.TRANSCRIPTION_PROVIDER === 'whisper' ? 'whisper' : 'assemblyai',
          language: normalizeLanguage(data.models?.TRANSCRIPTION_LANGUAGE),
        };
        return cached;
      }
    } catch { /* keystore unreachable — fall back below */ }
    return FALLBACK;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Drop the cache so the next transcription re-reads the keystore. */
export function invalidateTranscriptionSettings(): void {
  cached = null;
}

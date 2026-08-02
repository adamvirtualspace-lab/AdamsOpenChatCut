import { useCallback, useState } from 'react';
import { TranscriptionError, transcribePath as assemblyaiTranscribePath, type TranscribeOptions } from './assemblyai';
import { transcribePath as whisperTranscribePath, type WhisperProgress } from './whisper';
import { transcriptionSettings } from './provider-settings';
import type { TranscriptResult, TranscriptStatus } from './types';
import { t } from '../i18n/locale';

/** Route to the configured provider. This hook used to import AssemblyAI's
 * transcribePath directly, so the panel's Transcribe button uploaded media to
 * AssemblyAI even when the project was set to local Whisper. */
async function transcribeVia(
  path: string,
  onProcessing: () => void,
  opts?: TranscribeOptions & { onProgress?: (p: WhisperProgress) => void },
): Promise<{ result: TranscriptResult; local: boolean }> {
  const settings = await transcriptionSettings();
  const local = settings.provider === 'whisper';
  const fn = local ? whisperTranscribePath : assemblyaiTranscribePath;
  const result = await fn(path, onProcessing, {
    ...opts,
    languageCode: opts?.languageCode ?? settings.language ?? undefined,
  });
  return { result, local };
}

/** Local ASR never uploads — say what is actually happening. */
async function startLabel(label?: string): Promise<string> {
  const { provider } = await transcriptionSettings();
  if (provider === 'whisper') {
    return label ? t('本地转写 {label}…', { label }) : t('本地转写中…');
  }
  return label ? t('上传 {label}…', { label }) : t('上传音频…');
}

const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "42% · 24:10 / 57:50 · ~6:31 left" — percent alone hides how long is left. */
function progressLabel(p: WhisperProgress): string {
  if (p.phase === 'loading-model') return t('加载模型…');
  if (p.phase === 'decoding') return t('解码音频…');
  const base = t('{percent}% · {done} / {total}', {
    percent: p.percent, done: mmss(p.doneSec), total: mmss(p.totalSec),
  });
  return p.etaSec === null || p.doneSec <= 0
    ? base
    : `${base} · ${t('约剩 {eta}', { eta: mmss(p.etaSec) })}`;
}

function transcriptErrorMessage(error: unknown): string {
  if (error instanceof TranscriptionError) {
    return error.code === 'source-unavailable'
      ? t('素材文件不可用，请在“我的素材”中重新链接后再转写')
      : t('无法连接转写服务，请检查网络和 AssemblyAI 配置后重试');
  }
  return error instanceof Error ? error.message : String(error);
}

// Drives transcription against a same-origin media path.
// Never falls back to a demo sample — caller must pass a real clip src.
export function useTranscript() {
  const [status, setStatus] = useState<TranscriptStatus>('idle');
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
    setError(null);
    setActiveItemId(null);
    setProgressNote(null);
  }, []);

  const run = useCallback(async (
    path: string,
    opts?: TranscribeOptions & { itemId?: string; label?: string },
  ) => {
    setStatus('uploading');
    setError(null);
    setResult(null);
    setActiveItemId(opts?.itemId ?? null);
    setProgressNote(await startLabel(opts?.label));
    try {
      const { result: r } = await transcribeVia(
        path,
        () => {
          setStatus('processing');
          setProgressNote(opts?.label ? t('转写 {label}…', { label: opts.label }) : t('转写中…'));
        },
        {
          languageCode: opts?.languageCode,
          onProgress: (p) => { setStatus('processing'); setProgressNote(progressLabel(p)); },
        },
      );
      setResult(r);
      setStatus('done');
      setProgressNote(null);
      return r;
    } catch (e) {
      setError(transcriptErrorMessage(e));
      setStatus('error');
      setProgressNote(null);
      throw e;
    }
  }, []);

  /**
   * Transcribe many clips sequentially. Continues after per-clip failures so
   * one bad segment does not drop the rest of the track (user saw “only one”).
   */
  const runMany = useCallback(async (
    jobs: { path: string; itemId: string; label: string }[],
    onEach: (itemId: string, r: TranscriptResult) => void,
    opts?: TranscribeOptions,
  ) => {
    setError(null);
    setResult(null);
    let last: TranscriptResult | null = null;
    const failures: string[] = [];
    let ok = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      setActiveItemId(job.itemId);
      setStatus('uploading');
      setProgressNote(t('({i}/{total}) {phase}', {
        i: i + 1, total: jobs.length, phase: await startLabel(job.label),
      }));
      try {
        const { result: r } = await transcribeVia(
          job.path,
          () => {
            setStatus('processing');
            setProgressNote(t('({i}/{total}) 转写 {label}…', { i: i + 1, total: jobs.length, label: job.label }));
          },
          {
            ...opts,
            onProgress: (p) => {
              setStatus('processing');
              setProgressNote(t('({i}/{total}) {phase}', {
                i: i + 1, total: jobs.length, phase: progressLabel(p),
              }));
            },
          },
        );
        last = r;
        setResult(r);
        onEach(job.itemId, r);
        ok += 1;
      } catch (e) {
        const msg = transcriptErrorMessage(e);
        failures.push(`${job.label}: ${msg}`);
        // keep going — partial track is better than abort
      }
    }
    setActiveItemId(null);
    setProgressNote(null);
    if (failures.length && !ok) {
      setError(failures.join('；'));
      setStatus('error');
      throw new Error(failures[0]);
    }
    if (failures.length) {
      setError(t('已完成 {ok}/{total} 段；失败：{fails}', { ok, total: jobs.length, fails: failures.join('；') }));
      setStatus('done');
    } else {
      setStatus('done');
      setError(null);
    }
    return last;
  }, []);

  return { status, result, error, activeItemId, progressNote, run, runMany, reset };
}

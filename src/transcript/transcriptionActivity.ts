import { useSyncExternalStore } from 'react';

/**
 * Module-level record of the in-flight transcription.
 *
 * The Transcript panel unmounts whenever the user switches to Captions / My
 * Media / …, which destroys any component-local run state. The server keeps
 * transcribing regardless, so on return the panel looked idle and re-armed its
 * Transcribe button — clicking it hit the server's one-run-at-a-time guard and
 * surfaced a bare "HTTP 409". Keeping the run here, outside React's component
 * lifecycle, means the panel shows it again as soon as it remounts.
 *
 * `adoptServerRun` additionally recovers a run this tab never started (or
 * started before a reload), so the UI can never re-arm over a live run.
 */
export interface TranscriptionActivity {
  active: boolean;
  /** Human-readable progress line, e.g. "转写中… 43%". */
  note: string | null;
}

let state: TranscriptionActivity = { active: false, note: null };
const listeners = new Set<() => void>();

function emit(next: TranscriptionActivity) {
  state = next;
  for (const listener of listeners) listener();
}

export function beginTranscription(note: string | null): void {
  emit({ active: true, note });
}

export function reportTranscription(note: string | null): void {
  if (!state.active) return;
  emit({ active: true, note });
}

export function endTranscription(): void {
  if (!state.active && state.note === null) return;
  emit({ active: false, note: null });
}

/**
 * Ask the server whether a local-whisper run is in flight and mirror it. Returns
 * true when one was adopted. Safe to call on mount; a failed probe is treated as
 * "nothing running" so a dead endpoint cannot wedge the button off.
 */
export async function adoptServerRun(): Promise<boolean> {
  try {
    const res = await fetch('/api/transcribe-local/progress', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      active?: boolean; percent?: number; phase?: string;
      verifyDone?: number; verifyTotal?: number;
    };
    if (!data.active) {
      // Only clear a run this tab is not actively driving.
      if (state.active && state.note === null) endTranscription();
      return false;
    }
    emit({ active: true, note: serverRunNote(data) });
    return true;
  } catch {
    return false;
  }
}

/** Progress line for a run observed on the server rather than driven locally. */
export function serverRunNote(data: {
  percent?: number; phase?: string; verifyDone?: number; verifyTotal?: number;
}): string {
  if (data.phase === 'verifying-repeats' && data.verifyTotal) {
    return `verifying repeats ${data.verifyDone ?? 0}/${data.verifyTotal}`;
  }
  return `transcribing ${Math.round(data.percent ?? 0)}%`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getSnapshot = (): TranscriptionActivity => state;

export function useTranscriptionActivity(): TranscriptionActivity {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

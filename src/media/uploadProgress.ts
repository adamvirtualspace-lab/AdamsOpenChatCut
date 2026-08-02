import { useSyncExternalStore } from 'react';

/**
 * Module-level upload-progress store.
 *
 * The My Media panel (MediaPoolPanel) unmounts when the user switches to the
 * Transcript / Captions / … tabs, which would drop any component-local upload
 * state and hide the "42%" indicator even though the upload keeps running in the
 * background. Keeping the progress here — outside React's component lifecycle —
 * means it survives the unmount and is shown again the moment the panel remounts.
 */
export interface UploadProgressState {
  /** An import is in flight. */
  active: boolean;
  /** Aggregate 0..1 progress across the current import batch. */
  ratio: number;
}

let state: UploadProgressState = { active: false, ratio: 0 };
const listeners = new Set<() => void>();

function emit(next: UploadProgressState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Start (or restart) tracking an import batch at 0%. */
export function beginUpload(): void {
  emit({ active: true, ratio: 0 });
}

/** Report aggregate progress for the in-flight batch. Ignored once ended. */
export function reportUpload(ratio: number): void {
  if (!state.active) return;
  emit({ active: true, ratio: Math.min(1, Math.max(0, ratio)) });
}

/** Clear tracking — the batch finished, failed, or was cancelled. */
export function endUpload(): void {
  if (!state.active && state.ratio === 0) return;
  emit({ active: false, ratio: 0 });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): UploadProgressState {
  return state;
}

/** Subscribe a component to the persistent upload progress. */
export function useUploadProgress(): UploadProgressState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

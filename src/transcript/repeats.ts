// Collapse Whisper's stutter artifacts — the "Kayu Kayu Kayu Kayu" runs — without
// destroying speech that genuinely repeats.
//
// Count alone is the wrong signal. Measured over 58 minutes of gameplay commentary,
// runs of 3+ identical consecutive words split cleanly by RATE, not length:
//
//   Bentar,  3x in 0.5s  = 6.25/s   artifact — unsayable at that speed
//   Nih,    11x in 2.6s  = 4.26/s   artifact
//   Kayu.    4x in 2.0s  = 2.01/s   artifact
//   udah     8x in 6.3s  = 1.27/s   plausible speech
//   coba     5x in 5.4s  = 0.93/s   plausible speech
//   ngeng    7x in 9.8s  = 0.71/s   real — imitating an engine
//   Tidak.   3x in 9.1s  = 0.33/s   real
//
// So a run is an artifact when the same word recurs faster than a person says it.
// A collapsed run keeps ONE word spanning the whole run, so no audio is orphaned
// and the timeline stays continuous for delete-text edits.
import type { TranscriptWord } from './types.ts';

export interface CollapseOptions {
  /** Repeats per second above which a run is treated as an artifact. */
  maxRepeatsPerSecond?: number;
  /** Runs shorter than this are never touched. */
  minRun?: number;
  /** A run spanning longer than this is a stuck decoder, not a stutter. */
  loopSuspectSeconds?: number;
}

export interface CollapseResult {
  words: TranscriptWord[];
  /** How many words were removed. */
  removed: number;
  /** Runs collapsed. */
  collapsed: number;
  /** Long runs that likely mean speech was LOST, not just duplicated — these
   * cannot be repaired by collapsing and are worth re-transcribing. */
  suspectLoops: { text: string; count: number; startMs: number; endMs: number }[];
}

/** Above this, no verification can make a run credible: 4 repeats per second is
 * faster than the word can be articulated. Whisper reproduces some of these
 * across every temperature, so "an independent pass agreed" is not evidence of
 * real speech here — it is the same failure repeating. */
export const IMPOSSIBLE_REPEATS_PER_SECOND = 3.5;

const DEFAULTS: Required<CollapseOptions> = {
  // 2.0 catches the observed artifacts down to "Kayu." (2.01/s) while leaving
  // every run that reads as real speech (<= 1.3/s) alone.
  maxRepeatsPerSecond: 2,
  minRun: 3,
  loopSuspectSeconds: 30,
};

/** Compare ignoring case and punctuation: "Kayu." and "kayu," are the same word. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface RepeatRun {
  text: string;
  count: number;
  startMs: number;
  endMs: number;
  /** Repeats per second — the signal that separates artifact from speech. */
  rate: number;
  /** Index of the first word of the run. */
  index: number;
}

/** Suspicious repeat runs, for a caller that can afford to VERIFY them by
 * re-transcribing the window rather than trusting the rate heuristic alone. */
export function findRepeatRuns(
  words: readonly TranscriptWord[],
  options: CollapseOptions = {},
): RepeatRun[] {
  const opts = { ...DEFAULTS, ...options };
  const runs: RepeatRun[] = [];
  let start = 0;
  for (let i = 1; i <= words.length; i++) {
    const key = start < words.length ? normalize(words[start].text) : '';
    const same = i < words.length && !!key && normalize(words[i].text) === key;
    if (same) continue;
    const count = i - start;
    if (count >= opts.minRun) {
      const startMs = words[start].start;
      const endMs = words[i - 1].end;
      const spanSec = (endMs - startMs) / 1000;
      const rate = spanSec > 0 ? count / spanSec : Infinity;
      if (rate >= opts.maxRepeatsPerSecond) {
        runs.push({ text: words[start].text, count, startMs, endMs, rate, index: start });
      }
    }
    start = i;
  }
  return runs;
}

export function collapseRepeats(
  words: readonly TranscriptWord[],
  options: CollapseOptions = {},
): CollapseResult {
  const opts = { ...DEFAULTS, ...options };
  const out: TranscriptWord[] = [];
  const suspectLoops: CollapseResult['suspectLoops'] = [];
  let removed = 0;
  let collapsed = 0;

  let start = 0;
  for (let i = 1; i <= words.length; i++) {
    const key = start < words.length ? normalize(words[start].text) : '';
    const same = i < words.length && !!key && normalize(words[i].text) === key;
    if (same) continue;

    const run = words.slice(start, i);
    if (run.length >= opts.minRun) {
      const spanSec = (run[run.length - 1].end - run[0].start) / 1000;
      // A zero-length span is degenerate — treat it as maximally fast.
      const rate = spanSec > 0 ? run.length / spanSec : Infinity;
      if (rate >= opts.maxRepeatsPerSecond) {
        out.push({ ...run[0], end: run[run.length - 1].end });
        removed += run.length - 1;
        collapsed += 1;
        if (spanSec >= opts.loopSuspectSeconds) {
          suspectLoops.push({
            text: run[0].text, count: run.length,
            startMs: run[0].start, endMs: run[run.length - 1].end,
          });
        }
        start = i;
        continue;
      }
    }
    out.push(...run);
    start = i;
  }

  return { words: out, removed, collapsed, suspectLoops };
}

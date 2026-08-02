import assert from 'node:assert/strict';
import { collapseRepeats } from './repeats';
import type { TranscriptWord } from './types';

/** n copies of `text`, evenly spread across spanMs starting at startMs. */
const run = (text: string, n: number, startMs: number, spanMs: number): TranscriptWord[] => {
  const step = spanMs / n;
  return Array.from({ length: n }, (_, i) => ({
    text,
    start: Math.round(startMs + i * step),
    end: Math.round(startMs + (i + 1) * step),
  }));
};

// ── fast repeats are artifacts and collapse ──────────────────────────────────
{
  // "Kayu." 4x in 2.0s = 2.0/s — the reported artifact, right at the threshold.
  const r = collapseRepeats(run('Kayu.', 4, 1000, 2000));
  assert.equal(r.words.length, 1, 'a 2/s run collapses to one word');
  assert.equal(r.removed, 3);
  assert.equal(r.collapsed, 1);
  assert.equal(r.words[0].start, 1000, 'kept word starts where the run started');
  assert.equal(r.words[0].end, 3000, 'kept word spans the WHOLE run so no audio is orphaned');
}

// ── slow repeats are real speech and survive ─────────────────────────────────
{
  // "ngeng" 7x over 9.8s = 0.71/s — imitating an engine, must not be touched.
  const r = collapseRepeats(run('ngeng', 7, 0, 9800));
  assert.equal(r.words.length, 7, 'slow repetition is left alone');
  assert.equal(r.removed, 0);
}

// ── run length alone never triggers a collapse ───────────────────────────────
{
  // 8 repeats, but spread over 6.3s (1.27/s) — plausible frustrated speech.
  const r = collapseRepeats(run('udah', 8, 0, 6300));
  assert.equal(r.words.length, 8, 'a long BUT slow run is speech, not an artifact');
}

// ── below minRun nothing happens, however fast ───────────────────────────────
{
  const r = collapseRepeats(run('ya', 2, 0, 100));
  assert.equal(r.words.length, 2, 'a natural double is never collapsed');
}

// ── case and punctuation do not split a run ──────────────────────────────────
{
  const words: TranscriptWord[] = [
    { text: 'Coba,', start: 0, end: 200 },
    { text: 'coba', start: 200, end: 400 },
    { text: 'COBA.', start: 400, end: 600 },
  ];
  const r = collapseRepeats(words);
  assert.equal(r.words.length, 1, '"Coba," / "coba" / "COBA." are the same word');
  assert.equal(r.words[0].end, 600);
}

// ── surrounding words are preserved in order ─────────────────────────────────
{
  const words: TranscriptWord[] = [
    { text: 'ini', start: 0, end: 300 },
    ...run('nih', 5, 300, 1000),
    { text: 'apa', start: 1300, end: 1600 },
  ];
  const r = collapseRepeats(words);
  assert.deepEqual(r.words.map((w) => w.text), ['ini', 'nih', 'apa']);
  assert.equal(r.words[1].start, 300);
  assert.equal(r.words[1].end, 1300, 'collapsed word still abuts the next word');
}

// ── a very long stuck run is flagged, because speech was LOST not duplicated ──
{
  const r = collapseRepeats(run('Terima', 200, 0, 60_000));
  assert.equal(r.suspectLoops.length, 1, 'a 60s run is reported as a suspected decoder loop');
  assert.equal(r.suspectLoops[0].count, 200);
  assert.equal(r.words.length, 1);
}

// ── degenerate zero-span runs collapse rather than divide by zero ────────────
{
  const words: TranscriptWord[] = [
    { text: 'x', start: 100, end: 100 },
    { text: 'x', start: 100, end: 100 },
    { text: 'x', start: 100, end: 100 },
  ];
  const r = collapseRepeats(words);
  assert.equal(r.words.length, 1, 'zero-length span counts as maximally fast');
}

// ── empty input ──────────────────────────────────────────────────────────────
assert.deepEqual(collapseRepeats([]).words, []);

console.log('repeats.verify: ok');

// SubRip (.srt) / WebVTT import → word-level transcript.
//
// ASR gives per-word timings; an SRT only gives per-CUE timings. So a cue's span
// is divided across its words proportionally to how long each word takes to say,
// approximated by character count. That keeps word order and cue boundaries exact
// (which is what caption sync needs) while giving downstream word-level tools —
// find_transcript, clean_script, delete_text — something to bite on.
// Explicit extension: this module is imported by the server plugin too, whose
// tsconfig uses node16 resolution and requires it.
import type { TranscriptResult, TranscriptWord } from './types.ts';

export interface SrtCue {
  /** 1-based cue number as written in the file, or the running index when absent. */
  index: number;
  startMs: number;
  endMs: number;
  /** Cue text with markup stripped, newlines collapsed to single spaces. */
  text: string;
}

export class SrtParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'SrtParseError';
    this.line = line;
  }
}

/** 00:01:02,500 / 00:01:02.500 / 01:02.500 (VTT allows a missing hour field). */
const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;
const ARROW = /\s*-->\s*/;

function parseTimestamp(raw: string, line: number): number {
  const m = TIME.exec(raw.trim());
  if (!m) throw new SrtParseError(`bad timestamp ${JSON.stringify(raw)}`, line);
  const [, h, mm, ss, frac] = m;
  // '5' means 500ms, '05' means 50ms — pad right, not left.
  const ms = Number(frac.padEnd(3, '0'));
  return ((Number(h ?? 0) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + ms;
}

/** Strip the markup SRT/VTT carry: <i>, {\an8}, and VTT's cue-payload tags. */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSrt(input: string): SrtCue[] {
  // Strip BOM; normalize CRLF/CR so line splitting is uniform.
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const cues: SrtCue[] = [];
  let i = 0;
  let running = 0;

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;

    // WebVTT preamble and cue-level NOTE/STYLE blocks are not cues.
    const head = lines[i].trim();
    if (/^WEBVTT/.test(head) || /^(NOTE|STYLE|REGION)\b/.test(head)) {
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }

    // Optional numeric id line, then the timing line. Some writers omit the id.
    let index = ++running;
    if (!ARROW.test(lines[i]) && /^\d+$/.test(head)) {
      index = Number(head);
      i++;
      while (i < lines.length && lines[i].trim() === '') i++;
    }
    if (i >= lines.length) break;

    const timingLine = i + 1;
    const timing = lines[i];
    if (!ARROW.test(timing)) throw new SrtParseError('expected a "-->" timing line', timingLine);
    // VTT appends cue settings after the end time: "00:00:01.000 align:start"
    const [rawStart, rawRest] = timing.split(ARROW);
    const rawEnd = (rawRest ?? '').trim().split(/\s+/)[0] ?? '';
    const startMs = parseTimestamp(rawStart, timingLine);
    const endMs = parseTimestamp(rawEnd, timingLine);
    i++;

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') { body.push(lines[i]); i++; }

    const cueText = stripMarkup(body.join(' '));
    // Drop empty and non-advancing cues — they produce no usable words.
    if (cueText && endMs > startMs) cues.push({ index, startMs, endMs, text: cueText });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** Split a cue into words timed proportionally to their length. */
function cueWords(cue: SrtCue, floorMs: number): TranscriptWord[] {
  const tokens = cue.text.split(' ').filter(Boolean);
  if (!tokens.length) return [];

  // Never let a cue start before the previous cue ended: overlapping subtitles are
  // common, but a non-monotonic word list breaks find/clean/delete downstream.
  const start = Math.max(cue.startMs, floorMs);
  const end = Math.max(cue.endMs, start + tokens.length);
  const span = end - start;
  const total = tokens.reduce((n, w) => n + w.length, 0);

  const words: TranscriptWord[] = [];
  let cursor = start;
  tokens.forEach((token, n) => {
    const share = total > 0 ? (token.length / total) * span : span / tokens.length;
    // Last word absorbs rounding drift so the cue ends exactly on endMs.
    const wordEnd = n === tokens.length - 1 ? end : Math.min(end, Math.round(cursor + share));
    words.push({ text: token, start: Math.round(cursor), end: Math.max(wordEnd, Math.round(cursor) + 1) });
    cursor = wordEnd;
  });
  return words;
}

/** Parsed cues → the same shape the ASR providers return. */
export function srtToTranscript(input: string): TranscriptResult {
  const cues = parseSrt(input);
  const words: TranscriptWord[] = [];
  let floor = 0;
  for (const cue of cues) {
    const next = cueWords(cue, floor);
    if (!next.length) continue;
    words.push(...next);
    floor = next[next.length - 1].end;
  }
  return {
    text: cues.map((c) => c.text).join(' '),
    words,
    // SRT carries no speaker diarization.
    utterances: [],
  };
}

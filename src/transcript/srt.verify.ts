import assert from 'node:assert/strict';
import { parseSrt, srtToTranscript, SrtParseError } from './srt';

// --- basic cue parsing -------------------------------------------------------
const basic = [
  '1',
  '00:00:00,000 --> 00:00:01,366',
  'selamat datang kembali di Adam',
  '',
  '2',
  '00:00:03,000 --> 00:00:03,800',
  'Adam Adam',
  '',
].join('\n');

const cues = parseSrt(basic);
assert.equal(cues.length, 2);
assert.equal(cues[0].index, 1);
assert.equal(cues[0].startMs, 0);
assert.equal(cues[0].endMs, 1366);
assert.equal(cues[0].text, 'selamat datang kembali di Adam');
assert.equal(cues[1].startMs, 3000);

// --- CRLF, BOM, and multi-line cues -----------------------------------------
const messy = '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nline one\r\nline two\r\n\r\n';
const messyCues = parseSrt(messy);
assert.equal(messyCues.length, 1);
assert.equal(messyCues[0].text, 'line one line two', 'newlines inside a cue collapse to a space');

// --- markup is stripped ------------------------------------------------------
const tagged = '1\n00:00:01,000 --> 00:00:02,000\n<i>hello</i> {\\an8}world\n';
assert.equal(parseSrt(tagged)[0].text, 'hello world');

// --- fractional padding: ,5 is 500ms not 5ms ---------------------------------
const frac = '1\n00:00:01,5 --> 00:00:02,05\ntext\n';
const fracCue = parseSrt(frac)[0];
assert.equal(fracCue.startMs, 1500);
assert.equal(fracCue.endMs, 2050);

// --- WebVTT: header, missing hour field, cue settings ------------------------
const vtt = ['WEBVTT', '', '00:01.000 --> 01:30.500 align:start', 'vtt cue', ''].join('\n');
const vttCues = parseSrt(vtt);
assert.equal(vttCues.length, 1, 'WEBVTT header is not a cue');
assert.equal(vttCues[0].startMs, 1000, 'mm:ss.mmm — 00:01.000 is one second');
assert.equal(vttCues[0].endMs, 90_500, 'mm:ss.mmm — 01:30.500 is ninety-and-a-half seconds');
assert.equal(vttCues[0].text, 'vtt cue', 'trailing cue settings are not part of the text');

// --- cues with no id line ----------------------------------------------------
const noId = '00:00:01,000 --> 00:00:02,000\nfirst\n\n00:00:02,000 --> 00:00:03,000\nsecond\n';
assert.equal(parseSrt(noId).length, 2);

// --- degenerate cues are dropped, not emitted --------------------------------
const degenerate = [
  '1', '00:00:01,000 --> 00:00:01,000', 'zero length', '',
  '2', '00:00:02,000 --> 00:00:03,000', '', '',
  '3', '00:00:04,000 --> 00:00:05,000', 'kept', '',
].join('\n');
const kept = parseSrt(degenerate);
assert.equal(kept.length, 1);
assert.equal(kept[0].text, 'kept');

// --- malformed timing reports the line ---------------------------------------
assert.throws(
  () => parseSrt('1\n00:00:01,000 -> 00:00:02,000\nbad arrow\n'),
  (e: unknown) => e instanceof SrtParseError,
  'a missing --> is a parse error',
);

// --- word timing -------------------------------------------------------------
const result = srtToTranscript(basic);
assert.equal(result.utterances.length, 0, 'SRT has no diarization');
assert.equal(result.words.length, 7, '5 words + 2 words');
assert.equal(result.words[0].text, 'selamat');
assert.equal(result.words[0].start, 0);
assert.equal(result.words[4].end, 1366, 'last word of a cue lands exactly on cue end');
assert.equal(result.text, 'selamat datang kembali di Adam Adam Adam');

// every word is forward-going and ordered
for (let i = 0; i < result.words.length; i++) {
  const w = result.words[i];
  assert.ok(w.end > w.start, `word ${i} (${w.text}) must have end > start`);
  if (i > 0) assert.ok(w.start >= result.words[i - 1].end, `word ${i} must not precede word ${i - 1}`);
}

// longer words get a longer slice than shorter ones
const weighted = srtToTranscript('1\n00:00:00,000 --> 00:00:10,000\na abcdefghij\n');
const [short, long] = weighted.words;
assert.ok(long.end - long.start > short.end - short.start, 'duration is weighted by word length');

// --- overlapping cues stay monotonic ----------------------------------------
const overlap = [
  '1', '00:00:00,000 --> 00:00:05,000', 'first cue', '',
  '2', '00:00:02,000 --> 00:00:06,000', 'second cue', '',
].join('\n');
const overlapped = srtToTranscript(overlap);
for (let i = 1; i < overlapped.words.length; i++) {
  assert.ok(
    overlapped.words[i].start >= overlapped.words[i - 1].end,
    'overlapping cues must not produce back-stepping words',
  );
}

// --- empty input --------------------------------------------------------------
assert.deepEqual(parseSrt(''), []);
assert.equal(srtToTranscript('').words.length, 0);

console.log('srt.verify: ok');

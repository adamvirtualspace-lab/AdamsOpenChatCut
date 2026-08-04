// Runnable check: `npx tsx src/editor/transcriptSrcInFrame.verify.ts`.
//
// setItemTranscript zeroes srcInFrame when the clip carried a STALE transcript.
// That is correct only for word-driven audio, where srcInFrame indexes the
// packed word stream and cannot survive a new stream. For an ordinary video
// clip srcInFrame is a media offset: zeroing it silently rewinds the clip to
// the head of the source and destroys the edit.
//
// Real-world failure this guards: a 56-segment cut where every segment carried
// a stale transcript. Transcribing the timeline reset each finished segment to
// source 0, so the first minutes of the cut replayed the opening.
import assert from 'node:assert/strict';
import { reduce } from './reduce';
import type { MediaAsset, TimelineItem, TimelineState } from './types';

const asset: MediaAsset = {
  id: 'asset-a',
  name: 'Source A',
  kind: 'video',
  src: '/media/uploads/a.mp4',
  durationInFrames: 100_000,
};

const words = [
  { text: 'alpha', start: 0, end: 500 },
  { text: 'beta', start: 500, end: 1_000 },
];

const stateOf = (item: TimelineItem): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [item],
  assets: [asset],
  selectedId: item.id,
  selectedIds: [item.id],
  trackOrder: [item.track],
  tracks: { [item.track]: { kind: item.kind === 'audio' ? 'audio' : 'video' } },
});

const videoClip = (patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id: 'clip-v',
  track: 'video-main',
  kind: 'video',
  name: 'Segment 12',
  src: asset.src,
  startFrame: 8_360,
  durationInFrames: 1_329,
  srcInFrame: 46_231,
  ...patch,
});

// A trimmed video segment whose retained transcript is stale: the new words
// arrive in source coordinates, so the existing media offset stays valid.
{
  const state = stateOf(videoClip({ transcript: words, transcriptStale: true }));
  const next = reduce(state, { type: 'setItemTranscript', id: 'clip-v', words });
  const after = next.items[0]!;
  assert.equal(
    after.srcInFrame,
    46_231,
    'a stale-transcript VIDEO clip keeps its source in-point when transcribed',
  );
  assert.equal(after.transcriptStale, false, 'the refreshed transcript is no longer stale');
  assert.deepEqual(
    { startFrame: after.startFrame, durationInFrames: after.durationInFrames },
    { startFrame: 8_360, durationInFrames: 1_329 },
    'timeline placement is untouched',
  );
}

// A fresh (non-stale) video clip was always safe; keep it that way.
{
  const state = stateOf(videoClip({ transcript: words, transcriptStale: false }));
  const next = reduce(state, { type: 'setItemTranscript', id: 'clip-v', words });
  assert.equal(next.items[0]!.srcInFrame, 46_231, 'a non-stale video clip keeps its source in-point');
}

// A clip with no transcript at all also keeps its trim.
{
  const state = stateOf(videoClip());
  const next = reduce(state, { type: 'setItemTranscript', id: 'clip-v', words });
  assert.equal(next.items[0]!.srcInFrame, 46_231, 'an untranscribed video clip keeps its source in-point');
}

// Word-driven audio is the case the reset exists for: srcInFrame indexes the
// packed word stream, so a replaced stream must restart at 0.
{
  const audio = videoClip({
    id: 'clip-a',
    track: 'audio-main',
    kind: 'audio',
    srcInFrame: 15,
    transcript: words,
    transcriptStale: true,
  });
  const next = reduce(stateOf(audio), { type: 'setItemTranscript', id: 'clip-a', words });
  assert.equal(
    next.items[0]!.srcInFrame,
    0,
    'word-driven audio still rebases to 0 when its stale word stream is replaced',
  );
}

console.log('transcriptSrcInFrame.verify.ts OK');

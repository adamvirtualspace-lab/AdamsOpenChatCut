import assert from 'node:assert/strict';
import { clampTimelineZoom, fitTimelineZoom, scaleTimelineZoom } from './timelineZoom.ts';

// Mirrors the timeline's real constants (timelineUtil.ts / useTimelineZoomController.ts).
const HEADER_W = 212;
const PX_PER_FRAME = 1.2;
const FIT_PADDING = 48;
const MIN_TIME_ZOOM = 0.02;
const LIMITS = { min: MIN_TIME_ZOOM, max: 6 };
const VIEWPORT = 1312;
const FPS = 30;

/** The fit pass relaxes the floor to whatever the content needs (useTimelineZoomController.fitLimits). */
function fitLimits(viewportWidth: number, totalFrames: number) {
  const usable = viewportWidth - HEADER_W - FIT_PADDING;
  if (usable <= 0 || totalFrames <= 0) return LIMITS;
  return { min: Math.min(LIMITS.min, usable / (totalFrames * PX_PER_FRAME)), max: LIMITS.max };
}

const fittedZoom = (viewportWidth: number, totalFrames: number) => fitTimelineZoom(
  viewportWidth, HEADER_W, FIT_PADDING, totalFrames, PX_PER_FRAME,
  fitLimits(viewportWidth, totalFrames),
);

/** Frames visible in the viewport at a given zoom — what "fits" actually means. */
const visibleFrames = (viewportWidth: number, zoom: number) =>
  (viewportWidth - HEADER_W - FIT_PADDING) / (zoom * PX_PER_FRAME);

assert.equal(clampTimelineZoom(0.001, LIMITS), MIN_TIME_ZOOM);
assert.equal(clampTimelineZoom(99, LIMITS), 6);
assert.equal(fitTimelineZoom(VIEWPORT, HEADER_W, FIT_PADDING, 0, PX_PER_FRAME, LIMITS), null);
assert.equal(fitTimelineZoom(0, HEADER_W, FIT_PADDING, 1000, PX_PER_FRAME, LIMITS), null);

// A short timeline fits well within the normal floor and is unaffected by the relaxation.
const shortFrames = 60 * FPS;
const shortZoom = fittedZoom(VIEWPORT, shortFrames)!;
assert.ok(shortZoom > MIN_TIME_ZOOM, 'a 60s timeline should not need to go below the floor');
assert.ok(visibleFrames(VIEWPORT, shortZoom) >= shortFrames - 1);

// Regression: a ~115 min timeline (the ScrapMechanic case) needs to zoom out far past
// MIN_TIME_ZOOM. Clamping to the floor left ~24 min visible, so clips beyond that were
// unreachable and "fit to view" looked like it did nothing.
const longFrames = 208208; // 115:40 at 30fps
const clampedToFloor = fitTimelineZoom(
  VIEWPORT, HEADER_W, FIT_PADDING, longFrames, PX_PER_FRAME, LIMITS,
)!;
assert.equal(clampedToFloor, MIN_TIME_ZOOM, 'old behaviour: pinned at the floor');
assert.ok(
  visibleFrames(VIEWPORT, clampedToFloor) < longFrames,
  'old behaviour could not show the whole timeline',
);

const longZoom = fittedZoom(VIEWPORT, longFrames)!;
assert.ok(longZoom < MIN_TIME_ZOOM, 'fit must be allowed below the floor for long timelines');
assert.ok(
  visibleFrames(VIEWPORT, longZoom) >= longFrames - 1,
  'the whole timeline must be visible after fitting',
);

// The far end of the clip that was stranded off-screen is now inside the viewport.
assert.ok(visibleFrames(VIEWPORT, longZoom) >= 100479 + 104104 - 1);

// Fitting never exceeds the max, and zooming stays bounded afterwards.
assert.ok(longZoom <= 6 && shortZoom <= 6);
assert.equal(scaleTimelineZoom(longZoom, 1.12, LIMITS), MIN_TIME_ZOOM);

console.log('timelineZoom.verify: ok (clamp/null guards/short fit unchanged/long timeline fits below floor)');

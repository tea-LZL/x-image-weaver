import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const { computeCanvasSize, TUNABLES } = loadCore();

test('stacks equal tiles at scale 1', () => {
  const tiles = Array(4).fill({ width: 1920, height: 1080 });
  assert.deepEqual(computeCanvasSize(tiles), { width: 1920, height: 4320, scale: 1 });
});

test('uses the widest tile as canvas width', () => {
  const r = computeCanvasSize([{ width: 2000, height: 1000 }, { width: 1500, height: 1000 }]);
  assert.equal(r.width, 2000);
  assert.equal(r.height, 2000);
});

test('downscales uniformly when total height exceeds the cap', () => {
  const tiles = Array(4).fill({ width: 1920, height: 4320 });
  const r = computeCanvasSize(tiles);
  assert.equal(r.height, TUNABLES.MAX_CANVAS_HEIGHT);
  assert.equal(r.width, 1778);
  assert.ok(r.scale < 1);
});

test('downscales further when area exceeds the cap', () => {
  const tiles = Array(2).fill({ width: 40000, height: 16000 });
  const r = computeCanvasSize(tiles);
  assert.ok(r.width * r.height <= TUNABLES.MAX_CANVAS_AREA);
  assert.deepEqual(r, { width: 15625, height: 12500, scale: 0.390625 });
});

// The one case above cannot tell the two readings of "recompute after the area
// cap" apart: 40000 and 32000 against a 16000/32000 height scale and a
// 250000000/512000000 area factor are all dyadic, so re-rounding from the
// unscaled extents and re-rounding the already-rounded pixels land on the same
// integer every time. They part company on a .5 tie, which is what this is.
//
// Here the height scale is 16000/16006 and the area factor 0.48828125, so the
// two readings compute 16006 * 0.4880982131700612 = 7812.499999999999, a hair
// under the tie, and 16000 * 0.48828125 = 7812.5, which Math.round breaks
// upward. Task 4's draw stage scales tiles by this function's `scale`; if it
// instead scaled the rounded canvas, the drawn stack would be one pixel taller
// than the canvas it computed and the bottom row would be clipped.
test('recomputes the area-capped size from the unscaled extents, not the rounded pixels', () => {
  const r = computeCanvasSize([
    { width: 32012, height: 8003 },
    { width: 32012, height: 8003 },
  ]);
  assert.equal(r.width, 15625);
  assert.equal(r.height, 7812);
});

test('clamps a canvas dimension to at least 1px, which Chrome requires', () => {
  // 1 * 0.32 rounds to 0, and a 0-width canvas is rejected by Chrome rather than
  // created small.
  assert.deepEqual(computeCanvasSize([{ width: 1, height: 50000 }]), {
    width: 1,
    height: 16000,
    scale: 0.32,
  });
  // The height floor is the same expression; a decoded image is never 0px tall,
  // so this pins the two dimensions together rather than the height on its own.
  assert.deepEqual(computeCanvasSize([{ width: 100, height: 0 }]), {
    width: 100,
    height: 1,
    scale: 1,
  });
});

test('passes a single tile through unscaled', () => {
  assert.deepEqual(computeCanvasSize([{ width: 800, height: 600 }]), { width: 800, height: 600, scale: 1 });
});

test('throws on an empty tile list', () => {
  assert.throws(() => computeCanvasSize([]), /empty/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const { computeCanvasSize, composeDirection, TUNABLES } = loadCore();

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

// --- joining left to right --------------------------------------------------------
//
// Two images that belong side by side are one picture split vertically down the
// middle, and stacking them produces a picture that is visibly wrong. The summed
// axis and the maximum axis swap, and the cap follows the summed one.

test('horizontal sums widths and takes the tallest part', () => {
  const r = computeCanvasSize([{ width: 800, height: 600 }, { width: 400, height: 900 }], 'horizontal');
  assert.deepEqual(r, { width: 1200, height: 900, scale: 1 });
});

test('horizontal downscales when the total width exceeds the cap', () => {
  const tiles = Array(4).fill({ width: 6000, height: 400 });
  const r = computeCanvasSize(tiles, 'horizontal');
  assert.equal(r.width, TUNABLES.MAX_CANVAS_WIDTH);
  assert.equal(r.scale, TUNABLES.MAX_CANVAS_WIDTH / 24000);
});

test('horizontal and vertical are not interchangeable for the same tiles', () => {
  const tiles = [{ width: 900, height: 300 }, { width: 900, height: 300 }];
  const h = computeCanvasSize(tiles, 'horizontal');
  const v = computeCanvasSize(tiles, 'vertical');
  assert.deepEqual(h, { width: 1800, height: 300, scale: 1 });
  assert.deepEqual(v, { width: 900, height: 600, scale: 1 });
});

test('vertical stays the default, so an indifferent caller gets the shipped behaviour', () => {
  const tiles = [{ width: 900, height: 300 }, { width: 900, height: 300 }];
  assert.deepEqual(computeCanvasSize(tiles), computeCanvasSize(tiles, 'vertical'));
});

// --- composeDirection: reading the join from the layout ---------------------------

test('a single row of parts joins left to right', () => {
  // Two images side by side: same vertical band, different horizontal.
  assert.equal(
    composeDirection([{ top: 100, bottom: 500 }, { top: 100, bottom: 500 }]),
    'horizontal',
  );
});

test('a single column of parts joins top to bottom', () => {
  assert.equal(
    composeDirection([{ top: 100, bottom: 500 }, { top: 500, bottom: 900 }]),
    'vertical',
  );
});

test('a 2x2 grid joins top to bottom, which is what the tap-to-see posts want', () => {
  // The rows do not overlap each other, so it is not a single row -- and the
  // original is a tall image cut into strips, not a grid to be rebuilt.
  assert.equal(
    composeDirection([
      { top: 100, bottom: 400 },
      { top: 100, bottom: 400 },
      { top: 400, bottom: 700 },
      { top: 400, bottom: 700 },
    ]),
    'vertical',
  );
});

test('parts that merely touch are not a row', () => {
  // A shared edge is zero overlap, and a zero-height band is not enough to call
  // two parts side by side.
  assert.equal(composeDirection([{ top: 0, bottom: 100 }, { top: 100, bottom: 200 }]), 'vertical');
});

test('says nothing when geometry cannot answer, rather than guessing', () => {
  assert.equal(composeDirection([{ top: 0, bottom: 10 }, null]), null);
  assert.equal(composeDirection([{ top: 0, bottom: 10 }]), null, 'one part is not a layout');
  assert.equal(composeDirection([]), null);
  assert.equal(composeDirection(undefined), null);
});

// --- tileBoxes: where each part actually lands ------------------------------------
//
// The placement, checked without a canvas. Before this was pure, nothing could tell
// a horizontal composite from a vertical one except a person looking at the output,
// which is exactly how the parts came out joined the wrong way.

const { tileBoxes } = loadCore();

test('a vertical stack accumulates downwards and centers across', () => {
  const tiles = [{ width: 400, height: 300 }, { width: 200, height: 100 }];
  const size = computeCanvasSize(tiles, 'vertical');
  assert.deepEqual(tileBoxes(tiles, size, 'vertical'), [
    { x: 0, y: 0, width: 400, height: 300 },
    { x: 100, y: 300, width: 200, height: 100 },
  ]);
});

test('a horizontal strip accumulates rightwards and centers down', () => {
  const tiles = [{ width: 400, height: 300 }, { width: 200, height: 100 }];
  const size = computeCanvasSize(tiles, 'horizontal');
  assert.deepEqual(tileBoxes(tiles, size, 'horizontal'), [
    { x: 0, y: 0, width: 400, height: 300 },
    { x: 400, y: 100, width: 200, height: 100 },
  ]);
});

test('the two directions place the same parts in different places', () => {
  const tiles = [{ width: 500, height: 200 }, { width: 500, height: 200 }];
  const v = tileBoxes(tiles, computeCanvasSize(tiles, 'vertical'), 'vertical');
  const h = tileBoxes(tiles, computeCanvasSize(tiles, 'horizontal'), 'horizontal');
  assert.deepEqual(v.map((b) => [b.x, b.y]), [[0, 0], [0, 200]], 'stacked');
  assert.deepEqual(h.map((b) => [b.x, b.y]), [[0, 0], [500, 0]], 'side by side');
});

test('boxes are drawn at the scale, never re-derived from the rounded canvas', () => {
  // The seam case: a total height over the cap, so scale < 1 and rounding the
  // canvas a second time would put a boundary a fraction of a pixel off.
  const tiles = Array(4).fill({ width: 1920, height: 4320 });
  const size = computeCanvasSize(tiles, 'vertical');
  const boxes = tileBoxes(tiles, size, 'vertical');
  for (let i = 0; i < boxes.length; i++) {
    assert.equal(boxes[i].height, 4320 * size.scale, `part ${i} drawn at the unscaled extent`);
  }
  assert.equal(boxes[3].y + boxes[3].height, 4320 * size.scale * 4);
});

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

test('passes a single tile through unscaled', () => {
  assert.deepEqual(computeCanvasSize([{ width: 800, height: 600 }]), { width: 800, height: 600, scale: 1 });
});

test('throws on an empty tile list', () => {
  assert.throws(() => computeCanvasSize([]), /empty/i);
});

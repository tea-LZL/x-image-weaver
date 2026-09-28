import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

test('core.js publishes a shared namespace', () => {
  const XIW = loadCore();
  assert.equal(typeof XIW, 'object');
  assert.ok(XIW, 'XIW namespace is reachable after evaluation');
});

test('core.js declares tunables with the spec values', () => {
  const { TUNABLES } = loadCore();
  assert.equal(TUNABLES.MAX_CANVAS_HEIGHT, 16000);
  assert.equal(TUNABLES.MAX_CANVAS_AREA, 250_000_000);
  assert.equal(TUNABLES.FETCH_TIMEOUT_MS, 20000);
  assert.equal(TUNABLES.JPEG_FALLBACK_QUALITY, 0.95);
});

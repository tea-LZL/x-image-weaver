import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, loadAll, manifestScripts } from './harness.mjs';

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

test('every manifest script parses and shares one XIW namespace', () => {
  // loadAll() evaluates each manifest script in order into a single context. A
  // SyntaxError or ReferenceError in any one of them propagates and fails this
  // test, with the offending file named by the vm stack frame.
  const XIW = loadAll();

  assert.equal(typeof XIW, 'object');
  assert.ok(XIW, 'XIW namespace survives the full load order');
  assert.ok(XIW.VERSION, 'VERSION set by core.js is not clobbered by a later script');
  assert.ok(XIW.TUNABLES, 'TUNABLES set by core.js is not clobbered by a later script');
});

test('main.js is the last content script', () => {
  const scripts = manifestScripts();
  assert.equal(scripts[scripts.length - 1], 'src/main.js');
  assert.equal(scripts[0], 'src/core.js', 'core.js must load first to define the namespace');
});

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
  // test, and harness.mjs re-throws it with the offending path in the message.
  const XIW = loadAll();

  assert.equal(typeof XIW, 'object');
  assert.ok(XIW, 'XIW namespace survives the full load order');
  assert.ok(XIW.VERSION, 'VERSION set by core.js is not clobbered by a later script');
  assert.ok(XIW.TUNABLES, 'TUNABLES set by core.js is not clobbered by a later script');
});

// The whole list, not the two ends of it. The manifest order *is* the dependency
// graph -- core.js defines the namespace every later script writes into, and
// main.js reads what the rest defined -- so pinning only the first and last
// entries let a swapped middle pair, or a deleted script, pass every other test
// in this file: they all still parse and still share one namespace.
test('content scripts are declared in dependency order', () => {
  assert.deepEqual(manifestScripts(), [
    'src/core.js',
    'src/dom.js',
    'src/button.js',
    'src/stitch.js',
    'src/overlay.js',
    'src/main.js',
  ]);
});

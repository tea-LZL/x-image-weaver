import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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

// The IIFE wrap has no automated detector anywhere else, and it is not a style
// rule: a top-level `var` or `function` in a classic content script becomes a
// property of the shared isolated-world global, so a same-named helper in a
// later file silently overwrites the earlier one with no error anywhere. This
// is the check that would have caught core.js and dom.js before they were
// wrapped by hand, and it covers all six scripts instead of just those two.
//
// Each script is evaluated alone into a fresh context, so "what did this file
// add" is measured rather than inferred. Nothing is shared with the tests above:
// those evaluate all six in order into this realm, where the harness's own
// `globalThis.XIW = {}` means `var XIW` binds to a property that already exists
// and adds nothing to diff.
//
// Only the loading of the file is checked, not its behavior -- `var XIW` reads
// the namespace off globalThis or creates it, and every other declaration in
// these files sits inside an IIFE that a later script cannot reach into.
test('no content script leaks anything but the XIW namespace to globalThis', () => {
  for (const path of manifestScripts()) {
    // A real context, not a plain object literal evaluated in this realm, so a
    // script's own `var` really does land on its global object and the diff
    // below sees it. An empty context: an unwrapped helper is visible whether or
    // not the scripts before it have run, and one script at a time means the
    // failure names the file that leaked.
    const context = vm.createContext({});
    const before = new Set(Object.getOwnPropertyNames(context));

    vm.runInContext(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), context, { filename: path });

    const added = Object.getOwnPropertyNames(context).filter((name) => !before.has(name));
    // Sorted and compared as a set-valued list: the assertion is about which
    // names escaped, not about the order a script happened to declare them in.
    assert.deepEqual(
      added.sort(),
      ['XIW'],
      `${path} must declare nothing at the top level but the XIW namespace, found: ${added.join(', ') || 'nothing'}`
    );
  }
});

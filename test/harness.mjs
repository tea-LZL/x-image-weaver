import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

// The script list the manifest declares, in the order Chrome would inject them.
// Read from the manifest so a test can never drift from what the extension ships.
export function manifestScripts() {
  return JSON.parse(readRepoFile('manifest.json')).content_scripts[0].js;
}

// Chrome evaluates every content script of an extension into one isolated world,
// in manifest order. Mirroring that here is the point: a namespace that only
// survives a single file proves nothing about the six-file case.
//
// They are evaluated in this realm rather than in a synthetic vm sandbox, which
// is the closer simulation (one real global, one shared namespace) and keeps the
// values they return ordinary main-realm objects. That matters for assertions:
// `assert.deepEqual` from `node:assert/strict` is `deepStrictEqual` and compares
// prototypes, so a sandbox-realm array or object never equals a same-realm
// literal no matter how equal the contents are.
function evaluateScripts(paths, globals) {
  mergeGlobals(globals);
  // Each call starts from an empty namespace, as the previous fresh sandbox per
  // call did, so module state loaded by one test cannot leak into the next test
  // in the same file.
  globalThis.XIW = {};
  for (const path of paths) {
    try {
      vm.runInThisContext(readRepoFile(path), { filename: path });
    } catch (err) {
      // vm names the file in a SyntaxError's stack header but not in its
      // message, and every stack frame is a node:vm internal, so the stack alone
      // does not say which script is broken. Re-throw with the path in the
      // message or a bad stub in src/ is unactionable in test output.
      throw new Error(`content script ${path} failed to evaluate: ${err.message}`, { cause: err });
    }
  }
  return globalThis.XIW;
}

// A content script finds host globals in a browser that this process does not
// have -- `document`, for one, which main.js reads at load time. A caller can
// merge the ones it needs in before evaluation instead of the harness having to
// grow a new entry point per script. They stay merged for the rest of the
// process, so a later load in the same test file sees the same ones.
function mergeGlobals(globals) {
  for (const [key, value] of Object.entries(globals || {})) {
    globalThis[key] = value;
  }
}

export function loadCore(globals) {
  return evaluateScripts(['src/core.js'], globals);
}

export function loadAll(globals) {
  return evaluateScripts(manifestScripts(), globals);
}

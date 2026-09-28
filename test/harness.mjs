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
function evaluateInSharedContext(paths) {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const path of paths) {
    try {
      vm.runInContext(readRepoFile(path), sandbox, { filename: path });
    } catch (err) {
      // vm's SyntaxError stack points at node:vm internals, not the script, so
      // the filename is lost. Re-throw with the path in the message, or a bad
      // stub in src/ is unactionable in test output.
      throw new Error(`content script ${path} failed to evaluate: ${err.message}`, { cause: err });
    }
  }
  return sandbox.XIW;
}

export function loadCore() {
  return evaluateInSharedContext(['src/core.js']);
}

export function loadAll() {
  return evaluateInSharedContext(manifestScripts());
}

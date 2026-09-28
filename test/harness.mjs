import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadCore() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../src/core.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.XIW;
}

#!/usr/bin/env node
// Guards the places a release version can drift out of step.
//
// The extension has no build step, so there is no artifact declaring a version:
// `manifest.json` and `XIW.VERSION` in `src/core.js` each carry one by hand, and
// a release adds a third copy in the git tag. `package.json` carries a fourth for
// npm's benefit even though the package is never published. Nothing else in the
// repository couples them, and a mismatch ships silently -- Chrome reports the
// manifest's version in chrome://extensions, so a stale `XIW.VERSION` is
// invisible to a user and a stale tag is invisible to everyone.
//
// Usage:
//   node scripts/verify-release-version.mjs              # all in-repo copies
//   node scripts/verify-release-version.mjs v0.2.0       # and against the tag
//
// The argument is optional so the same script can run as a cheap consistency
// check on every push, not only at tag time.

import { readFileSync } from 'node:fs';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const tag = process.argv[2] ?? null;
// A leading `v` is convention, not part of the version. `v0.2.0` and `0.2.0` name
// the same release, and both are accepted as tags.
const expected = tag === null ? null : tag.replace(/^v/, '');

const manifest = JSON.parse(read('manifest.json')).version;
const npm = JSON.parse(read('package.json')).version;

// Read rather than import: src/core.js is a classic content script, not a module,
// and it writes to globalThis rather than exporting. A regex over the assignment
// is the whole parse. The quote style is pinned by the file's own house style,
// and a formatting change here fails loudly rather than silently reading null.
const coreSource = read('src/core.js');
const coreMatch = /^\s*XIW\.VERSION\s*=\s*'([^']+)'\s*;\s*$/m.exec(coreSource);
const core = coreMatch === null ? null : coreMatch[1];

const problems = [];

// Always: every in-repo copy must agree.
if (core === null) {
  problems.push("src/core.js has no readable `XIW.VERSION = '...';` assignment");
} else if (core !== manifest) {
  problems.push(`manifest.json says ${manifest} but src/core.js says ${core}`);
}
if (npm !== manifest) {
  problems.push(`manifest.json says ${manifest} but package.json says ${npm}`);
}

// Only when a tag was given: the tag must name the same release.
if (expected !== null) {
  if (manifest !== expected) problems.push(`tag says ${expected} but manifest.json says ${manifest}`);
  if (core !== null && core !== expected) problems.push(`tag says ${expected} but src/core.js says ${core}`);
  if (npm !== expected) problems.push(`tag says ${expected} but package.json says ${npm}`);
}

if (problems.length > 0) {
  const what = expected === null ? 'Version mismatch' : `Tag ${tag} does not match the extension`;
  console.error(`${what}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    expected === null
      ? '\nSet all three to the same version.'
      : `\nSet all three to ${expected}, commit, then re-tag.`,
  );
  process.exit(1);
}

console.log(
  expected === null
    ? `version ${manifest} agrees across manifest.json, package.json, and src/core.js`
    : `version ${expected} agrees across the tag, manifest.json, package.json, and src/core.js`,
);

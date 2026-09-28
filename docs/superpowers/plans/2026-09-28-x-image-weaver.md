# X Image Weaver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zero-permission MV3 Chrome extension that adds a "Merge" button to every X post with 2+ image attachments, stitches the parts top-to-bottom at original quality, and shows the result in a full-screen overlay with a download button.

**Architecture:** Content script only — no service worker, no background, no options page, no build step. Six classic scripts in one isolated world share a `globalThis.XIW` namespace, with manifest array order as the dependency graph. DOM extraction and canvas composition are kept in separate files so neither can reach the other's concerns; `core.js` holds the pure functions and is the only file unit-tested without a DOM.

**Tech Stack:** Vanilla JavaScript, Chrome Manifest V3, Canvas 2D, `createImageBitmap`, Shadow DOM. Tests: Node 22 built-in `node:test` runner, plus jsdom as the only devDependency. No bundler, no framework, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-x-image-weaver-design.md` — read it before starting. This plan implements it; where the two disagree, the spec is wrong and should be corrected.

## Global Constraints

- Manifest declares `"permissions": []` and `"host_permissions": []`. Zero. Nothing in any task may add a permission.
- `"minimum_chrome_version": "103"`, required by `AbortSignal.timeout`.
- Content script matches: `https://x.com/*`, `https://*.x.com/*`, `https://twitter.com/*`. Run at `document_idle`.
- Script load order in `manifest.json` is exactly: `core.js`, `dom.js`, `button.js`, `stitch.js`, `overlay.js`, `main.js`. `main.js` must be last.
- Every source file's first line is `var XIW = (globalThis.XIW = globalThis.XIW || {});`. Never `const XIW` — `const` redeclaration across classic scripts throws.
- Parts are **always** stacked top-to-bottom in X's DOM order. No grid mode, no reordering, no de-duplication, no auto-detection.
- Media IDs are re-collected at click time, never cached from injection time.
- The overlay must use Shadow DOM. It is not a style preference — X's global CSS corrupts injected elements.
- `node_modules/` and any packaging output are never committed to the extension's shipped file set. Add `.gitignore` in Task 1.
- Comments: match the surrounding code. The codebase is new, so default to no comments except where a non-obvious constraint needs naming (e.g. why the button is not a child of `tweetPhoto`).

## Review Focus

Five input classes or failure modes the spec implies that no naive test would catch, most likely to bite first:

1. **Mixed media (1 photo + 1 video in the same post).** A user expects no button and no partial composite, not a merge of just the photo. `collectPhotoIds` must return `null`. Test in Task 3.
2. **Quoted tweet whose inner post has its own 2 photos.** A user expects exactly one button, on the inner post, merging the inner post's images — not two buttons, and not a composite that mixes outer and inner media. Test in Task 3.
3. **X's `overflow: hidden` on `tweetPhoto` silently clips the button.** A user sees no button at all on any post and has no idea why. The button must be a child of the media row, never of a photo container. This one **cannot be automated** — jsdom has no layout engine, so clipping is not assertable. It is pinned as an explicit written constraint in Task 6 Step 3 and verified in the Task 8 checklist.
4. **A composite that exceeds the canvas height cap** (4 very tall parts, e.g. 1920×4320 each). A user expects a slightly downscaled but still perfectly viewable image, never a blank canvas or a crash. Test in Task 2, geometry.
5. **`toBlob` returns `null` under memory pressure** on a very large composite, silently producing a JPEG instead of a PNG. A user expects a file anyway, and expects it named `.jpg` rather than `.png`. The filename computation is pure, so it is extracted into `XIW.downloadFilename` and tested in Task 2; the `null`-return path itself is manual-only, since it needs a real canvas under real memory pressure.

---

### Task 1: Extension skeleton, namespace, and load-time smoke test

**Files:**
- Create: `manifest.json`
- Create: `src/core.js` (namespace, `VERSION`, and `TUNABLES`; the pure helpers arrive in Task 2)
- Create: `src/dom.js`, `src/button.js`, `src/stitch.js`, `src/overlay.js`, `src/main.js`
  (one-line namespace stubs, each replaced by a later task)
- Create: `test/harness.mjs`
- Create: `test/loader.test.mjs`
- Create: `.gitignore`
- Create: `icons/16.png`, `icons/48.png`, `icons/128.png`

**Interfaces:**
- Consumes: nothing.
- Produces: the `globalThis.XIW` namespace shared across all six content scripts, holding `XIW.VERSION` and `XIW.TUNABLES`. Task 2 adds `XIW.SELECTORS`, `XIW.mediaIdFromUrl`, and `XIW.computeCanvasSize` to the same object.

- [ ] **Step 1: Write the failing loader test**

`test/harness.mjs` exposes the one way any test may load extension source:

```js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadCore() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../src/core.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.XIW;
}
```

`test/loader.test.mjs` asserts the namespace survives a `vm` evaluation, which is the closest
available proxy for two classic scripts sharing one isolated world:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/*.test.mjs`
Expected: FAIL — `ENOENT` on `src/core.js`, which does not exist yet.

- [ ] **Step 3: Create `src/core.js` with the namespace and tunables**

First line is exactly the `var` namespace line from Global Constraints. Then `XIW.VERSION = '0.1.0'` and `XIW.TUNABLES` holding the four constants the test names. No other content yet.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Create the five not-yet-implemented source files as stubs**

`manifest.json` names all six scripts, and Chrome refuses to load a content script whose
file is missing — so every commit from this one forward must have all six present. Create
`src/dom.js`, `src/button.js`, `src/stitch.js`, `src/overlay.js`, and `src/main.js`, each
containing nothing but the `var XIW` namespace line and a one-line comment naming the task
that implements it.

Each later task **replaces** its stub wholesale. A stub that survives into a final review
is a defect: a stub in `src/main.js` means the extension silently does nothing.

- [ ] **Step 6: Create `manifest.json`**

Exactly the manifest in the spec's "Manifest and permissions" section, verbatim, including
`minimum_chrome_version` and the empty permission arrays. Do not add `"default_popup"`.

- [ ] **Step 7: Create the three icon PNGs**

Solid-color square PNGs at 16, 48, and 128. Any generator will do; they are placeholders that
satisfy the manifest so Chrome does not warn on load. Do not spend time on artwork.

- [ ] **Step 8: Create `.gitignore`**

```
node_modules/
```

- [ ] **Step 9: Verify Chrome accepts the package**

Run: `ls -R .` and confirm `manifest.json`, `src/`, `icons/`, `test/`, `docs/` all exist and
that `manifest.json` parses as JSON (`node -e "JSON.parse(require('fs').readFileSync('manifest.json'))"` — expect no output and exit 0).

Then confirm every script the manifest names actually exists:

Run: `node -e "const m=JSON.parse(require('fs').readFileSync('manifest.json'));const fs=require('fs');for(const p of m.content_scripts[0].js){if(!fs.existsSync(p))throw new Error('missing '+p)};console.log('all scripts present')"`
Expected: prints `all scripts present`. This is the gate that Task 1 would otherwise fail
Chrome's loader on.

- [ ] **Step 10: Commit**

```bash
git add manifest.json src/core.js src/dom.js src/button.js src/stitch.js src/overlay.js src/main.js test/harness.mjs test/loader.test.mjs .gitignore icons/
git commit -m "chore: extension skeleton with shared XIW namespace and manifest"
```

---

### Task 2: Pure helpers — `mediaIdFromUrl` and `computeCanvasSize`

**Files:**
- Modify: `src/core.js`
- Create: `test/media-id.test.mjs`
- Create: `test/canvas-size.test.mjs`

**Interfaces:**
- Consumes: `loadCore()` from `test/harness.mjs`; `XIW.TUNABLES` from Task 1.
- Produces:
  - `XIW.SELECTORS` — the selector map from the spec's DOM contract table.
  - `XIW.mediaIdFromUrl(raw) → string | null`
  - `XIW.computeCanvasSize(tiles) → { width, height, scale }` where `tiles` is
    `Array<{ width: number, height: number }>` in draw order. Throws on an empty array.
  - `XIW.downloadFilename(meta, format) → string` where `meta` is `{ tweetId, handle }` and
    `format` is `'image/png'` or `'image/jpeg'`.

- [ ] **Step 1: Write the failing `mediaIdFromUrl` tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const { mediaIdFromUrl } = loadCore();

test('extracts an id from a full-size URL', () => {
  assert.equal(
    mediaIdFromUrl('https://pbs.twimg.com/media/dQw4w9WgXcQ?format=jpg&name=orig'),
    'dQw4w9WgXcQ',
  );
});

test('extracts an id from a thumbnail URL with a size query', () => {
  assert.equal(
    mediaIdFromUrl('https://pbs.twimg.com/media/abc123XYZ_-9?format=jpg&name=medium'),
    'abc123XYZ_-9',
  );
});

test('rejects a non-pbs host', () => {
  assert.equal(mediaIdFromUrl('https://example.com/media/dQw4w9WgXcQ?format=jpg'), null);
});

test('rejects a pbs path that is not /media/<id>', () => {
  assert.equal(mediaIdFromUrl('https://pbs.twimg.com/extensions/abc/img/foo.jpg'), null);
});

test('rejects empty and malformed input', () => {
  assert.equal(mediaIdFromUrl(''), null);
  assert.equal(mediaIdFromUrl('not a url'), null);
});
```

Note the third test is why the spec's original regex was wrong: a bare
`/media/([A-Za-z0-9_-]+)/` match would happily accept `example.com`. Host check is required.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/media-id.test.mjs`
Expected: FAIL — `mediaIdFromUrl` is undefined.

- [ ] **Step 3: Implement `mediaIdFromUrl` in `src/core.js`**

`new URL(raw)` inside try/catch, returning `null` if it throws. Require
`url.hostname === 'pbs.twimg.com'`, then match `/^\/media\/([A-Za-z0-9_-]+)$/` against
`url.pathname` and return the capture or `null`. Note X's media URLs have **no** trailing
slash after the ID — the query string follows directly — so anchoring on `$` against the
pathname is what makes this correct.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/media-id.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing `computeCanvasSize` tests**

```js
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
```

The area-cap case is the one that cannot be reached by hand and is the reason this function
is pure and tested: height alone is capped at 16000, so a very wide composite is the only
way to breach the area limit.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test test/canvas-size.test.mjs`
Expected: FAIL — `computeCanvasSize` is undefined.

- [ ] **Step 7: Implement `computeCanvasSize` in `src/core.js`**

Derive `scale` **before** computing pixel dimensions, exactly as the spec's Stitch pipeline
step 4 states: start at 1, reduce to `MAX_CANVAS_HEIGHT / totalHeight` if the height cap is
breached, compute `width`/`height` by rounding, then if `width * height > MAX_CANVAS_AREA`
multiply `scale` by `MAX_CANVAS_AREA / (width * height)` and recompute both. Throws
`TypeError` with a message containing "empty" when `tiles` is empty.

- [ ] **Step 8: Write the failing `downloadFilename` tests**

This function is pure and exists so Review Focus item 5 is pinned by an automated test
rather than by inspection. Create `test/filename.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const { downloadFilename } = loadCore();

test('uses a .png extension for a PNG composite', () => {
  assert.equal(
    downloadFilename({ handle: 'ada', tweetId: '98765' }, 'image/png'),
    'x-image-weaver-ada-98765.png',
  );
});

test('follows a JPEG fallback to a .jpg extension', () => {
  assert.equal(
    downloadFilename({ handle: 'ada', tweetId: '98765' }, 'image/jpeg'),
    'x-image-weaver-ada-98765.jpg',
  );
});

test('degrades to unknown handle and id rather than producing a broken name', () => {
  assert.equal(
    downloadFilename({ handle: '', tweetId: '' }, 'image/png'),
    'x-image-weaver-unknown-unknown.png',
  );
});

test('strips path-hostile characters from the handle', () => {
  assert.equal(
    downloadFilename({ handle: '../etc', tweetId: '1/2' }, 'image/png'),
    'x-image-weaver-etc-12.png',
  );
});
```

The third and fourth tests pin that a malformed download name can never occur, because the
handle is scraped from a web page.

- [ ] **Step 9: Run the tests to verify they fail**

Run: `node --test test/filename.test.mjs`
Expected: FAIL — `downloadFilename` is undefined.

- [ ] **Step 10: Implement `downloadFilename` in `src/core.js`**

Map `'image/png'` → `'png'` and `'image/jpeg'` → `'jpg'`, defaulting to `'png'`. Empty or
absent `handle` and `tweetId` become `unknown`. Sanitize both by replacing every character
outside `[A-Za-z0-9_-]` with `''`, which collapses `../etc` to `etc` and `1/2` to `12` and
leaves normal handles untouched.

- [ ] **Step 11: Add `XIW.SELECTORS` to `src/core.js`**

The selector map from the spec's DOM contract table, verbatim: `tweet`,
`quoteTweet`, `tweetPhoto`, `videoPlayer`.

- [ ] **Step 12: Run the full suite to verify everything passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, all tests across all four test files.

- [ ] **Step 13: Commit**

```bash
git add src/core.js test/media-id.test.mjs test/canvas-size.test.mjs test/filename.test.mjs
git commit -m "feat: pure media-id, canvas-geometry, and download-name helpers with tests"
```

---

### Task 3: DOM extraction — `collectPhotoIds` and `tweetMeta`

**Files:**
- Modify: `package.json` (add devDependency jsdom)
- Create: `src/dom.js`
- Create: `test/dom.test.mjs`
- Create: `test/fixtures.mjs`

**Interfaces:**
- Consumes: `XIW.SELECTORS` and `XIW.mediaIdFromUrl` from Task 2.
- Produces:
  - `XIW.collectPhotoIds(root) → string[] | null` — the root's own media IDs in DOM order,
    or `null` when the post is not a mergeable gallery. Pure read, no side effects.
  - `XIW.tweetMeta(root) → { tweetId: string, handle: string }`.

- [ ] **Step 1: Add jsdom as a devDependency**

Run: `npm install --save-dev jsdom`

This is the only dependency in the project and it never ships. Do not add a `dependencies`
block, a bundler, or a `scripts` entry that does anything but run tests.

- [ ] **Step 2: Write the fixture builder**

`test/fixtures.mjs` exports:

```js
export function tweetFixture({ photos = [], videos = 0, quote = null, tweetId = '123', handle = 'someone' } = {})
```

It returns a jsdom `document` containing one
`article[data-testid="tweet"]`. `photos` is an array of media IDs — when an entry is `null`
the photo element gets no `src` and only an inline `style="background-image:url(...)"`, and
when an entry is the string `'bad'` the element gets an `src` that does not parse to a media
ID. `videos` adds that many `[data-testid="videoPlayer"]` siblings. `quote` is either
`false` for none or a nested spec object handed to the same builder and inserted as
`div[data-testid="quoteTweet"]` inside the outer article. Include a
`a[href*="/status/<tweetId>"]` and a `[data-testid="User-Name"]` containing `@<handle>` so
`tweetMeta` has something to read.

- [ ] **Step 3: Write the failing tests**

First add `loadDom()` to `test/harness.mjs`. It must evaluate `src/core.js` **and**
`src/dom.js` into the **same** `vm` context, because in production they are classic scripts
sharing one isolated-world `globalThis` and `dom.js` reads `XIW.mediaIdFromUrl` from it.
Factor the shared sandbox setup so `loadCore()` and `loadDom()` differ only in the file list:

```js
export function loadDom() {
  return loadScripts(['../src/core.js', '../src/dom.js']);
}
```

Then `test/dom.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { tweetFixture } from './fixtures.mjs';
import { loadDom } from './harness.mjs';

const { collectPhotoIds, tweetMeta } = loadDom();
const first = (doc) => doc.querySelector('article[data-testid="tweet"]');

test('returns ids for a two-image post', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'bbb']);
});

test('preserves order for a four-image post', () => {
  const doc = tweetFixture({ photos: ['one', 'two', 'three', 'four'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['one', 'two', 'three', 'four']);
});

test('returns null for a single image', () => {
  const doc = tweetFixture({ photos: ['only'] });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('returns null for a post with no media', () => {
  const doc = tweetFixture({ photos: [] });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('returns null when a video is mixed in with photos', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], videos: 1 });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('returns null for a video-only post', () => {
  const doc = tweetFixture({ photos: [], videos: 1 });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('falls back to background-image when src is absent', () => {
  const doc = tweetFixture({ photos: [null, 'bbb'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'bbb']);
});

test('returns null when any photo fails to parse', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bad'] });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('preserves duplicate ids', () => {
  const doc = tweetFixture({ photos: ['aaa', 'aaa'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'aaa']);
});

test('attributes quoted media to the inner root only', () => {
  const doc = tweetFixture({ photos: [], quote: { photos: ['inner1', 'inner2'] } });
  const outer = doc.querySelector('article[data-testid="tweet"]');
  const inner = doc.querySelector('div[data-testid="quoteTweet"] article[data-testid="tweet"]');
  assert.equal(collectPhotoIds(outer), null);
  assert.deepEqual(collectPhotoIds(inner), ['inner1', 'inner2']);
});

test('reads tweetId and handle from the permalink and display name', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], tweetId: '98765', handle: 'ada' });
  assert.deepEqual(tweetMeta(first(doc)), { tweetId: '98765', handle: 'ada' });
});
```

The mixed-media and quote tests are Review Focus items 1 and 2.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test test/dom.test.mjs`
Expected: FAIL — `src/dom.js` does not exist.

- [ ] **Step 5: Implement `src/dom.js`**

First line is the `var XIW` namespace line. Then:

- `collectPhotoIds(root)`: query `XIW.SELECTORS.tweetPhoto` under `root` and filter out any
  element that is quoted by a `[data-testid="quoteTweet"]` wrapper **strictly below `root`**.
  Use `quote !== root && root.contains(quote)` on the element's `closest(quoteTweet)`, not
  `contains` alone: `Node.contains` is an *inclusive* descendant test, so `contains(root)`
  is true when `root` is the `quoteTweet` div itself, and every own element would be
  discarded — making both exports return empty for a root type the spec names. Same treatment
  for `videoPlayer`. Return `null` on any video, on fewer than two photos, or if any photo
  fails to yield an id via the fallback chain `img.currentSrc` → `img.src` → first descendant
  with a non-empty inline `background-image`. For the background fallback, extract the URL
  from between the `url(` and the closing `)`. Preserve order and duplicates; do not use a Set.
- `tweetMeta(root)`: apply the same own-elements filter to both lookups, so a quoted post's
  handle and tweetId cannot leak into the outer post. `root.querySelector` searches the whole
  subtree and will otherwise return the quoted post's values.
- `tweetMeta(root)`: read the tweet ID from the first `a[href*="/status/"]` match via
  `/\/status\/(\d+)/`. Read the handle from the **profile anchor's href** inside
  `[data-testid="User-Name"]`, not from that element's `textContent` — X renders the cell as
  display name and `@handle` concatenated in one element, so textContent yields
  `AdaLovelace@ada`. Match `a[href^="/"]` whose href is a bare profile path
  (`^\/[A-Za-z0-9_]{1,15}$`, X's handle grammar) so the `/status/` permalink and
  `/i/user/` routes are excluded, and take the last path segment. Return
  `{ tweetId, handle }` with empty strings for whatever cannot be found — the filename
  degrades, but the download must not throw.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/*.test.mjs`
Expected: PASS, all tests including every case in `dom.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/dom.js test/dom.test.mjs test/fixtures.mjs test/harness.mjs
git commit -m "feat: DOM extraction of mergeable media ids with jsdom tests"
```

---

### Task 4: Canvas composition — `stitchVertical`

**Files:**
- Create: `src/stitch.js`

**Interfaces:**
- Consumes: `XIW.TUNABLES` and `XIW.computeCanvasSize` from Task 2.
- Produces:
  - `XIW.StitchError` — `Error` subclass carrying a `code` of `'NETWORK'` or `'DECODE'`.
  - `XIW.stitchVertical(mediaIds) → Promise<{ blob, format }>` where `format` is
    `'image/png'` or `'image/jpeg'`. Rejects with a `StitchError` on failure.

No automated test task exists for this file. Per the spec's Testing section, `createImageBitmap`
and canvas are not modeled by jsdom, so this is covered by the Task 8 manual checklist. The
implementer should still keep the composition arithmetic in a form that mirrors
`computeCanvasSize` exactly, so a reader can check the two agree.

- [ ] **Step 1: Write the JSDoc contract at the top of `src/stitch.js`**

No behavior test first. `createImageBitmap` and canvas are not modeled by jsdom, so per the
spec's Testing section this file's coverage is the Task 8 checklist. Write the JSDoc
contract before the body so Task 6 can code against the signature without reading the
implementation: the two exported names, their parameter and return types, and the two
`StitchError` codes, exactly as stated in Interfaces.

- [ ] **Step 2: Implement `XIW.StitchError`**

A subclass of `Error` that stores `this.code`. Two codes only: `NETWORK` for a rejected
fetch, a non-OK status, or an `AbortSignal.timeout`; `DECODE` for `createImageBitmap` failing
and the `Image` + `decode()` fallback also failing. Exceeding the canvas caps is **not** an
error — it is a silent downscale.

- [ ] **Step 3: Implement the fetch-and-decode stage**

Map each id to `https://pbs.twimg.com/media/${id}?name=orig`. `Promise.all` over a per-image
`fetch` with `signal: AbortSignal.timeout(XIW.TUNABLES.FETCH_TIMEOUT_MS)` and
`cache: 'force-cache'`. Non-OK status rejects with `StitchError('NETWORK')`. Decode via
`createImageBitmap(blob)`, falling back to `new Image()` with `src = URL.createObjectURL(blob)`
plus `await img.decode()`. On decode failure of both paths, reject with
`StitchError('DECODE')`.

- [ ] **Step 4: Implement the draw stage**

Call `XIW.computeCanvasSize(tiles)`. Create the canvas at the returned `width`/`height`.
`fillStyle = '#fff'` and fill the whole canvas so a JPEG export is valid and no page
background shows through. Then walk the tiles in order, drawing each at
`tile.width * scale` by `tile.height * height`, at `x = (canvas.width - drawWidth) / 2` and
the running `y`. Call `ImageBitmap.close()` on each tile immediately after drawing it —
unreleased bitmaps are a real leak over a long scroll session.

- [ ] **Step 5: Implement the encode stage**

`toBlob('image/png')`. If the callback receives `null`, retry once with
`toBlob('image/jpeg', XIW.TUNABLES.JPEG_FALLBACK_QUALITY)`. Resolve `{ blob, format }` with
whichever encoding succeeded. If the JPEG retry also yields `null`, reject with
`StitchError('DECODE')`.

- [ ] **Step 6: Verify the file parses and the namespace is well-formed**

Run: `node --test test/*.test.mjs && node -e "new (require('vm').Script)(require('fs').readFileSync('src/stitch.js','utf8'))"`
Expected: all tests still PASS and no `SyntaxError` from the second command. This is a
syntax gate, not a behavior test — say so in the commit body.

- [ ] **Step 7: Commit**

```bash
git add src/stitch.js
git commit -m "feat: fetch, decode, and vertically composite media into one image"
```

---

### Task 5: Overlay viewer, download, and error state

**Files:**
- Create: `src/overlay.js`

**Interfaces:**
- Consumes: `XIW.downloadFilename` (Task 2) for the filename. No other dependencies —
  notably this file does **not** need `XIW.TUNABLES`, since the JPEG quality is applied at
  encode time in `stitch.js`.
- Produces:
  - `XIW.overlay.show({ blob, format, meta })` — `meta` is the `{ tweetId, handle }` from
    `XIW.tweetMeta`.
  - `XIW.overlay.showError(err, onRetry)` — `err` is a `XIW.StitchError`.
  - `XIW.overlay.hide()`

- [ ] **Step 1: Write `src/overlay.js`**

No test. Shadow DOM is mandatory: build a single lazily-created host on first `show()`,
`document.body.appendChild`, `attachShadow({ mode: 'open' })`, and reuse it forever. Mark it
`data-xiw-overlay` so tests and debugging can find it.

- [ ] **Step 2: Implement the success view**

Backdrop `rgba(0, 0, 0, 0.92)`, image `object-fit: contain` at `max-height: 92vh` and
`max-width: 92vw`. Object URL from `URL.createObjectURL(blob)`, **revoking the previous URL
before creating a new one**. A `✕` control and a single `Download` button.

- [ ] **Step 3: Implement the download**

Synthetic `<a href=objectUrl download=filename>` with `.click()`. The extension **must not**
call `chrome.downloads` — the manifest declares no permissions, and this is why. The
filename comes from `XIW.downloadFilename(meta, format)`, so the extension follows the
encoding that actually succeeded rather than the one that was requested. This is Review
Focus item 5.

- [ ] **Step 4: Implement close behavior**

Close on `✕`, on `Escape` via a `keydown` listener added on open and removed on close, and
on a click whose target is the backdrop. Save and restore `document.body.style.overflow`
around the open/close cycle.

- [ ] **Step 5: Implement the error view**

`showError(err, onRetry)` renders the message plus a `Retry` button wired to `onRetry`. On
error, do **not** revoke the previous successful object URL — the user may still be looking
at a prior composite when a second merge fails. `onRetry` is invoked from the click handler
only, which preserves the user-gesture requirement.

- [ ] **Step 6: Add a syntax and namespace gate**

Run: `node --test test/*.test.mjs && node -e "new (require('vm').Script)(require('fs').readFileSync('src/overlay.js','utf8'))"`
Expected: tests PASS, no `SyntaxError`.

- [ ] **Step 7: Commit**

```bash
git add src/overlay.js
git commit -m "feat: shadow-DOM overlay with download and retry on failure"
```

---

### Task 6: Button injection

**Files:**
- Create: `src/button.js`

**Interfaces:**
- Consumes: `XIW.SELECTORS` (Task 2), `XIW.collectPhotoIds` and `XIW.tweetMeta` (Task 3),
  `XIW.stitchVertical` (Task 4), `XIW.overlay` (Task 5).
- Produces: `XIW.button.mount(root) → void`

- [ ] **Step 1: Write the JSDoc contract at the top of `src/button.js`**

No test. All of this file's correctness is DOM-placement behavior that jsdom does not model,
so it is covered by the Task 8 checklist. Write the JSDoc contract first, stating
`XIW.button.mount(root) → void`, that it must be a no-op when `root` has no
`data-xiw-done` marker handling in `main.js` and when `collectPhotoIds` returns `null`, and
that it must re-collect IDs at click time. Then the three constraints below — the implementer
cannot infer any of them from the code, and each one is a way the extension silently fails.

- [ ] **Step 2: Decide mergeability by calling `collectPhotoIds` at mount time**

`const ids = XIW.collectPhotoIds(root)`. If `null`, return without touching the DOM. The
button appears on any post with 2+ photos, including ordinary multi-photo posts that are
not split images at all. That is the deliberate tradeoff of per-post opt-in: the user
decides, and no false positive can damage a post.

- [ ] **Step 3: Place the button on the media row, never inside a photo container**

Find the row as the shared parent of the post's own `[data-testid="tweetPhoto"]` elements —
the first photo's `parentElement` — and append the button there. Do **not** append into a
photo container: X sets `overflow: hidden` on `tweetPhoto` to crop the media, so a button
placed inside it is clipped and the user sees no button at all with no way to diagnose it.
This is Review Focus item 3. Set `row.style.position = 'relative'` if it is not already
positioned.

- [ ] **Step 4: Style and mount the button**

A real `<button type="button">` with `aria-label="Merge images into one"`, a `Merge` text
label, and `position: absolute; top: 8px; right: 8px` within the row. Default
`opacity: 0`; reveal on row hover or on the button's own `focus-within`, via a `transition:
opacity 0.12s` and a CSS rule scoped to the row class this extension adds.

- [ ] **Step 5: Wire the click handler**

On click: `event.preventDefault()` and `stopPropagation()` so X's own click handler does not
open the media viewer as well. Then **re-collect** — `const ids = XIW.collectPhotoIds(root)`
— and if it returns `null`, return silently, because React may have swapped the media since
mount. Otherwise show a busy state on the button, await `XIW.stitchVertical(ids)`, then
`XIW.overlay.show({ blob, format, meta: XIW.tweetMeta(root) })`. On rejection,
`XIW.overlay.showError(err, retry)` where `retry` re-runs the same handler body. Always
clear the busy state, including on rejection.

- [ ] **Step 6: Run the automated suite**

Run: `node --test test/*.test.mjs`
Expected: PASS. This file adds no tests; the run confirms nothing regressed.

- [ ] **Step 7: Commit**

```bash
git add src/button.js
git commit -m "feat: inject merge button on the media row with click-to-composite"
```

---

### Task 7: Observer bootstrap

**Files:**
- Create: `src/main.js`

**Interfaces:**
- Consumes: `XIW.button.mount` (Task 6), `XIW.SELECTORS` (Task 2).
- Produces: nothing. This is the last-loaded script and starts the extension.

- [ ] **Step 1: Write `scan(root)`**

Find roots with `root.matches(SELECTOR_ALL)` plus `root.querySelectorAll(SELECTOR_ALL)`,
where the composed selector is `article[data-testid="tweet"], div[data-testid="quoteTweet"]`.
The `matches` call is required so a single tweet added directly to the DOM as the observed
node is not skipped. For each root, skip it if `root.dataset.xiwDone` is set, otherwise set
that attribute and call `XIW.button.mount(root)`.

- [ ] **Step 2: Set up the MutationObserver**

Observe `document.body` with `{ childList: true, subtree: true }`. On a callback, push each
`addedNodes` entry into a module-level `Set`, then schedule a single
`requestAnimationFrame` drain. The `Set` dedupes the many nodes React adds in one commit and
the rAF coalesces bursts, so a fast scroll does not trigger a scan per node. The drain calls
`scan` on each remaining node and clears the set. Handle the case where `document.body` does
not exist yet by waiting for `DOMContentLoaded`.

- [ ] **Step 3: Run the initial scan**

Call `scan(document.body)` once at startup to cover tweets already on screen before the
observer attached, then start observing.

- [ ] **Step 4: Confirm the script array order in `manifest.json`**

Run: `node -e "const m=JSON.parse(require('fs').readFileSync('manifest.json'));const j=m.content_scripts[0].js;if(j[j.length-1]!=='src/main.js')throw new Error('main.js must be last: '+j);console.log(j.join(' '))"`
Expected: prints the six scripts in order with `src/main.js` last.

- [ ] **Step 5: Run the automated suite**

Run: `node --test test/*.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: rAF-coalesced mutation observer discovers tweets on every surface"
```

---

### Task 8: README, manual verification checklist, and end-to-end check

**Files:**
- Create: `README.md`
- Modify: `manifest.json` (version bump only)

**Interfaces:**
- Consumes: every prior task. No new code.
- Produces: nothing consumed by later tasks. This is the gate for the whole plan.

- [ ] **Step 1: Write `README.md`**

Three sections: what the extension does; how to load it unpacked (`chrome://extensions` →
Developer mode → Load unpacked → select the repo root, then reload after every edit); and
the manual verification checklist below.

- [ ] **Step 2: Copy the manual verification checklist into the README**

Take the checklist verbatim from the spec's Testing section. It is the only coverage for the
MutationObserver, React re-rendering, canvas drawing, the overlay, and the download path, so
it must be written out rather than linked.

- [ ] **Step 3: Run the full automated suite one final time**

Run: `node --test test/*.test.mjs`
Expected: PASS, every test, no failures and no skipped tests.

- [ ] **Step 4: Verify the extension loads in Chrome with no errors**

Load unpacked, open `https://x.com`, and confirm in the extension's error console that
nothing is thrown and that `XIW.VERSION` is `'0.1.0'`. Confirm Chrome's extension page
reports no manifest warnings.

- [ ] **Step 5: Work the manual checklist in the browser**

Every item in the checklist from Step 2, in a real browser against a real logged-in X
session. Do not mark this task complete on the automated suite alone — the suite covers two
files out of six.

- [ ] **Step 6: Bump the version**

`manifest.json` `"version"` from `0.1.0` to `0.1.1`, since the extension is now loadable and
verified. Keep it in step with `XIW.VERSION` in `src/core.js`.

- [ ] **Step 7: Commit**

```bash
git add README.md manifest.json src/core.js
git commit -m "docs: install guide and manual verification checklist"
```

---

## Execution Notes

- Tasks 1 → 2 → 3 are strictly sequential: each consumes the previous one's exports by name.
  Tasks 4, 5, and 6 are also sequential (6 wires 4 and 5 together). Task 7 depends on 6 only.
- The most likely source of a shipped bug is Review Focus item 3, the clipped button. If a
  manual check in Task 8 shows no button on any post, check the button's parent in Task 6
  before looking anywhere else.
- Only Tasks 1, 2, and 3 have automated tests. Tasks 4 through 7 ship with a syntax gate
  and a checklist, which is the spec's deliberate tradeoff — the code those tasks add is
  browser API glue that neither `node:test` nor jsdom can exercise. Do not let that read as
  an oversight and add a headless browser mid-plan; that is a v2 decision.

# X Image Weaver — Design Spec

**Date:** 2026-09-28
**Status:** Draft, awaiting review
**Repo:** `/home/tea/repos/x-image-weaver` (empty at time of writing)

## Purpose

A personal Chrome extension that merges split-image posts ("tap the post" trend) on X into
a single tall image and shows it in a full-screen overlay with a download button.

Motivation: X displays 2–4 attached images as a cropped 2×2 grid in the timeline and as a
vertical stack when expanded. The parts of one original image are separated across the
gallery. This extension recombines them for viewing and safekeeping.

It is a personal reimplementation of the TapToSee Chrome extension, scoped down. TapToSee
also offers grid mode and reply-with-composite; neither is in scope here.

## Scope

**In scope for v1**

- A "Merge" button on every X post that has 2+ image attachments.
- Parts are always stacked top-to-bottom, in X's own DOM order.
- Clicking the button fetches each part at original quality and composites them into one
  image with no gap.
- The composite is shown in a full-screen overlay with a single action: download PNG.
- Works on every X feed surface: home timeline, profile, post detail, thread replies,
  search results, media tabs, and quoted tweets.

**Explicitly out of scope for v1**

Automatic detection of which posts are split images; 2×2 grid reconstruction; tile
reordering to repair incorrect upload order; batch merging across the feed; keyboard
shortcuts; an options/preferences page; a background service worker; publishing to the
Chrome Web Store.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Trigger | Per-post opt-in button | Never mangles ordinary multi-photo posts. No detection heuristics to get wrong. |
| Layout | Always vertical stack | X itself stacks vertically on tap. Kills the grid branch and all reordering logic. |
| Result | Overlay viewer with download | The feed is never visually modified. |
| Surfaces | Every feed surface | One generic DOM scanner instead of surface-specific logic. |
| Tooling | Vanilla MV3, no build step | Loads unpacked from disk; edits apply on refresh. |
| Module loading | `content_scripts.js` array | Zero manifest risk. Files share the isolated-world global scope and must namespace. |
| Extras | None | Merge button + overlay + download is the whole product. |

## Architecture

Content script only. No service worker, no background page, no options page, no popup.

```
x-image-weaver/
  manifest.json
  src/
    core.js     namespace, selectors, tunables, pure helpers (testable)
    dom.js      DOM -> media IDs, mergeability rules
    button.js   button injection and click wiring
    stitch.js   fetch -> decode -> canvas composite (no DOM)
    overlay.js  singleton Shadow-DOM viewer, download, error state
    main.js     MutationObserver bootstrap (must be last in the js array)
  icons/        16, 48, 128
  README.md     install instructions + manual verification checklist
  test/
    core.test.mjs
```

### Module isolation contract

Content scripts declared in `manifest.json` are classic scripts sharing one isolated-world
global. Each file begins with:

```js
var XIW = (globalThis.XIW = globalThis.XIW || {});
```

`var` re-declaration across classic scripts is legal and creates no temporal-dead-zone
error, unlike `const`/`let`. The array order in `manifest.json` is the dependency graph;
no file imports another.

### Public interfaces

- `core.js` → `XIW.SELECTORS`, `XIW.TUNABLES`, `XIW.mediaIdFromUrl(url)`, `XIW.computeCanvasSize(tiles)`
- `dom.js` → `XIW.collectPhotoIds(root)`, `XIW.tweetMeta(root)`
- `stitch.js` → `XIW.stitchVertical(mediaIds) → Promise<{ blob, format }>`
- `overlay.js` → `XIW.overlay.show(blob, meta)`, `XIW.overlay.hide()`
- `button.js` → `XIW.button.mount(root)`
- `main.js` → bootstraps the observer; no exports

The load-bearing seam: `stitch.js` never touches the DOM and `dom.js` never fetches. Both
halves are independently testable; only the wiring between them is not.

## DOM contract

X's `data-testid` attributes are the only stable handle on the page, and they can change
without notice. All of that risk is confined to `dom.js` and `button.js`.

| Element | Selector |
|---|---|
| Tweet root | `article[data-testid="tweet"]` |
| Quoted tweet wrapper | `div[data-testid="quoteTweet"]` |
| Photo container | `div[data-testid="tweetPhoto"]` |
| Video / GIF container | `div[data-testid="videoPlayer"]` |
| Author cell | `[data-testid="User-Name"]` |
| Profile link (handle source) | `[data-testid="User-Name"] a[href^="/"]` with a bare-handle href |
| Tweet permalink (tweet id source) | `a[href*="/status/"]` |

Two of these are load-bearing and easy to get wrong. The handle comes from the **profile
anchor's href**, never from `[data-testid="User-Name"]`'s `textContent`: X renders display name
and `@handle` concatenated in that one element, so `textContent` yields `AdaLovelace@ada`.
The href must additionally be a bare profile path (`^\/[A-Za-z0-9_]{1,15}$` — X's handle
grammar) so the `/status/` permalink and `/i/user/` routes are not mistaken for it.

### `collectPhotoIds(root) → string[] | null`

Returns X's media IDs for the root's own attachments in DOM order, or `null` when the post
is not a mergeable gallery. Pure read; no side effects.

1. Collect `[data-testid="tweetPhoto"]` descendants, then **discard any with a
   `[data-testid="quoteTweet"]` ancestor**. This attributes a quoted tweet's media to the
   inner root rather than the outer post.
2. Collect `[data-testid="videoPlayer"]` the same way. **If any video is present, return
   `null`.** Mixed media is not a split gallery; refuse rather than partially merge.
3. Fewer than 2 photos → `null`.
4. For each photo, take the first available source URL:
   `img.currentSrc` → `img.src` → any descendant's `style.backgroundImage`.
   The background fallback matters because X populates it eagerly, so a lazy-loaded
   timeline image still yields a usable media ID.
5. Parse each URL with `mediaIdFromUrl`, which requires hostname `pbs.twimg.com` and a
   pathname of exactly `/media/<id>`. **If any photo fails to yield an ID, return `null` for
   the entire post.**
6. **Preserve duplicates.** X permits the same image more than once in a gallery;
   de-duplicating would corrupt the stack.

### Tweet discovery

`main.js` observes `document.body` with `{ childList: true, subtree: true }`, pushes added
nodes into a `Set`, and drains it on the next animation frame. Roots are both
`article[data-testid="tweet"]` and `div[data-testid="quoteTweet"]` — quoted tweets are not
reliably `article` elements.

Idempotency uses a `data-xiw-done` attribute on the root. A `WeakSet` would be incorrect
here: React reuses and re-parents DOM nodes, so identity of the element is not stable, but
the attribute survives a re-render.

**Media IDs are re-collected at click time, not at injection time.** This is cheap and
removes the risk of React swapping a node's media after the button was attached.

### Button placement

The button is appended to the media *row* (the shared parent of the photo containers), not
inside a photo container. X sets `overflow: hidden` on `tweetPhoto` to perform cropping, so
a button placed inside it would be clipped. The row is given inline `position: relative`;
the button sits top-right, `opacity: 0`, revealing on row hover or `focus-within`.

It is a real `<button type="button">` with an `aria-label`, so it is reachable by keyboard
and announced correctly.

### Tunables

Defined once in `core.js` as `XIW.TUNABLES`:

| Name | Value | Meaning |
|---|---|---|
| `MAX_CANVAS_HEIGHT` | `16000` | Uniform downscale kicks in above this total height. Well inside Chrome's 32767 limit, and keeps area small enough to avoid allocation failure. |
| `MAX_CANVAS_AREA` | `250_000_000` | Second guard: if `W * H` exceeds this, downscale further. Chrome's practical cap is around 268M pixels. |
| `FETCH_TIMEOUT_MS` | `20000` | Per-image `AbortSignal.timeout`. |
| `JPEG_FALLBACK_QUALITY` | `0.95` | Quality for the allocation-failure retry. |

## Stitch pipeline

`XIW.stitchVertical(mediaIds) → Promise<{ blob, format }>`. No DOM access.

1. Build `https://pbs.twimg.com/media/<id>?name=orig` for each ID — full resolution,
   original format.
2. Fetch all in parallel with `TUNABLES.FETCH_TIMEOUT_MS` per image and
   `cache: 'force-cache'`.
3. Decode with `createImageBitmap(blob)`, falling back to `new Image()` + `decode()`.
4. Geometry via the pure `computeCanvasSize(tiles)` helper, where `tiles` is an array of
   `{ width, height }` in draw order. It returns `{ width, height, scale }` such that every
   tile is drawn at `width * scale` by `height * scale`, stacked top to bottom:

   - `naturalWidth = max(tiles[].width)`
   - `scale = 1`; if `sum(tiles[].height) * scale > MAX_CANVAS_HEIGHT`, set
     `scale = MAX_CANVAS_HEIGHT / sum(tiles[].height)`
   - compute `width = round(naturalWidth * scale)`, `height = round(sum * scale)`; if
     `width * height > MAX_CANVAS_AREA`, multiply `scale` by `MAX_CANVAS_AREA / (width * height)`
     and recompute both. (`scale` is derived first, so no draw path ever needs a pixel total
     that exceeds the cap.)
5. Draw onto one canvas: fill the background white, then place each tile at the computed
   scale, centered horizontally, stacked with zero gap. Call `ImageBitmap.close()` on every
   tile after drawing — over a long scroll session the unreleased bitmaps are a real leak.
6. Encode with `canvas.toBlob('image/png')`. If it returns `null` (allocation failure), retry
   once as `image/jpeg` at `TUNABLES.JPEG_FALLBACK_QUALITY`. The resolved `format` reports
   which encoding was actually used so the UI can say so.
7. Failures reject with a typed error carrying a human-readable message. Exactly two causes
   are typed: `NETWORK` (fetch rejected, non-OK status, or timeout) and `DECODE`
   (`createImageBitmap` and the `Image` fallback both failed). Exceeding the canvas caps is
   **not** an error — it is a silent downscale, per the design intent that a tall composite
   should still be viewable.

Centering tiles narrower than the canvas is the entire "gap" story. There is no seam
detection or edge matching, which is precisely what dropping grid mode and reordering
buys.

## Overlay and download

The overlay is a lazily-created singleton: one host element with `attachShadow({ mode:
'open' })`, appended to `document.body` on first use and reused thereafter.

**Shadow DOM is required, not stylistic.** X's global stylesheet mangles injected `img` and
`div` elements; without the shadow boundary the composite renders wrong.

- Backdrop `rgba(0, 0, 0, 0.92)`, image `object-fit: contain` at 92vh / 92vw.
- Close via the `✕` control, `Escape`, or a backdrop click. Body scroll is locked while open
  and restored on close.
- One action: **Download PNG**, via a synthetic `<a download>` click on the object URL. This
  needs no `chrome.downloads` permission, which is why the manifest can declare none.
- Filename: `x-image-weaver-<handle>-<tweetId>.png`, both values read from the DOM.
- Object URLs are revoked when replaced and when the overlay closes.
- On stitch failure the overlay opens in an **error state** with the typed message and a
  Retry button. A click that silently does nothing reads as a broken extension.

Rejected during design: "open in new tab" (Chrome blocks top-level navigation to blob URLs)
and "copy image" (clipboard writes of multi-megabyte images are unreliable, and it is out of
scope).

## Manifest and permissions

```json
{
  "manifest_version": 3,
  "name": "X Image Weaver",
  "version": "0.1.0",
  "description": "Stitch split-image posts on X into a single tall image.",
  "minimum_chrome_version": "103",
  "permissions": [],
  "host_permissions": [],
  "content_scripts": [
    {
      "matches": [
        "https://x.com/*",
        "https://*.x.com/*",
        "https://twitter.com/*"
      ],
      "js": [
        "src/core.js",
        "src/dom.js",
        "src/button.js",
        "src/stitch.js",
        "src/overlay.js",
        "src/main.js"
      ],
      "run_at": "document_idle"
    }
  ],
  "icons": {
    "16": "icons/16.png",
    "48": "icons/48.png",
    "128": "icons/128.png"
  }
}
```

Zero declared permissions and no host permissions. `content_scripts` is not a permission
and requires no grant prompt; the site-access notice for the listed origins is inherent to
content scripts.

`minimum_chrome_version` is 103 because `AbortSignal.timeout` — used for the per-image
fetch deadline — first shipped there. `createImageBitmap` and Shadow DOM are far older and
constrain nothing.

**CORS needs no workaround.** `pbs.twimg.com` reflects the request `Origin` back in
`access-control-allow-origin` (and sends `*` when no `Origin` is present) — verified against
the live CDN. A content script on `https://x.com` can therefore fetch `?name=orig` and read
the pixels directly, leaving the canvas untainted. This is what removes the need for a
service worker fetch proxy, and it is the reason the extension needs no `host_permissions`.

## Testing

**Automated.** `node --test test/`, in two tiers.

Tier 1 — dependency-free, loading `src/core.js` into a `node:vm` context via
`test/harness.mjs`. Covers the two genuinely pure functions:

- `mediaIdFromUrl` — valid IDs, thumbnail-size query strings, `background-image: url(...)`
  wrapping, wrong host, non-media paths, empty and malformed input.
- `computeCanvasSize` — equal widths, mixed widths, height exceeding the max, and area
  exceeding the limit. These cover the downscale branches that are otherwise unreachable by
  hand.

Tier 2 — `dom.js` under **jsdom**, a dev-only dependency. It never ships in the extension
package; the extension itself has zero dependencies and no build step. This tier exists
because `collectPhotoIds` is the highest-risk file in the project and the one most likely
to break when X changes its DOM:

- Photo counting across 1, 2, 3, and 4 attachments.
- Mixed photo + video returns `null`.
- Quoted-tweet media is attributed to the inner root, not the outer post.
- The `background-image` fallback yields an ID for an image with no `src`.
- A photo with an unparseable URL poisons the whole result to `null`.
- Duplicate media IDs are preserved.

A headless browser is still out of scope; it would be needed to test the MutationObserver,
React re-rendering, canvas drawing, and the overlay, none of which jsdom models. Those are
covered by the manual checklist:

- Posts with 2, 3, and 4 images — button appears, composite is seamless.
- Single image — no button.
- Video only, and photo + video mixed — no button.
- Quoted tweet whose inner post has 2 photos — button on the inner post only, no duplicates.
- Thread reply, search results, profile, post detail, media tab — button present on each.
- Very tall composite that exceeds the canvas height cap — visibly downscaled, not blank.
- Scroll 20+ multi-image posts — no memory growth, no duplicate buttons.
- SPA navigation between home / notifications / profile — no duplicate buttons.
- Download lands a file named `x-image-weaver-<handle>-<tweetId>.png`.
- Download of a composite that hit the JPEG fallback lands as `.jpg`, not `.png`.
- Deleting a post or a tweet failing to load mid-scroll — the button never appears, and
  nothing is left behind in the DOM.

## Failure modes

| Failure | Behavior |
|---|---|
| X changes its DOM structure | Button silently stops appearing. No crash, no layout damage. Diagnose by logging from `dom.js`. |
| Image 404 / 403 / timeout | Overlay error state naming `NETWORK`, with Retry. |
| Composite exceeds canvas height or area cap | Silent uniform downscale, logged to the console. |
| `toBlob` returns `null` (allocation failure) | Retry once as JPEG at quality 0.95; caller notes the format change. |
| React re-parents a node or swaps its media | IDs re-collected at click time; `data-xiw-done` marker keeps injection idempotent. |
| X's `overflow: hidden` crops the button | Button is a child of the media row, never of a photo container. |
| Duplicate X media IDs in one post | Preserved, not de-duplicated. |

# X Image Weaver

A Chrome extension that merges a split-image post on X (the "tap the post" trend) into one
tall image and shows it full-screen with a download button.

X displays 2–4 attached images as a cropped grid in the timeline and as a vertical stack when
you open the post. When those images are really one picture cut into parts, this extension
recombines them for viewing and safekeeping.

It is a personal reimplementation of the TapToSee extension, scoped down: vertical stacking
only, no grid reconstruction, no tile reordering, no batch processing.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this repository's root directory.
4. Reload the extension after any change to a file under `src/` — content scripts are only
   re-injected on a fresh page load, so reload the X tab too.

Nothing is uploaded anywhere. The extension has **zero permissions**, no background service
worker, and no network calls other than fetching the images from X's own CDN. The composite is
built in the page with Canvas 2D and downloaded straight from a blob URL.

## Use

Open any post with two or more images and a **Merge** control appears — a small icon in the
gutter to the left of the images in a feed, and a labelled pill beside an image count on its
own line under the media on a post's own page. Click it. The parts are fetched at original resolution, joined with no gap in the
direction the post lays them out, and shown full-screen. **Download** saves the result as
`x-image-weaver-<handle>-<tweetId>.png`.

If the stitch fails, the overlay opens in an error state naming the cause with a Retry button.
A failed merge never replaces a composite you are already looking at.

The button appears on every post with 2+ images, not only on split ones. There is no
detection heuristic — guessing wrong would mangle an ordinary multi-photo post, so the
decision is yours per post.

## How it is put together

Six classic content scripts sharing one `globalThis.XIW` namespace. The manifest's array order
is the dependency graph.

| File | Responsibility |
|---|---|
| `src/core.js` | Pure helpers: media-ID parsing, canvas geometry, download filenames, tunables |
| `src/dom.js` | Reads X's DOM: which media a post owns, and whether it is mergeable |
| `src/stitch.js` | Fetches, decodes, and composites. Never reads the page's DOM |
| `src/overlay.js` | Shadow-DOM viewer, download, error state. One lazily-built host, reused |
| `src/button.js` | Injects the button and wires click → stitch → overlay |
| `src/main.js` | Last to load. Observes the DOM and calls `button.mount` on each new post |

The load-bearing seam is that `dom.js` never fetches and `stitch.js` never reads the page.
Both halves are independently testable; only the wiring between them is not.

Two details worth knowing before changing anything:

- **Every file is IIFE-wrapped** and contributes only `XIW` to the global. Top-level `var` and
  `function` declarations in a classic content script become properties of the shared isolated
  world, and a later file would silently clobber them. `test/loader.test.mjs` enforces this for
  every script in the manifest.
- **The button is never a child of a photo container, and in a feed it is not inside the
  gallery either.** X sets `overflow: hidden` on `[data-testid="tweetPhoto"]` and on the box
  around the gallery. A button inside either is clipped, and one that overflows that box lands
  on the timestamp. The feed control is a child of the post. The status-page bar is the
  previous sibling of the timestamp row, outside the gallery.

## Tests

```
npm install          # devDependency: jsdom. The extension itself ships none of this.
node --test test/*.test.mjs
```

154 tests. Do not use `node --test test/` — on Node 22 that treats `test` as a module to load
and fails.

What is covered automatically: the pure helpers, the DOM extraction rules under jsdom
(including the quoted-post ownership rules), the overlay's behavioral contract, the button's
placement and click-time re-collection, and the observer's discovery and idempotency.

What is **not**, and cannot be: anything needing a layout engine or a real browser. Canvas
drawing, the actual paint order of X's CSS, whether X's real markup matches the fixtures, and
whether a download actually lands on disk are all in the checklist below.

## Releases

Two workflows. `ci.yml` runs on every push to `master` and on every pull request: it installs
the dev dependency, checks that the version declarations agree, runs the suite, and runs the
same `zip` command the release uses as a canary so a file that stops existing fails there
first. It has no write permission and uploads nothing.

`release.yml` runs on a tag and creates a GitHub Release with the packaged extension
attached.

### Cutting a release

The version lives in four places and `scripts/verify-release-version.mjs` requires all of
them to agree. Bump the first three, commit, then push the tag:

1. `manifest.json` → `"version"`
2. `src/core.js` → `XIW.VERSION`
3. `package.json` → `"version"`
4. The git tag — `v0.2.0` or `0.2.0`, both accepted

```bash
# after bumping the three files and committing
git tag v0.2.0
git push origin v0.2.0
```

The tag is matched broadly (`v[0-9]*`, `[0-9]*`) and then validated inside the job. That is
deliberate: a narrow tag glob is tidier, but if it is subtly wrong no release ever runs and
nothing tells you, because a workflow that does not match produces no run to look at. A
mis-typed tag now fails the run with a message naming all four copies.

The job refuses to package anything if the tests fail, and `gh release create` refuses to
replace an existing release for the same tag — re-running cannot silently overwrite a
published artifact.

### What is in the release

`x-image-weaver-v<version>.zip` containing only `manifest.json`, `src/`, and the four icons the
manifest declares — the files Chrome loads, and nothing else. Tests, docs, CI config, the jsdom
devDependency, and `icons/icon-source.png` (the 1408px source the icon sizes are derived from —
847KB against the 20KB of the icons themselves) are all excluded, so the archive stays small
enough to read before loading it into a browser. To install
from a release, unzip it and point **Load unpacked** at the extracted folder.

There is no `.crx`. Building one requires a private signing key, and shipping that key to CI
is a worse trade than asking people to unzip a folder.

## Manual verification checklist

Run this in a real browser against a real logged-in X session. The automated suite covers
about half the codebase; this covers the half it cannot reach. **Load a fresh tab after
reloading the extension.**

### Core behavior

- [ ] Post with **2** images laid out side by side — the two are joined **left to right** into
      one wide image, not stacked.
- [ ] A 4-image post (a 2×2 grid) — joined **top to bottom**, which is what the tap-to-see
      posts want.
- [ ] In a feed, the control is an icon in the gutter to the **left** of the images,
      vertically centred on the media, with one dot per image under it. It is not drawn
      on the picture. On a light page it is gray and hover turns it blue. On a dark page
      it is white, and hover brightens the disc behind it. While a merge runs, the icon
      spins. It is always visible.
- [ ] Clicking it works — it is not swallowed by X's own card link.
- [ ] Scrolling a timeline and back does not lose the control on a recycled card.
- [ ] On a post's own page, it is a labelled pill below the images, beside the count, on its
      own line — not overlapping the timestamp or the view counts.
- [ ] On a post's own page, the **replies** get the compact icon, not a bar each.
- [ ] Post with **3** images — same.
- [ ] Post with **4** images — same.
- [ ] Single-image post — **no** button.
- [ ] Video-only post — **no** button.
- [ ] Post with a photo **and** a video — **no** button. Mixed media is refused rather than
      partially merged.

### Surfaces

- [ ] Home timeline.
- [ ] A profile's posts.
- [ ] A profile's media tab.
- [ ] Search results.
- [ ] A post's own detail page.
- [ ] A thread's replies.
- [ ] A quoted post whose inner post has 2 photos — button on the inner post only, and the
      outer post does not absorb the quoted post's media.
- [ ] After scrolling 20+ multi-image posts: no duplicate buttons, and the tab's memory is
      stable (Chrome's task manager, not intuition).
- [ ] SPA navigation between home / notifications / a profile — no duplicate buttons, and the
      button still appears on posts rendered after the navigation.

### Rendering — the part jsdom cannot check

- [ ] The composite shows the **whole** image: the Download button and the ✕ control never
      cover its bottom or top rows. Check on a short window (~700px tall) as well as a tall one.
- [ ] The button is always visible and **not** clipped by X's media grid, and it does not
      cover the timestamp, the view count, or the picture.
- [ ] X's own media grid looks unchanged: the button's stacking context does not alter how
      X paints the post around it.
- [ ] Escape closes the overlay; the page scrolls normally again afterwards.
- [ ] The ✕ closes it; so does clicking the backdrop beside the image.
- [ ] Tab inside the overlay cycles its controls and does not walk out into the timeline
      behind it.
- [ ] Clicking a post's media *around* the button still opens X's own viewer. The button must
      swallow only its own clicks.

### Download

- [ ] Download lands a file named `x-image-weaver-<handle>-<tweetId>.png` with the handle
      matching the post's author, not a display name and not concatenated.
- [ ] To exercise the JPEG fallback (PNG allocation failure) you need a very large composite;
      if it triggers, the file lands as `.jpg` and the overlay still works. Low priority —
      hard to trigger deliberately.

### Downscaling and seams

- [ ] A very tall composite (4 parts of roughly 1920×4320 each) is visibly downscaled rather
      than blank or truncated.
- [ ] That same downscaled composite has **no hairline line** between its parts. Smoothing is
      deliberately off so part boundaries cannot blend with the white background fill — this
      is the check for it. A dark photo is the best test.
- [ ] A gallery that fits inside the canvas caps looks identical to before; the no-smoothing
      setting is a no-op at 1:1.

### Edge cases

- [ ] Scrolling past a post that fails to load, or one deleted mid-scroll — the button never
      appears and nothing is left behind in the DOM.
- [ ] A retweet of a 2-image post offers **one** merge of that post's 2 images, not a 4-image
      composite. (Assumed during design; confirm, because the containment rule for nested
      roots was deliberately not generalised.)
- [ ] A post whose images are absolutely-pathed (`https://x.com/<handle>`) — believed not to
      occur on X; if it does, the download filename degrades to
      `x-image-weaver-unknown-<tweetId>.png` rather than failing.
- [ ] Touch/pen input on a phone-sized window: the button is visible without hovering and
      is tappable.

## Known limitations

- The join direction is read from the post's layout: images laid out side by side are joined
  left to right, and a nested grid is joined top to bottom. A 2×2 grid of quadrants is not
  reassembled as a grid, because the tap-to-see posts that produce that layout are one tall
  image cut into strips and want stacking.
- No reordering. Parts are joined in X's own DOM order, so a gallery posted in the wrong
  order stays in the wrong order.
- The button appears on every 2+ image post, including ordinary multi-photo posts. Deliberate:
  no heuristic can avoid mangling a post it guesses wrong about.
- If X changes its `data-testid` attributes, the button silently stops appearing. That is the
  designed failure mode — no crash, no layout damage. `src/dom.js` is the only file to fix.

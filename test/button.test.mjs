import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tweetFixture } from './fixtures.mjs';
import { loadAll } from './harness.mjs';

// button.js is DOM-placement and DOM-wiring code, and jsdom models DOM structure
// but not layout. That split decides what this file can prove:
//
//   Can: where in the tree the button ends up, which of X's own selectors it is
//        or is not inside, that the row is its parent, that a click re-reads the
//        media, that the event is stopped before it reaches X, and the whole
//        stitch -> overlay handoff including the retry path through the REAL
//        overlay.
//   Cannot: that anything is visible, that the button is not covered, that
//        `overflow: hidden` would or would not have clipped it, and that
//        `opacity: 0` hides it -- no layout, no cascade. The stylesheet is
//        therefore asserted as text, the same bargain overlay.test.mjs makes.
//
// The button's *position* is assertable even though its appearance is not,
// because the failure this file exists to prevent -- X crops a button placed
// inside a tweetPhoto -- is a containment question. `closest()` answers it in
// jsdom even though the crop itself would need a layout engine.
//
// The real src/button.js is loaded through the existing harness, as
// overlay.test.mjs loads the real src/overlay.js. Only the two collaborators
// that do work this file is not about are replaced: XIW.stitchImages (no
// createImageBitmap, no canvas -- stitch.js has no automated test by design) and
// XIW.overlay, except in the one test that needs the real one for Retry.

const BUTTON = 'button.xiw-merge-button';
const ARIA_LABEL = 'Merge images into one';
const pbsUrl = (id) => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;

// What stitchImages was handed, flattened to `id:format` per part.
//
// The format is half the contract now, not decoration: the media id alone does
// not name a fetchable URL, and a source that lost its format would fail against
// the real CDN while every id-only assertion here stayed green. Reading the pair
// as one string keeps the assertions about the media rather than about object
// internals, so a renamed field cannot silently stop being checked.
const sawMedia = (calls) => calls.map((sources) => sources.map((s) => `${s.id}:${s.format}`));
const originalConsoleError = console.error;

// A fresh document and a fresh module instance per test: loadAll() resets XIW
// and re-evaluates the six manifest scripts, and a new fixture document keeps
// one test's injected buttons out of the next test's queries.
function setup({
  photos = [],
  videos = 0,
  quote = null,
  tweetId = '123',
  handle = 'ada',
  // Which page the post is being read on. button.js picks its control from the
  // path -- a labelled pill under the media on a post's own page, a gutter icon to
  // the left of the images in a feed -- so the context is part of the fixture, not a detail each
  // test sets up for itself. Defaults to the post page, where the bar is.
  context = 'post',
  stitch,
  realOverlay = false,
} = {}) {
  const url = context === 'post' ? `https://x.com/${handle}/status/${tweetId}` : 'https://x.com/home';
  const document = tweetFixture({ photos, videos, quote, tweetId, handle, url });
  const window = document.defaultView;

  // A subclass, not a plain object, and not a patch of the real URL: the harness
  // resolves its own file paths with the global `new URL(...)`, so replacing that
  // global with a stub breaks the loader running these tests. Extending it leaves
  // every other use intact. Needed by the tests that keep the real overlay,
  // because show() creates an object URL and jsdom does not implement it.
  class StubURL extends URL {
    static createObjectURL() {
      return 'blob:test/0';
    }

    static revokeObjectURL() {}
  }

  const XIW = loadAll({ document, URL: StubURL });

  const stitched = [];
  const shown = [];
  const shownErrors = [];

  const respond =
    typeof stitch === 'function'
      ? stitch
      : () =>
          Promise.resolve({
            blob: new window.Blob(['composite'], { type: 'image/png' }),
            format: 'image/png',
          });

  // The direction is recorded alongside the sources because it is half the
  // contract now: the same media joined the wrong way is a different picture, and
  // every other assertion here would stay green while it happened.
  const directions = [];
  XIW.stitchImages = (sources, direction) => {
    stitched.push(sources.slice());
    directions.push(direction);
    return respond(sources, direction);
  };
  // The real overlay is left in place for the Retry test; everywhere else it is
  // a recorder, because what is under test is that the composite is handed
  // over, not what the overlay then does with it.
  if (!realOverlay) {
    XIW.overlay = {
      show: (options) => shown.push(options),
      showError: (err, onRetry) => shownErrors.push({ err, onRetry }),
      hide: () => {},
    };
  }

  const button = () => document.querySelector(BUTTON);
  const buttons = () => document.querySelectorAll(BUTTON);
  const roots = () => document.querySelectorAll('article[data-testid="tweet"], div[data-testid="quoteTweet"]');
  const photos_ = () => document.querySelectorAll('[data-testid="tweetPhoto"]');
  const row = () => photos_()[0].parentElement;

  // cancelable: preventDefault is one of the claims under test, and a
  // non-cancelable event reports defaultPrevented as false however it is
  // dispatched.
  const click = (node) => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event;
  };
  // One macrotask, which drains the microtask queue the awaited stitch resolves
  // on. Sleeping on the promise under test instead would make these tests pass
  // for the wrong reason whenever the promise never settles.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  return { document, window, XIW, stitched, directions, shown, shownErrors, button, buttons, roots, photos: photos_, row, click, settle };
}

// --- 1. no button for a post that is not mergeable ------------------------------

test('mount touches nothing for a post collectPhotoIds refuses', () => {
  const cases = [
    ['no photos at all', { photos: [] }],
    ['one photo', { photos: ['aa'] }],
    ['a photo and a video', { photos: ['aa', 'bb'], videos: 1 }],
    ['a video only', { videos: 1 }],
    ['a photo whose URL yields no media id', { photos: ['aa', 'bad'] }],
    ['only the quoted post has two photos', { photos: [], quote: { photos: ['cc', 'dd'] } }],
  ];

  for (const [label, options] of cases) {
    const t = setup(options);
    t.XIW.button.mount(t.roots()[0]);

    assert.equal(t.buttons().length, 0, `no button for ${label}`);
    assert.equal(t.document.querySelectorAll('button').length, 0, `and nothing else injected a button either, for ${label}`);
    assert.equal(t.document.querySelectorAll('[data-xiw-row]').length, 0, `and the media row was left unmarked, for ${label}`);
    assert.equal(t.document.querySelectorAll('style.xiw-styles').length, 0, `and no stylesheet for a page with no button, for ${label}`);
  }
});

test('mount is a no-op for something that is not a root at all', () => {
  const t = setup({ photos: ['aa', 'bb'] });
  for (const root of [null, undefined, {}, 'article', 42]) {
    t.XIW.button.mount(root);
  }
  assert.equal(t.buttons().length, 0, 'a junk root produces no button rather than a throw');
});

// --- 2. the button is on the media row, never inside a photo container ----------
//
// The constraint X makes silent. `overflow: hidden` on tweetPhoto crops whatever
// is inside it, so a button appended into a photo container is invisible on
// every post and there is nothing on screen to diagnose.

// Below the media, in its own bar -- where TapToSee puts it. Not on the image:
// an overlay control covers the part of the composite the reader most wants to see,
// and it has to be hidden until hover to avoid being visual noise on every post.
test('the control sits in a bar directly after the media', () => {
  for (const count of [2, 4]) {
    const t = setup({ photos: Array.from({ length: count }, (_, i) => `p${i}`) });
    t.XIW.button.mount(t.roots()[0]);

    const media = t.row();
    const bar = t.document.querySelector('[data-xiw-bar]');
    const injected = t.button();
    assert.ok(injected, `${count} photos: a button exists`);
    assert.ok(bar, `${count} photos: in a bar of its own`);
    assert.equal(injected.parentElement, bar, `${count} photos: the button is inside the bar`);
    assert.equal(bar.previousElementSibling, media, `${count} photos: which follows the media`);
    assert.equal(bar.closest('[data-testid="tweetPhoto"]'), null, `${count} photos: and is not inside a photo container`);
    assert.equal(t.photos().length, count, `${count} photos: the fixture really had that many`);
    assert.equal(t.buttons().length, 1, `${count} photos: exactly one`);
    assert.equal(bar.querySelector('.xiw-merge-count').textContent, `${count} Images`, 'with the count beside it');
  }
});

test('a quoted post\'s media never decides where the outer button lands', () => {
  const t = setup({ photos: ['aa', 'bb'], quote: { photos: ['cc', 'dd'] } });
  // One rule, two consumers: dom.js exports XIW.ownElements and this file reads
  // it rather than keeping a copy, so the button and the ids it stitches cannot
  // come to disagree about which media this post owns. The two tests either side
  // of this one are that claim, asserted through both call sites.
  assert.equal(typeof t.XIW.ownElements, 'function', 'the ownership rule is exported, not duplicated');
  // Structural guard against the copy this file used to keep: button.js has no
  // business reading X's quoteTweet selector for itself -- the rule belongs to
  // dom.js and arrives as XIW.ownElements -- and the rule itself is written once.
  // Matched on the code form, because mount()'s JSDoc legitimately names
  // div[data-testid="quoteTweet"] as one of the two root types it takes.
  const buttonSource = readFileSync(new URL('../src/button.js', import.meta.url), 'utf8');
  const domSource = readFileSync(new URL('../src/dom.js', import.meta.url), 'utf8');
  assert.doesNotMatch(buttonSource, /XIW\.SELECTORS\.quoteTweet/, 'button.js never re-derives quote ownership for itself');
  assert.equal((domSource.match(/function isQuotedBy/g) || []).length, 1, 'and dom.js holds the one copy of the rule');
  // The fixture appends the outer post's media before the quote, which is where
  // X renders it. Moving the quote first is the only way the first photo in
  // document order is the quoted post's, so this is the case where "just take the
  // first tweetPhoto" puts the button on the wrong row. Built by reordering the
  // fixture's own nodes rather than by editing test/fixtures.mjs.
  const outer = t.roots()[0];
  const quote = outer.querySelector('[data-testid="quoteTweet"]');
  outer.insertBefore(quote, t.row());
  assert.equal(t.photos()[0].closest('[data-testid="quoteTweet"]') !== null, true, 'the quoted post\'s photo is now first in the document');

  t.XIW.button.mount(outer);

  const bar = t.document.querySelector('[data-xiw-bar]');
  const ownPhoto = Array.from(t.photos()).find((photo) => photo.closest('[data-testid="quoteTweet"]') === null);
  assert.ok(ownPhoto, 'the outer post still has photos of its own');
  assert.equal(bar.closest('[data-testid="quoteTweet"]'), null, 'the bar is nowhere near the quoted post');
  assert.ok(
    bar.previousElementSibling.contains(ownPhoto),
    'and it follows the outer post\'s own media, not the quoted post\'s'
  );
  assert.deepEqual(
    t.XIW.collectPhotoIds(outer),
    ['aa', 'bb'],
    'the outer post still owns exactly its own two photos'
  );
});

test('mounting the quoted root puts its own button on the quoted row', () => {
  const t = setup({ photos: ['aa', 'bb'], quote: { photos: ['cc', 'dd'] } });

  t.XIW.button.mount(t.roots()[1]);

  const injected = t.button();
  assert.equal(t.buttons().length, 1, 'one button, for the root that was mounted');
  assert.ok(injected.closest('[data-testid="quoteTweet"]'), 'on the quoted post');
  assert.equal(injected.closest('[data-testid="quoteTweet"]').querySelector(BUTTON), injected, 'inside its own row, not the outer one');
  assert.equal(injected.closest('[data-testid="tweetPhoto"]'), null, 'and still not inside a photo container');
});

test('a second mount for one root produces one button', () => {
  const t = setup({ photos: ['aa', 'bb'] });
  const root = t.roots()[0];
  t.XIW.button.mount(root);
  t.XIW.button.mount(root);
  t.XIW.button.mount(root);

  assert.equal(t.buttons().length, 1, 'idempotent in its own terms, whatever the caller does');
});

test('a re-mount puts the bar back after a re-render removed it, without adding a second', () => {
  const t = setup({ photos: ['aa', 'bb'] });
  const root = t.roots()[0];
  t.XIW.button.mount(root);
  const bar = t.document.querySelector('[data-xiw-bar]');

  // A React commit that rebuilds the subtree the bar was inserted into takes the
  // bar with it and leaves the article's marker in place, so the observer will not
  // re-mount on its own -- a re-mount has to be able to put the control back.
  bar.remove();
  assert.equal(t.buttons().length, 0, 'precondition: the bar is gone');

  t.XIW.button.mount(root);

  assert.equal(t.buttons().length, 1, 'exactly one button again');
  assert.equal(t.document.querySelectorAll('[data-xiw-bar]').length, 1, 'and one bar');
});

// The same spot on every post, whatever layout X chose for it.
//
// X nests a 4-image gallery -- the grid holds rows and the rows hold the photos --
// so the first photo's parentElement is one ROW of the gallery, not the gallery.
// Anchoring there put the button at the top-right of the top row: halfway down
// the media on a 4-image post and at the top of the media on a 2-image one. That
// is the "button shows up in a different place" half of the inconsistency, and it
// is invisible to every other test here because the fixture builds a flat row
// where the first parent and the common ancestor are the same node.
test('the bar follows the whole media block, not the first row of a nested grid', () => {
  const t = setup({ photos: ['a', 'b', 'c', 'd'] });
  const root = t.roots()[0];
  const flatRow = t.row();

  // Restructure into the nested shape X actually renders for four images.
  const grid = t.document.createElement('div');
  const top = t.document.createElement('div');
  const bottom = t.document.createElement('div');
  const photos = [...flatRow.querySelectorAll('[data-testid="tweetPhoto"]')];
  top.append(photos[0], photos[1]);
  bottom.append(photos[2], photos[3]);
  grid.append(top, bottom);
  flatRow.replaceWith(grid);

  assert.equal(t.row(), top, 'the fixture is now nested: the first photo sits in one row');

  t.XIW.button.mount(root);

  const bar = root.querySelector('[data-xiw-bar]');
  assert.ok(bar, 'a bar was placed');
  assert.equal(bar.previousElementSibling, grid, 'after the gallery, so it never lands mid-media');
  assert.notEqual(bar.previousElementSibling, top, 'following the first row is the bug this pins');
});

// The bar has to leave the box X crops the gallery with. That box is absolute and
// overflow-hidden with a fixed height, so a bar inserted inside it overflows onto
// the timestamp and, because the bar paints above X's card link, takes the clicks
// that belonged to the time and the view count.
test('the bar sits outside the clipping media box and above the timestamp', () => {
  const t = setup({ photos: ['a', 'b'] });
  const root = t.roots()[0];
  const flatRow = t.row();

  const grid = t.document.createElement('div');
  for (const photo of [...flatRow.querySelectorAll('[data-testid="tweetPhoto"]')]) grid.appendChild(photo);

  const chrome = t.document.createElement('div');
  chrome.style.position = 'absolute';
  chrome.style.overflow = 'hidden';
  chrome.appendChild(grid);

  const outer = t.document.createElement('div');
  outer.appendChild(chrome);
  flatRow.replaceWith(outer);

  const time = t.document.createElement('time');
  time.textContent = '1:13 AM';
  outer.after(time);

  t.XIW.button.mount(root);

  const bar = root.querySelector('[data-xiw-bar]');
  assert.ok(bar, 'a bar was placed');
  assert.equal(chrome.contains(bar), false, 'not inside the box that crops the gallery');
  assert.equal(outer.contains(bar), false, 'and not inside the wrapper around that box');
  assert.equal(bar.nextElementSibling, time, 'directly before the timestamp, on a line of its own');
});

// Climbing out of every overflow-hidden ancestor would walk out of the post body
// when that body is itself overflow-hidden and already holds the timestamp. The
// bar would then land below the action bar. The climb stops at the meta.
test('the bar does not jump past a timestamp that shares the clipping box', () => {
  const t = setup({ photos: ['a', 'b'] });
  const root = t.roots()[0];
  const flatRow = t.row();

  const grid = t.document.createElement('div');
  for (const photo of [...flatRow.querySelectorAll('[data-testid="tweetPhoto"]')]) grid.appendChild(photo);

  const time = t.document.createElement('time');
  time.textContent = '1:13 AM';

  const shell = t.document.createElement('div');
  shell.style.overflow = 'hidden';
  shell.append(grid, time);
  flatRow.replaceWith(shell);

  t.XIW.button.mount(root);

  const bar = root.querySelector('[data-xiw-bar]');
  assert.equal(bar.previousElementSibling, grid, 'still directly after the gallery');
  assert.equal(bar.nextElementSibling, time, 'and directly before the timestamp');
  assert.equal(shell.contains(bar), true, 'inside the post body, not after it');
});

// The live status page sizes a wrapper to the pictures and does not mark it as
// cropping chrome: no absolute position, no overflow, no aspect-ratio. The
// timestamp and the view count are the next row, outside that wrapper. A bar
// inserted inside the wrapper overflows onto that row. The header also carries
// its own time, earlier in the post; anchoring to that one would pin the pill
// to the top.
test('the bar is a line of its own above the timestamp, outside the fixed-height gallery', () => {
  const t = setup({ photos: ['a', 'b'] });
  const root = t.roots()[0];
  const flatRow = t.row();

  const posted = t.document.createElement('time');
  posted.textContent = '2h';
  root.insertBefore(posted, root.firstChild);

  const grid = t.document.createElement('div');
  for (const photo of [...flatRow.querySelectorAll('[data-testid="tweetPhoto"]')]) grid.appendChild(photo);

  const crop = t.document.createElement('div');
  crop.style.height = '480px';
  crop.appendChild(grid);

  const time = t.document.createElement('time');
  time.setAttribute('datetime', '2026-10-02T05:00:00.000Z');
  time.textContent = '5:00 AM · Oct 2, 2026';
  const views = t.document.createElement('span');
  views.textContent = '3,978 Views';
  const meta = t.document.createElement('div');
  meta.style.display = 'flex';
  meta.style.flexDirection = 'row';
  meta.append(time, views);

  flatRow.replaceWith(crop);
  crop.after(meta);

  t.XIW.button.mount(root);

  const bar = root.querySelector('[data-xiw-bar]');
  assert.ok(bar, 'a bar was placed');
  assert.equal(crop.contains(bar), false, 'not inside the box that is only as tall as the pictures');
  assert.equal(meta.contains(bar), false, 'not in the timestamp row, where it would share that line');
  assert.equal(bar.nextElementSibling, meta, 'the line immediately above the timestamp and the views');
  assert.equal(bar.parentElement, meta.parentElement, 'in the same column as that row, so the column grows');
  assert.equal(
    posted.compareDocumentPosition(bar) & t.window.Node.DOCUMENT_POSITION_FOLLOWING,
    t.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'below the header time, not anchored to it'
  );
});

// The quote has a timestamp of its own, and it follows the outer gallery. Anchoring
// to that time would put the outer post's pill inside the quote.
test('the bar precedes the post\'s own timestamp, not the quoted post\'s', () => {
  const t = setup({ photos: ['a', 'b'], quote: { photos: ['c', 'd'], tweetId: '456' } });
  const root = t.roots()[0];
  const quote = root.querySelector('[data-testid="quoteTweet"]');

  const quoteTime = t.document.createElement('time');
  quoteTime.textContent = '1:00 AM';
  quote.appendChild(quoteTime);

  const time = t.document.createElement('time');
  time.textContent = '5:00 AM · Oct 2, 2026';
  root.appendChild(time);

  t.XIW.button.mount(root);

  const bar = [...root.querySelectorAll('[data-xiw-bar]')].find((el) => el.closest('[data-testid="quoteTweet"]') === null);
  assert.ok(bar, 'the outer post has a bar');
  assert.equal(quote.contains(bar), false, 'and it is not inside the quote');
  assert.equal(bar.nextElementSibling, time, 'directly before this post\'s timestamp');
});

// --- 2b. which way the parts are joined ------------------------------------------
//
// Two images side by side in the post are one picture split down the middle, and
// stacking them produces a composite that is visibly wrong -- the reported bug.
// A nested grid is the tap-to-see shape and joins top to bottom. The direction is
// read at click time and handed to the stitch, so this asserts the hand-off.

test('a side-by-side post joins its parts left to right', () => {
  const t = setup({ photos: ['left', 'right'] });
  t.XIW.button.mount(t.roots()[0]);
  t.click(t.button());
  return t.settle().then(() => {
    assert.deepEqual(sawMedia(t.stitched), [['left:jpg', 'right:jpg']]);
    assert.deepEqual(t.directions, ['horizontal'], 'side by side means joined side by side');
  });
});

test('a nested grid joins its parts top to bottom', () => {
  const t = setup({ photos: ['a', 'b', 'c', 'd'] });
  const root = t.roots()[0];
  const flatRow = t.row();

  // The tap-to-see shape: a grid holding rows holding photos. Its parts are not a
  // single row, so the original is a tall image cut into strips.
  const grid = t.document.createElement('div');
  const top = t.document.createElement('div');
  const bottom = t.document.createElement('div');
  const photos = [...flatRow.querySelectorAll('[data-testid="tweetPhoto"]')];
  top.append(photos[0], photos[1]);
  bottom.append(photos[2], photos[3]);
  grid.append(top, bottom);
  flatRow.replaceWith(grid);

  t.XIW.button.mount(root);
  t.click(t.button());
  return t.settle().then(() => {
    assert.deepEqual(t.directions, ['vertical']);
  });
});

// --- 2c. the control depends on where the post is being read ----------------------
//
// The reference uses two shapes: a compact icon on the media in a feed, where there
// is no room for anything else, and a labelled pill beside an image count under the
// media on a post's own page, where there is. Both are the same button.

test('a feed gets the gutter icon beside the media, not a bar and not a mark on the picture', () => {
  const t = setup({ photos: ['a', 'b'], context: 'timeline' });
  const root = t.roots()[0];
  t.XIW.button.mount(root);

  const control = t.document.querySelector('[data-xiw-control]');
  assert.ok(control, 'a control exists');
  assert.equal(control.className, 'xiw-merge-gutter', 'and it is the gutter shape');
  assert.equal(control.parentElement, root, 'anchored to the post, where the gallery cannot clip it');
  assert.equal(t.row().contains(control), false, 'not inside the media, which is where it would cover the picture');
  assert.equal(t.document.querySelector('[data-xiw-bar]'), null, 'with no bar, which would grow every card');
  assert.equal(t.button().classList.contains('xiw-merge-button--icon'), true, 'and an icon-only button');
  assert.equal(root.style.position, 'relative', 'the post is positioned so the gutter anchors to it');
  assert.equal(t.row().style.position, '', 'the media block is left exactly as X laid it out');
  // No layout in jsdom, so the control parks on the avatar-column centre until a
  // real box exists. A zero rect must not push it off the left of the post.
  assert.equal(control.style.left, '28px');
  assert.equal(control.style.top, '50%');
  // The visible words are clipped in this variant, so the accessible name is the
  // only thing that says what the control does.
  assert.equal(t.button().getAttribute('aria-label'), ARIA_LABEL, 'still announced as the action it performs');
  assert.ok(t.button().querySelector('.xiw-merge-label'), 'and the label is present, just clipped rather than removed');
  // One dot per image, under the icon, which is how the reference counts the parts.
  assert.equal(control.querySelectorAll('.xiw-merge-dot').length, 2, 'a dot for each image');
  assert.equal(control.querySelector('.xiw-merge-dots').getAttribute('aria-hidden'), 'true', 'the dots are not a second name');
  // The feed mark is the two frames and the inward arrows, not the pill's split
  // glyph and not a sparkle drawn on the art.
  assert.equal(t.button().querySelectorAll('path').length, 4, 'the feed mark is the frame-and-arrows icon');
  assert.match(t.button().querySelector('path').getAttribute('d'), /^M2 4h7/, 'and it is that icon');
});

test('the gutter control centres on the avatar and on the media', () => {
  const t = setup({ photos: ['a', 'b'], context: 'timeline' });
  const root = t.roots()[0];
  const media = t.row();
  const avatar = t.document.createElement('div');
  avatar.setAttribute('data-testid', 'Tweet-User-Avatar');
  root.insertBefore(avatar, root.firstChild);

  const box = (left, top, width, height) => () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  });
  root.getBoundingClientRect = box(10, 20, 600, 500);
  media.getBoundingClientRect = box(120, 180, 400, 220);
  avatar.getBoundingClientRect = box(26, 30, 40, 40);

  t.XIW.button.mount(root);

  const control = t.document.querySelector('[data-xiw-control]');
  // Avatar centre is 26 + 20, and the post starts at 10, so the icon lands at 36.
  // The media's vertical centre is 180 + 110, and the post starts at 20, so 270.
  assert.equal(control.style.left, '36px', 'centred on the avatar column, to the left of the images');
  assert.equal(control.style.top, '270px', 'centred on the media, not on the top of the post');
  assert.equal(control.style.transform, 'translate(-50%, -50%)');
  assert.equal(media.contains(control), false);
});

test("a post's own page gets the labelled bar and no overlay", () => {
  const t = setup({ photos: ['a', 'b'], context: 'post' });
  t.XIW.button.mount(t.roots()[0]);

  assert.equal(t.document.querySelector('[data-xiw-control]').className, 'xiw-merge-bar');
  assert.equal(t.document.querySelector('.xiw-merge-gutter'), null, 'no gutter control on the media');
  assert.equal(t.button().classList.contains('xiw-merge-button--icon'), false, 'and the label is shown');
  assert.equal(t.row().style.position, '', 'the media block is left exactly as X laid it out');
});

test('a reply on a post page is a feed card, not the post being read', () => {
  // The URL is a status page either way; only the post whose id matches it is the
  // one being read. Without the id check every reply under a post would grow a bar.
  const t = setup({ photos: ['a', 'b'], context: 'post', tweetId: '999' });

  // Another post on the same page, whose permalink names a different status.
  // Built inline because the fixture builds one post per document.
  const reply = t.document.createElement('article');
  reply.setAttribute('data-testid', 'tweet');
  const permalink = t.document.createElement('a');
  permalink.setAttribute('href', '/ada/status/111');
  reply.appendChild(permalink);
  const row = t.document.createElement('div');
  for (const id of ['c', 'd']) {
    const photo = t.document.createElement('div');
    photo.setAttribute('data-testid', 'tweetPhoto');
    const img = t.document.createElement('img');
    img.setAttribute('src', pbsUrl(id));
    photo.appendChild(img);
    row.appendChild(photo);
  }
  reply.appendChild(row);
  t.document.body.appendChild(reply);

  t.XIW.button.mount(t.roots()[0]);
  t.XIW.button.mount(reply);

  const controls = t.document.querySelectorAll('[data-xiw-control]');
  assert.equal(controls.length, 2, 'both posts have a control');
  assert.equal(controls[0].className, 'xiw-merge-bar', 'the post the page is about gets the bar');
  assert.equal(controls[1].className, 'xiw-merge-gutter', 'and the reply gets the feed shape');
});

// --- 3. it is a real button, and it is styled without X's help -----------------

test('the control is a real labelled button with the required geometry', () => {
  const t = setup({ photos: ['aa', 'bb'] });
  t.XIW.button.mount(t.roots()[0]);
  const injected = t.button();

  assert.equal(injected.tagName, 'BUTTON', 'a real button element, reachable by keyboard');
  assert.equal(injected.getAttribute('type'), 'button', 'and type="button", so it submits nothing');
  assert.equal(injected.getAttribute('aria-label'), ARIA_LABEL, 'announced as the action it performs');
  assert.equal(injected.textContent, 'Merge', 'with a visible label of its own');
  assert.equal(injected.className, 'xiw-merge-button', 'and a namespaced class, not one of X\'s');

  assert.equal(injected.getAttribute('data-xiw-button'), '', 'findable by the tests and by a reader in devtools');
  // In the flow, not positioned over the image. That is the difference between this
  // and the overlay control it replaced, and it is why no z-index or stacking
  // context is needed anywhere.
  assert.equal(injected.style.position, '', 'not positioned: it sits below the media');
  assert.equal(injected.querySelector('.xiw-merge-icon').tagName.toLowerCase(), 'svg', 'with the split-image mark beside the label');
  assert.equal(injected.querySelectorAll('path').length, 3, 'drawn as paths, so it needs no request and inherits the colour');
  assert.equal(injected.querySelector('path').getAttribute('d'), 'M2 4h8v12H2z', 'and it is the split-image mark, not the feed frames');
});

test('one stylesheet, scoped to this extension\'s own classes, injected once', () => {
  const t = setup({ photos: ['aa', 'bb'], quote: { photos: ['cc', 'dd'] } });
  t.XIW.button.mount(t.roots()[0]);
  t.XIW.button.mount(t.roots()[1]);
  assert.equal(t.buttons().length, 2, 'two posts, two buttons');

  const styles = t.document.querySelectorAll('style.xiw-styles');
  assert.equal(styles.length, 1, 'and one stylesheet for the page, not one per post');
  assert.equal(styles[0].parentNode, t.document.head, 'in the head, where it applies to rows injected later');
  assert.equal(styles[0].getAttribute('data-xiw-styles'), '');

  // Text, not effect: jsdom has no cascade, so a rule can be asserted but not what
  // it does. Read the selectors, not a computed colour.
  const css = styles[0].textContent;
  assert.match(css, /\.xiw-merge-bar \{/, 'the bar is styled');
  assert.match(css, /\.xiw-merge-count \{/, 'and the count beside it');
  assert.match(css, /\.xiw-merge-button \{(?:[^}]*?)background-color:\s*rgb\(29, 155, 240\)/, 'a blue pill');
  assert.match(css, /border-radius:\s*9999px/, 'rounded');
  assert.match(css, /\.xiw-merge-button:hover/, 'with a hover state');
  assert.match(css, /\.xiw-merge-button:focus-visible/, 'and a focus ring, because all: initial removes the user agent one');
  assert.match(
    css,
    /\.xiw-merge-button\.xiw-merge-button--busy \{(?:[^}]*)pointer-events:\s*none/,
    'the busy state refuses the pointer, which is the mouse half of aria-disabled'
  );
  assert.match(css, /\.xiw-merge-icon \{/, 'the mark is styled and scoped');
  assert.match(
    css,
    /\.xiw-merge-icon \{[^}]*color:\s*inherit/,
    'the mark inherits the button colour, so gray and Twitter blue actually paint it'
  );
  assert.doesNotMatch(css, /(^|[^-])button\s*\{/, 'no rule that X could read as one of its own buttons');

  // Two variants, two shapes, and the difference asserted rather than assumed.
  const bar = /\.xiw-merge-bar \{([^}]*)\}/.exec(css);
  const gutter = /\.xiw-merge-gutter \{([^}]*)\}/.exec(css);
  assert.ok(bar, 'the post-page bar is styled');
  assert.ok(gutter, 'and the feed gutter is styled');
  assert.doesNotMatch(bar[1], /position:\s*absolute/, 'the bar is in the flow, under the media');
  // Positioned AND layered, which is what fixes the dead click: X's stretched card
  // link is an absolutely positioned overlay over the whole tweet and swallows the
  // click unless the bar paints above it.
  assert.match(bar[1], /position:\s*relative/, 'the bar is positioned, so it beats that overlay');
  assert.match(bar[1], /z-index:\s*\d/, 'and layered');
  assert.match(bar[1], /width:\s*100%/, 'and takes its own line rather than being laid out beside the media');
  // Content height, not 100%. In the column a post is laid out in, a 100% basis is
  // a height, and that is what stretched the pill over the timestamp and the views.
  assert.match(bar[1], /flex:\s*0 0 auto/, 'only as tall as the pill');
  assert.doesNotMatch(bar[1], /flex:\s*0 0 100%/, 'a 100% basis is what covered the views');
  assert.match(bar[1], /pointer-events:\s*none/, 'the empty part of the line does not take clicks meant for the views');
  // Measured off the status page the pill was covering: about one pill-height of
  // black between the gallery and the control, and the same again before the time.
  assert.match(bar[1], /padding:\s*28px 0 28px/, 'a clear gap above the pill and above the timestamp');
  assert.match(gutter[1], /position:\s*absolute/, 'the gutter control is taken out of the post flow');
  assert.doesNotMatch(gutter[1], /left:\s*\d/, 'its horizontal position is measured, not a fixed inset over the picture');
  assert.match(gutter[1], /z-index:\s*\d/, 'and carries its own z-index, since X positions things too');
  assert.match(gutter[1], /pointer-events:\s*none/, 'the gutter box itself does not steal clicks');
  assert.match(css, /button--icon/, 'the icon-only shape is styled');
  // X's action-button colour, not a disc. The same gray sits on black and on white.
  assert.match(css, /button--icon \{(?:[^}]*?)background-color:\s*transparent/, 'no disc');
  assert.match(
    css,
    /button--icon \{(?:[^}]*?)color:\s*rgb\(113,\s*118,\s*123\)/,
    'at rest the icon is X gray, so it sits in the black'
  );
  assert.match(css, /button--icon:hover \{(?:[^}]*?)color:\s*rgb\(29, 155, 240\)/, 'hover turns the icon Twitter blue');
  assert.match(
    css,
    /button--icon:hover \{(?:[^}]*?)background-color:\s*rgba\(29, 155, 240, 0\.1\)/,
    'and the hover wash is that same blue'
  );
  assert.match(css, /\.xiw-merge-dot \{/, 'the per-image dots are styled');
  assert.match(css, /merge-gutter:hover \.xiw-merge-dot/, 'the dots turn with the icon');
  assert.doesNotMatch(css, /rgba\(0,\s*0,\s*0,\s*0\.6\)/, 'the dark disc is gone');
  assert.doesNotMatch(css, /rgba\(255,\s*255,\s*255,\s*0\.2\)/, 'no light disc on the black timeline');
  assert.doesNotMatch(css, /rgba\(255,\s*255,\s*255,\s*0\.42\)/, 'hover does not brighten a white disc');
  assert.doesNotMatch(css, /opacity:\s*0;/, 'nothing is hidden until hovered: both variants are always visible');
  assert.match(css, /@keyframes xiw-merge-pulse/, 'a merge pulses the timeline icon');
  assert.doesNotMatch(css, /xiw-merge-spin|rotate\(360deg\)/, 'the icon does not spin');
  assert.match(
    css,
    /\.xiw-merge-button--icon\.xiw-merge-button--busy \.xiw-merge-icon \{[^}]*animation:\s*xiw-merge-pulse/,
    'the pulse is on the icon, and only while it is busy'
  );
  assert.match(
    css,
    /button--icon\.xiw-merge-button--busy \{[^}]*background-color:\s*transparent/,
    'busy keeps the gutter black: no disc behind the pulse'
  );
  assert.match(css, /prefers-reduced-motion:\s*reduce/, 'reduced motion holds the blue icon and skips the pulse');
});

test('the page theme is still recorded: dark, dim, and light', () => {
  const dark = setup({ photos: ['a', 'b'], context: 'timeline' });
  dark.document.documentElement.style.colorScheme = 'dark';
  dark.document.documentElement.style.backgroundColor = 'rgb(0, 0, 0)';
  dark.XIW.button.mount(dark.roots()[0]);
  assert.equal(dark.document.documentElement.getAttribute('data-xiw-theme'), 'dark');

  // Dim is dark too, even when color-scheme was not set and only the canvas was.
  const dim = setup({ photos: ['a', 'b'], context: 'timeline' });
  dim.document.documentElement.style.backgroundColor = 'rgb(21, 32, 43)';
  dim.XIW.button.mount(dim.roots()[0]);
  assert.equal(dim.document.documentElement.getAttribute('data-xiw-theme'), 'dark', 'X dim is a dark page');

  const light = setup({ photos: ['a', 'b'], context: 'timeline' });
  light.document.documentElement.style.colorScheme = 'light';
  light.document.documentElement.style.backgroundColor = 'rgb(255, 255, 255)';
  light.XIW.button.mount(light.roots()[0]);
  assert.equal(light.document.documentElement.getAttribute('data-xiw-theme'), 'light');
});

// --- 4. the click re-collects the media -----------------------------------------
//
// React re-uses and re-parents DOM nodes, so the media under a root at click
// time is not the media that was there when the button was attached.

test('the click stitches the media that is there now, not the media at mount', async () => {
  const t = setup({ photos: ['mountA', 'mountB'] });
  t.XIW.button.mount(t.roots()[0]);
  const button = t.button();
  assert.ok(button, 'mounted, so there is something to click');

  // A React commit: the same photo containers, new media, and a third tile the
  // mount-time answer could not have known about.
  const row = t.row();
  for (const [index, id] of ['clickA', 'clickB'].entries()) {
    t.photos()[index].querySelector('img').setAttribute('src', pbsUrl(id));
  }
  const extra = t.photos()[1].cloneNode(true);
  extra.querySelector('img').setAttribute('src', pbsUrl('clickC'));
  // Appended to the media block: the button is no longer a child of it, it is in
  // the bar beside it, so it cannot be the insertion reference.
  row.appendChild(extra);

  t.click(button);
  await t.settle();

  assert.deepEqual(
    sawMedia(t.stitched),
    [['clickA:jpg', 'clickB:jpg', 'clickC:jpg']],
    'exactly the media that was under the post when it was clicked, format included',
  );
  assert.equal(t.XIW.collectPhotoIds(t.roots()[0])[0], 'clickA', 'and the mount-time ids are long gone from the page');
});

test('a post that stops being mergeable says so instead of doing nothing', async () => {
  // Mixed media is the interesting version: the control was justified at mount and
  // is not justified now. This used to be a bare return -- a control on screen that
  // is clicked and does nothing, which is the failure the spec calls out. It now
  // reports, and removes itself, because it has nothing left to act on.
  const video = setup({ photos: ['aa', 'bb'] });
  video.XIW.button.mount(video.roots()[0]);
  assert.ok(video.button(), 'mounted while the post was still just two photos');
  const player = video.document.createElement('div');
  player.setAttribute('data-testid', 'videoPlayer');
  video.row().appendChild(player);
  const withVideo = video.click(video.button());
  await video.settle();

  assert.equal(video.stitched.length, 0, 'no stitch for media that is no longer mergeable');
  assert.equal(video.shown.length, 0, 'and no composite shown');
  assert.equal(video.shownErrors.length, 1, 'but a reported failure, not silence');
  assert.match(String(video.shownErrors[0].err && video.shownErrors[0].err.message), /no longer be read/);
  assert.equal(video.button(), null, 'and the dead control is gone rather than left to be clicked again');
  assert.equal(withVideo.defaultPrevented, true, 'the event was still stopped before X could see it');

  const emptied = setup({ photos: ['aa', 'bb'] });
  emptied.XIW.button.mount(emptied.roots()[0]);
  for (const photo of emptied.photos()) photo.remove();
  emptied.click(emptied.button());
  await emptied.settle();

  assert.equal(emptied.stitched.length, 0, 'the same for a post whose media was removed outright');
  assert.equal(emptied.shownErrors.length, 1, 'and it reports too');
  assert.equal(emptied.shown.length, 0, 'no composite for a post with no media');
});

// --- 5. the click is X's click, and only ours ------------------------------------

test('the click handler stops before X\'s own handler sees it', () => {
  const t = setup({ photos: ['aa', 'bb'] });
  t.XIW.button.mount(t.roots()[0]);
  const root = t.roots()[0];
  // X binds its own click handling on the way up to open the media viewer.
  const xHandler = [];
  root.addEventListener('click', () => xHandler.push('x'));

  const event = t.click(t.button());

  assert.deepEqual(xHandler, [], 'X\'s handler never ran: no media viewer opening over the composite');
  assert.equal(event.defaultPrevented, true, 'and the default action was suppressed');
});

test('the click still works for a keyboard user activating the button', async () => {
  // Enter and Space on a real <button> fire a click; the handler is a click
  // listener, so there is nothing key-specific to wire, and nothing to
  // stopPropagation on either.
  const t = setup({ photos: ['aa', 'bb'] });
  t.XIW.button.mount(t.roots()[0]);
  t.button().focus();
  assert.equal(t.document.activeElement, t.button(), 'the button takes focus, even at opacity 0');

  t.button().click();
  await t.settle();

  assert.deepEqual(sawMedia(t.stitched), [['aa:jpg', 'bb:jpg']]);
  assert.equal(t.shown.length, 1, 'and the composite was handed to the overlay');
});

// --- 6. stitch -> overlay, and back to idle --------------------------------------

test('a successful stitch hands the composite and the post\'s meta to the overlay', async () => {
  const t = setup({ photos: ['aa', 'bb'], tweetId: '1234567890', handle: 'ada' });
  t.XIW.button.mount(t.roots()[0]);
  t.click(t.button());
  await t.settle();

  assert.equal(t.shown.length, 1, 'the overlay was shown once');
  assert.equal(t.shownErrors.length, 0, 'and not shown an error');
  const options = t.shown[0];
  assert.equal(options.format, 'image/png', 'the format is passed through, never assumed');
  assert.equal(options.blob.type, 'image/png', 'with the blob stitchImages resolved with');
  assert.deepEqual(options.meta, { tweetId: '1234567890', handle: 'ada' }, 'and the real tweetMeta of this post');

  const button = t.button();
  assert.equal(button.hasAttribute('aria-disabled'), false, 'the button is idle again');
  assert.equal(button.textContent, 'Merge', 'with its idle label');
  assert.equal(button.hasAttribute('aria-busy'), false, 'and no busy state left behind');
  assert.equal(button.className, 'xiw-merge-button', 'and no busy class');
});

test('a failed stitch hands the error and a retry to the overlay, and the button returns to idle', async () => {
  let t;
  t = setup({
    photos: ['aa', 'bb'],
    // The real typed error, built lazily because it belongs to the module
    // instance this setup call is about to create.
    stitch: () => Promise.reject(new t.XIW.StitchError('NETWORK', 'HTTP 404 for media aa')),
  });
  t.XIW.button.mount(t.roots()[0]);
  t.click(t.button());
  await t.settle();

  assert.equal(t.shown.length, 0, 'nothing was shown');
  assert.equal(t.shownErrors.length, 1, 'and the error was reported once');
  const { err, onRetry } = t.shownErrors[0];
  assert.equal(err instanceof t.XIW.StitchError, true, 'the very error stitchImages rejected with');
  assert.equal(err.code, 'NETWORK');
  assert.equal(typeof onRetry, 'function', 'with a function for the overlay to put behind its Retry control');

  const button = t.button();
  assert.equal(button.hasAttribute('aria-disabled'), false, 'the button is idle on failure too');
  assert.equal(button.textContent, 'Merge');
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(button.className, 'xiw-merge-button');
});

test('the retry re-runs the same body, and it re-collects the media as well', async () => {
  let attempts = 0;
  let t;
  t = setup({
    photos: ['aa', 'bb'],
    stitch: () => {
      attempts += 1;
      return Promise.reject(new t.XIW.StitchError('DECODE', 'could not decode media bb'));
    },
  });
  t.XIW.button.mount(t.roots()[0]);
  t.click(t.button());
  await t.settle();
  assert.equal(t.stitched.length, 1);

  // The overlay calls retry from its own click handler, and only from there.
  const retry = t.shownErrors[0].onRetry;
  t.photos()[1].querySelector('img').setAttribute('src', pbsUrl('swapped'));
  await retry();

  assert.equal(t.stitched.length, 2, 'a second attempt, from the same closure');
  assert.deepEqual(
    sawMedia(t.stitched)[1],
    ['aa:jpg', 'swapped:jpg'],
    'and it re-collects the media rather than replaying the first answer',
  );
  assert.equal(t.shownErrors.length, 2, 'a retry that fails again reports again');
  assert.equal(t.buttons()[0].hasAttribute('aria-disabled'), false, 'and the button is idle once more');
});

test('Retry in the real overlay is a click that re-runs the same body', async () => {
  // The one test that keeps XIW.overlay. The user-gesture requirement is a
  // property of the wiring between the two files -- retry has to arrive as a
  // function the overlay's Retry control calls, not as work started on a timer
  // -- and asserting it against a recorder for the overlay would assert nothing.
  let t;
  t = setup({
    photos: ['aa', 'bb'],
    realOverlay: true,
    stitch: () => Promise.reject(new t.XIW.StitchError('NETWORK', 'HTTP 404 for media aa')),
  });
  t.XIW.button.mount(t.roots()[0]);
  t.click(t.button());
  await t.settle();
  assert.equal(t.stitched.length, 1, 'the first attempt was made and failed');

  const host = t.document.querySelector('[data-xiw-overlay]');
  assert.ok(host && host.shadowRoot, 'the real overlay opened itself');
  const retry = host.shadowRoot.querySelector('.retry');
  assert.equal(retry.hidden, false, 'and offered a Retry, because one was passed');
  assert.equal(t.stitched.length, 1, 'showing the panel did not retry anything by itself');

  retry.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await t.settle();

  assert.equal(t.stitched.length, 2, 'the Retry control is what re-ran the same body');
  assert.equal(t.button().hasAttribute('aria-disabled'), false, 'and the button is idle again');
});

// --- 7. the busy state ------------------------------------------------------------

test('a second click while the first stitch is in flight does nothing', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const t = setup({
    photos: ['aa', 'bb'],
    stitch: () => gate.then(() => ({ blob: new t.window.Blob(['x'], { type: 'image/png' }), format: 'image/png' })),
  });
  t.XIW.button.mount(t.roots()[0]);
  const button = t.button();

  t.click(button);
  await t.settle();
  assert.equal(t.stitched.length, 1, 'the first click started a stitch');
  assert.equal(button.getAttribute('aria-busy'), 'true', 'and the button says so: aria-busy, aria-disabled and a different label');
  assert.equal(button.getAttribute('aria-disabled'), 'true', 'reported unavailable without leaving the tab order');
  assert.equal(button.disabled, false, 'and NOT the disabled attribute, which would drop the focus it already has');
  assert.equal(button.textContent, 'Merging...');
  assert.match(button.className, /xiw-merge-button--busy/, 'and the class that keeps it visible and refuses the pointer');

  // Focus is the reason. A disabled button cannot hold it, so setting the
  // attribute here would move a keyboard user's focus to <body> and re-enabling
  // it would not move it back.
  button.focus();
  assert.equal(t.document.activeElement, button, 'the busy button still takes focus');
  t.click(button);
  await t.settle();
  assert.equal(t.stitched.length, 1, 'a second click while busy is refused rather than starting a second composite');
  assert.equal(t.shown.length, 0, 'nothing shown while the first is still running');
  assert.equal(t.document.activeElement, button, 'and refusing it did not cost the focus either');

  release();
  await t.settle();
  assert.equal(t.shown.length, 1, 'and the first attempt is still the one that lands');
  assert.equal(button.hasAttribute('aria-disabled'), false, 'with the button idle again');
});

// --- 7b. focus, which the busy state used to destroy -----------------------------
//
// The real overlay, because the claim is about what the overlay does with
// document.activeElement: open() snapshots it and hide() gives it back. A
// recorder for the overlay could not see either.

test('a keyboard user still holds the Merge button when the overlay opens and when it closes', async () => {
  const t = setup({ photos: ['aa', 'bb'], realOverlay: true });
  const focusedAtOpen = [];
  const realShow = t.XIW.overlay.show;
  t.XIW.overlay.show = (options) => {
    focusedAtOpen.push(t.document.activeElement);
    realShow.call(t.XIW.overlay, options);
  };

  t.XIW.button.mount(t.roots()[0]);
  const button = t.button();
  button.focus();
  // What Enter produces in a browser, and the one path that has no hover to
  // reveal the control first.
  button.click();
  await t.settle();

  assert.equal(t.stitched.length, 1, 'the keyboard activation started the stitch');
  assert.deepEqual(focusedAtOpen, [button], 'and the overlay was handed the button, not <body>');

  t.XIW.overlay.hide();
  assert.equal(t.document.activeElement, button, 'and closing gave the focus back to it, so the next Tab continues from the post');
  assert.equal(button.getAttribute('aria-disabled'), null, 'with the control live again');
});

// --- 7c. nothing escapes as an unhandled rejection ------------------------------
//
// Two call sites, two tests: the click, and the retry the overlay's own control
// invokes. Both promises have no other consumer, so both have to end in a catch.

async function captureEscapes(run) {
  const unhandled = [];
  const errors = [];
  // With a listener attached Node reports an unhandled rejection as an event
  // rather than raising it, so this observes the promise instead of dying on it.
  const onUnhandled = (reason) => unhandled.push(reason);
  const onError = (...args) => errors.push(args);
  process.on('unhandledRejection', onUnhandled);
  console.error = onError;
  try {
    await run();
    // Two macrotasks: one for the click handler's promise chain, one for Node to
    // decide the rejection had no handler.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    console.error = originalConsoleError;
  }
  return { unhandled, errors };
}

test('a throw from the overlay is named once, not left as an unhandled rejection', async () => {
  const { unhandled, errors } = await captureEscapes(async () => {
    const t = setup({ photos: ['aa', 'bb'], realOverlay: true });
    // overlay.js anticipates this: it says a non-Blob blob means the caller's
    // await has already rejected and createObjectURL throws on top of it.
    const boom = new Error('Failed to execute createObjectURL: parameter 1 is not of type Blob');
    t.XIW.overlay.show = () => {
      throw boom;
    };

    t.XIW.button.mount(t.roots()[0]);
    t.click(t.button());
    await t.settle();
  });

  assert.deepEqual(unhandled, [], 'no rejected promise escaped');
  assert.equal(errors.length, 1, 'and it was named in the console once');
  assert.equal(errors[0][0], 'X Image Weaver: the overlay threw while showing a composite');
  assert.match(errors[0][1].message, /createObjectURL/, 'with the error itself rather than a string about it');
});

test('the same for the retry path, whose promise the overlay never consumes', async () => {
  const { unhandled, errors } = await captureEscapes(async () => {
    let attempts = 0;
    let t;
    t = setup({
      photos: ['aa', 'bb'],
      realOverlay: true,
      // Fails once so the real overlay records a retry, succeeds after so the
      // retry reaches show().
      stitch: () => (attempts++ === 0
        ? Promise.reject(new t.XIW.StitchError('NETWORK', 'HTTP 404 for media aa'))
        : Promise.resolve({ blob: new t.window.Blob(['x'], { type: 'image/png' }), format: 'image/png' })),
    });
    t.XIW.overlay.show = () => {
      throw new Error('Failed to execute createObjectURL: parameter 1 is not of type Blob');
    };

    t.XIW.button.mount(t.roots()[0]);
    t.click(t.button());
    await t.settle();
    const retry = t.document.querySelector('[data-xiw-overlay]').shadowRoot.querySelector('.retry');
    retry.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await t.settle();
  });

  assert.deepEqual(unhandled, [], 'no rejected promise escaped from the retry either');
  assert.equal(errors.length, 1, 'and it was named once, by the same line');
});

// --- 8. the shape of the file, which the behaviour above cannot check -------------

test('button.js declares only the XIW namespace at the top level', () => {
  const source = readFileSync(new URL('../src/button.js', import.meta.url), 'utf8');
  assert.equal(
    source.split('\n')[0],
    'var XIW = (globalThis.XIW = globalThis.XIW || {});',
    'the XIW line is first, and outside the IIFE like every other content script'
  );
  // loader.test.mjs proves what escapes to globalThis; this proves the file asks
  // for nothing to get here, which is why the manifest can declare no
  // permissions and a reviewer need not take that on trust.
  assert.doesNotMatch(source, /\bchrome\./, 'no extension API is called');
  assert.doesNotMatch(source, /\bbrowser\./, 'nor the Firefox one');
});

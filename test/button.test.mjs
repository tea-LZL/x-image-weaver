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
// that do work this file is not about are replaced: XIW.stitchVertical (no
// createImageBitmap, no canvas -- stitch.js has no automated test by design) and
// XIW.overlay, except in the one test that needs the real one for Retry.

const BUTTON = 'button.xiw-merge-button';
const ARIA_LABEL = 'Merge images into one';
const pbsUrl = (id) => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;

// A fresh document and a fresh module instance per test: loadAll() resets XIW
// and re-evaluates the six manifest scripts, and a new fixture document keeps
// one test's injected buttons out of the next test's queries.
function setup({ photos = [], videos = 0, quote = null, tweetId = '123', handle = 'ada', stitch, realOverlay = false } = {}) {
  const document = tweetFixture({ photos, videos, quote, tweetId, handle });
  const window = document.defaultView;
  const XIW = loadAll({ document });

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

  XIW.stitchVertical = (ids) => {
    stitched.push(ids.slice());
    return respond(ids);
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

  return { document, window, XIW, stitched, shown, shownErrors, button, buttons, roots, photos: photos_, row, click, settle };
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

test('the button is a child of the media row for a 2-photo and a 4-photo post', () => {
  for (const count of [2, 4]) {
    const t = setup({ photos: Array.from({ length: count }, (_, i) => `p${i}`) });
    t.XIW.button.mount(t.roots()[0]);

    const row = t.row();
    const injected = t.button();
    assert.ok(injected, `${count} photos: a button exists`);
    assert.equal(injected.parentElement, row, `${count} photos: its parent is the media row`);
    assert.equal(injected.closest('[data-testid="tweetPhoto"]'), null, `${count} photos: and it is not inside a photo container`);
    assert.equal(t.photos().length, count, `${count} photos: the fixture really had that many`);
    for (const photo of t.photos()) {
      assert.equal(photo.parentElement, row, `${count} photos: every photo shares the row the button is on`);
    }
    assert.equal(row.getAttribute('data-xiw-row'), '', `${count} photos: the row is marked as ours`);
    assert.equal(t.buttons().length, 1, `${count} photos: exactly one`);
  }
});

test('a quoted post\'s media never decides where the outer button lands', () => {
  const t = setup({ photos: ['aa', 'bb'], quote: { photos: ['cc', 'dd'] } });
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

  const injected = t.button();
  const ownPhoto = Array.from(t.photos()).find((photo) => photo.closest('[data-testid="quoteTweet"]') === null);
  assert.ok(ownPhoto, 'the outer post still has photos of its own');
  assert.equal(injected.parentElement, ownPhoto.parentElement, 'the button is on the outer post\'s own row');
  assert.equal(injected.closest('[data-testid="quoteTweet"]'), null, 'and nowhere near the quoted post\'s row');
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

  assert.equal(injected.style.position, 'absolute', 'positioned against the row');
  assert.equal(injected.style.top, '8px');
  assert.equal(injected.style.right, '8px');
  assert.equal(injected.getAttribute('data-xiw-button'), '', 'findable by the tests and by a reader in devtools');
});

test('the media row is made positioned, and only when it is not positioned already', () => {
  const bare = setup({ photos: ['aa', 'bb'] });
  bare.XIW.button.mount(bare.roots()[0]);
  assert.equal(bare.row().style.position, 'relative', 'an unpositioned row is given position: relative');
  assert.equal(bare.row().className, 'xiw-media-row', 'and the class the reveal rule is scoped to');

  // X lays its media out with positioned cells, and overwriting one of those
  // would move the post's images to be our button's containing block.
  for (const existing of ['absolute', 'fixed', 'sticky']) {
    const t = setup({ photos: ['aa', 'bb'] });
    const row = t.row();
    row.style.position = existing;
    t.XIW.button.mount(t.roots()[0]);

    assert.equal(row.style.position, existing, `a row already positioned ${existing} keeps it`);
    assert.equal(t.buttons().length, 1, 'and still gets its button');
  }
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

  // Text, not effect: jsdom has no cascade, so a rule can be asserted but not
  // what it does. Read the selector, not a computed opacity.
  const css = styles[0].textContent;
  assert.match(css, /\.xiw-media-row:hover \.xiw-merge-button/, 'revealed on row hover');
  assert.match(css, /\.xiw-merge-button:hover/, 'and on its own hover, so it survives a re-render that takes the row class back');
  assert.match(css, /\.xiw-merge-button:focus-within/, 'and on its own focus-within, so Tab reaches a visible control');
  assert.match(css, /\.xiw-merge-button \{(?:[^}]*)opacity:\s*0;/, 'invisible by default');
  assert.match(css, /transition:\s*opacity 0\.12s/, 'fading rather than blinking');
  assert.doesNotMatch(css, /(^|[^-])button\s*\{/, 'no rule that X could read as one of its own buttons');
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
  row.insertBefore(extra, button);

  t.click(button);
  await t.settle();

  assert.deepEqual(t.stitched, [['clickA', 'clickB', 'clickC']], 'exactly the media that was under the post when it was clicked');
  assert.equal(t.XIW.collectPhotoIds(t.roots()[0])[0], 'clickA', 'and the mount-time ids are long gone from the page');
});

test('a post that stops being mergeable after mount does nothing when clicked', async () => {
  // Mixed media is the interesting version: the button was justified at mount
  // and is not justified now, and there is nothing to report about a post that
  // cannot be merged.
  const video = setup({ photos: ['aa', 'bb'] });
  video.XIW.button.mount(video.roots()[0]);
  assert.ok(video.button(), 'mounted while the post was still just two photos');
  const player = video.document.createElement('div');
  player.setAttribute('data-testid', 'videoPlayer');
  video.row().appendChild(player);
  const withVideo = video.click(video.button());
  await video.settle();

  assert.equal(video.stitched.length, 0, 'no stitch for media that is no longer mergeable');
  assert.equal(video.shown.length, 0, 'no overlay');
  assert.equal(video.shownErrors.length, 0, 'and no error: this is a silent no-op, not a failure');
  assert.equal(withVideo.defaultPrevented, true, 'though the event was still stopped before X could see it');
  assert.equal(video.button().disabled, false, 'and the button never went busy');
  assert.equal(video.button().textContent, 'Merge');

  const emptied = setup({ photos: ['aa', 'bb'] });
  emptied.XIW.button.mount(emptied.roots()[0]);
  for (const photo of emptied.photos()) photo.remove();
  emptied.click(emptied.button());
  await emptied.settle();

  assert.equal(emptied.stitched.length, 0, 'the same for a post whose media was removed outright');
  assert.equal(emptied.shown.length + emptied.shownErrors.length, 0);
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

  assert.deepEqual(t.stitched, [['aa', 'bb']]);
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
  assert.equal(options.blob.type, 'image/png', 'with the blob stitchVertical resolved with');
  assert.deepEqual(options.meta, { tweetId: '1234567890', handle: 'ada' }, 'and the real tweetMeta of this post');

  const button = t.button();
  assert.equal(button.disabled, false, 'the button is idle again');
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
  assert.equal(err instanceof t.XIW.StitchError, true, 'the very error stitchVertical rejected with');
  assert.equal(err.code, 'NETWORK');
  assert.equal(typeof onRetry, 'function', 'with a function for the overlay to put behind its Retry control');

  const button = t.button();
  assert.equal(button.disabled, false, 'the button is idle on failure too');
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
  assert.deepEqual(t.stitched[1], ['aa', 'swapped'], 'and it re-collects the media rather than replaying the first answer');
  assert.equal(t.shownErrors.length, 2, 'a retry that fails again reports again');
  assert.equal(t.buttons()[0].disabled, false, 'and the button is idle once more');
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
  assert.equal(t.button().disabled, false, 'and the button is idle again');
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
  assert.equal(button.disabled, true, 'and the button says so: disabled, aria-busy, and a different label');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.textContent, 'Merging...');
  assert.match(button.className, /xiw-merge-button--busy/, 'and the class that keeps it visible when the pointer leaves the row');

  t.click(button);
  await t.settle();
  assert.equal(t.stitched.length, 1, 'a second click while busy is refused rather than starting a second composite');
  assert.equal(t.shown.length, 0, 'nothing shown while the first is still running');

  release();
  await t.settle();
  assert.equal(t.shown.length, 1, 'and the first attempt is still the one that lands');
  assert.equal(button.disabled, false, 'with the button idle again');
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

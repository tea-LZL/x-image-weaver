import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadAll } from './harness.mjs';

// main.js is the bootstrap: it finds tweet roots as they appear and calls
// button.mount on each one exactly once. The real src/main.js runs here, through
// the same loadAll() the other suites use, against a real jsdom
// MutationObserver.
//
// The collaborator it reaches is the real one too -- button.mount, on top of
// dom.js's collectPhotoIds -- because what is under test is the hand-off, and a
// stubbed mount() would make these tests assert only that a function was called.
// Only the three globals a content script finds on the host and this process
// does not are supplied; see hostGlobals below.
//
// Why the mutation cases are built here and not in test/fixtures.mjs: the
// fixture builds a *document*, so it can express a tweet that exists and a quote
// nested inside it, but not a change to a live document watched by a live
// observer. `appendChild` after the extension has started is a different event
// from `appendChild` before it, and a fixture cannot produce the former. Every
// scenario below that is about timing or about the observer therefore constructs
// its mutation inline, against a document that already has the extension running
// on it.

const BUTTON = 'button.xiw-merge-button';
const MARKER = 'data-xiw-done';
const ROOTS = 'article[data-testid="tweet"], div[data-testid="quoteTweet"]';
const pbsUrl = (id) => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;

// boot() builds a window, optionally puts a tweet in it, and only then starts the
// extension -- so a tweet passed in is one main.js's initial scan finds. Pass
// `{ photos: null }` for a document with no tweet at all, which is what the
// mutation tests need: their scenario is a tweet arriving after startup, and a
// boot-time tweet in the same document would make "exactly one button" ambiguous.
//
// pretendToBeVisual: true is what supplies requestAnimationFrame, and it is not
// optional: hostGlobals below binds it, so without it every test in this file
// throws at boot rather than passing vacuously. Note what would NOT catch it --
// main.js's boot guard checks MutationObserver, not rAF, so a window missing
// only rAF would start the extension and then throw inside the first drain.
//
// loadAll() evaluates all six manifest scripts into globalThis and main.js starts
// as the last of them, so that one call is the extension booting.
function boot({ photos = ['aa', 'bb'], tag = 'article', testid = 'tweet' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://x.com/',
    pretendToBeVisual: true,
  });
  const { document, window } = dom.window;
  if (photos !== null) document.body.appendChild(tweet(document, { photos, tag, testid }));
  const XIW = loadAll(hostGlobals(window));
  return { dom, document, window, XIW };
}

function empty() {
  return boot({ photos: null });
}

// The three globals a content script finds on the host and this process does not,
// in one place because passing them per call is noise. The last one is the one
// that matters: jsdom provides requestAnimationFrame only under
// pretendToBeVisual, and without it main.js's drain has nothing to call.
const hostGlobals = (window) => ({
  document: window.document,
  MutationObserver: window.MutationObserver,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
});

// One tweet, shaped the way dom.js reads it: a permalink, an author cell, and a
// media row holding one tweetPhoto container per media id. Built against a live
// document so it can be appended to one.
function tweet(document, { photos = ['aa', 'bb'], testid = 'tweet', tag = 'article' } = {}) {
  const root = document.createElement(tag);
  root.setAttribute('data-testid', testid);

  const permalink = document.createElement('a');
  permalink.setAttribute('href', '/ada/status/123');
  root.appendChild(permalink);

  const cell = document.createElement('div');
  cell.setAttribute('data-testid', 'User-Name');
  const profile = document.createElement('a');
  profile.setAttribute('href', '/ada');
  cell.appendChild(profile);
  root.appendChild(cell);

  const row = document.createElement('div');
  for (const id of photos) {
    const photo = document.createElement('div');
    photo.setAttribute('data-testid', 'tweetPhoto');
    const img = document.createElement('img');
    img.setAttribute('src', pbsUrl(id));
    photo.appendChild(img);
    row.appendChild(photo);
  }
  root.appendChild(row);

  return root;
}

const buttons = (document) => document.querySelectorAll(BUTTON);
const rootsIn = (document) => document.querySelectorAll(ROOTS);
const marked = (document) => document.querySelectorAll(`[${MARKER}]`);

// Wait for real animation frames on the window under test.
//
// Not a setTimeout: the drain is a requestAnimationFrame callback and jsdom's
// frames are ~16ms apart, so a zero-delay timer can resolve BEFORE the frame the
// extension is waiting for, and the test then fails on timing rather than on
// behaviour. Not a promise the extension resolves either -- that is the mistake
// that lets a drain which never runs pass.
//
// Three frames rather than one, because a rAF registered from inside a rAF
// callback is deferred to the following frame, so the frame the observer's
// microtask schedules is not the frame this returns from.
const settle = (window) =>
  new Promise((resolve) => {
    let left = 3;
    const tick = () => (left-- <= 0 ? resolve() : window.requestAnimationFrame(tick));
    window.requestAnimationFrame(tick);
  });

// Replace XIW.button.mount with a counter that still calls the real one, and
// return the array of roots it was handed.
//
// Delegating is the whole point: a spy that recorded calls without calling
// through would report the right counts against an extension that had processed
// nothing at all. It is safe for main.js to be spied this way precisely because
// main.js looks the method up on the namespace at call time
// (`XIW.button.mount(root)`) rather than capturing it in a local.
function spyOnMount(XIW) {
  const real = XIW.button.mount;
  const calls = [];
  XIW.button.mount = (root) => {
    calls.push(root);
    return real(root);
  };
  return calls;
}

// --- 1. tweets already on screen -----------------------------------------------

test('the initial scan covers the timeline already rendered', () => {
  // A window built with the tweet already in it, then the extension started on
  // top. No mutation is involved: this is main.js's startup scan, over a post
  // that was on screen before it ever ran.
  const { document } = boot();

  assert.equal(buttons(document).length, 1);
  assert.equal(marked(document).length, 1);
});

// A post with no media gets a marker and no button: the marker records that the
// root was processed, not that it was mergeable. That distinction is what keeps
// a later mutation touching a non-mergeable post from retrying it forever.
test('a non-mergeable root is marked and skipped without a button', async () => {
  const { document, window } = empty();
  document.body.appendChild(tweet(document, { photos: ['aa'] }));
  document.body.appendChild(tweet(document, { photos: [] }));
  await settle(window);

  assert.equal(buttons(document).length, 0);
  assert.equal(marked(document).length, 2);
});

// --- 2. a tweet added after startup, through a real observer -------------------

test('a tweet added after startup is mounted by the live observer', async () => {
  const { document, window } = empty();
  assert.equal(buttons(document).length, 0, 'nothing is mounted in an empty document');

  const article = tweet(document);
  document.body.appendChild(article);
  await settle(window);

  assert.equal(article.querySelectorAll(BUTTON).length, 1);
  assert.equal(article.getAttribute(MARKER), '');
});

// Proof that it is the observer and not something else: the extension watches
// one subtree, so a tweet inside a *detached* node is never observed and must not
// get a button, while the same tweet shape inside a live one must. Two cases, one
// variable.
test('discovery tracks the observed subtree, not tweets in general', async () => {
  const { document, window } = empty();

  const detachedHost = document.createElement('div');
  const inDetached = tweet(document);
  detachedHost.appendChild(inDetached);
  await settle(window);
  assert.equal(inDetached.querySelectorAll(BUTTON).length, 0);

  const inLive = tweet(document);
  document.body.appendChild(inLive);
  await settle(window);
  assert.equal(inLive.querySelectorAll(BUTTON).length, 1);
});

// --- 3. exactly once -----------------------------------------------------------

// button.mount is idempotent, so a button count cannot tell a correct marker
// check from one that never matches. Three of the tests in this section wrap the
// real mount in a counting spy that DELEGATES, so the number of mount calls is
// observable while the DOM still ends up exactly as it would without the spy.

test('a burst of roots added in one commit is each mounted exactly once', async () => {
  const { document, window } = empty();

  // One append of one container holding five tweets: the shape a scroll or a
  // route change produces, and the case the Set and the rAF exist for.
  const batch = document.createElement('div');
  for (let i = 0; i < 5; i++) batch.appendChild(tweet(document, { photos: [`i${i}`, `j${i}`] }));
  document.body.appendChild(batch);
  await settle(window);

  assert.equal(rootsIn(document).length, 5);
  assert.equal(buttons(document).length, 5);
  assert.equal(marked(document).length, 5);
  for (const root of rootsIn(document)) {
    assert.equal(root.querySelectorAll(BUTTON).length, 1, 'one button per root, not per scan');
  }
});

test('two bursts in the same frame mount each root once', async () => {
  const { document, window } = empty();

  const first = document.createElement('div');
  first.appendChild(tweet(document));
  const second = document.createElement('div');
  second.appendChild(tweet(document));
  document.body.appendChild(first);
  document.body.appendChild(second);
  await settle(window);

  assert.equal(buttons(document).length, 2);
  assert.equal(marked(document).length, 2);
});

// The same node queued twice within one burst, which the Set collapses and the
// marker would catch anyway. Asserting the button count here is a weaker
// statement than it looks, so the comment is explicit that this covers the Set's
// behaviour only at the observable level: the same node appearing in the queue
// twice is not distinguishable from it appearing once by anything a test can see
// from outside the IIFE.
test('the same node queued twice in one burst yields one button', async () => {
  const { document, window } = empty();

  const article = tweet(document);
  const host = document.createElement('div');
  host.appendChild(article);
  // What the observer actually records here is `host`, twice, not the article:
  // the article is never an addedNodes entry, it is found by scanning host's
  // subtree. So the same node reaches the queue twice and the Set collapses it to
  // one scan -- but the marker would collapse the second scan anyway, which is
  // why the note above says this asserts the outcome and not the Set.
  // Detach and re-attach inside the same synchronous block, so both childList
  // records land before any frame runs.
  document.body.appendChild(host);
  host.removeChild(article);
  host.appendChild(article);
  await settle(window);

  assert.equal(article.querySelectorAll(BUTTON).length, 1);
  assert.equal(marked(document).length, 1);
});

// One root throwing must not cost its neighbours their button.
//
// The drain empties the queue into a snapshot before scanning, so a node that is
// skipped by an exception has no second copy anywhere -- the only thing that would
// bring it back is a later mutation touching the same subtree, which for a post
// already scrolled past may never come. The throwing root itself is protected by
// the mark-before-mount ordering; this is the sibling case, which that reasoning
// does not reach.
test('a throwing root does not stop the rest of the frame from mounting', async () => {
  const { document, window, XIW } = empty();

  const bad = tweet(document);
  const good = tweet(document);
  const host = document.createElement('div');
  host.appendChild(bad);
  host.appendChild(good);

  const real = XIW.button.mount;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  XIW.button.mount = (root) => {
    if (root === bad) throw new Error('boom');
    return real(root);
  };

  document.body.appendChild(host);
  await settle(window);

  console.error = realError;
  XIW.button.mount = real;

  assert.equal(good.querySelectorAll(BUTTON).length, 1, 'the neighbour is still mounted');
  assert.equal(errors.length, 1, 'and the failure was reported rather than swallowed');
  assert.match(String(errors[0][0]), /could not decorate/);
});

// The recovery guarantee the drain's `isConnected` skip depends on.
//
// That skip drops any queued node React detached before the frame ran. If a tweet
// detached in one commit and re-attached in a later one were dropped for good, the
// skip would trade wasted work for a permanently undecorated post -- a regression
// that only appears under a route change mid-scroll, which is exactly the kind of
// thing a manual checklist does not reliably catch.
//
// It is safe because re-attachment is itself a childList mutation, so the node is
// enqueued again. This locks that: mounted, removed, mounted again.
test('a root that is detached before the frame and re-attached later is still mounted', async () => {
  const { document, window } = empty();

  const article = tweet(document);
  document.body.appendChild(article);
  // Removed in the same synchronous block, so the drain never sees it connected
  // and skips it.
  article.remove();
  await settle(window);
  assert.equal(article.querySelectorAll(BUTTON).length, 0, 'skipped while detached');
  assert.equal(article.getAttribute(MARKER), null, 'and not marked, so it is eligible again');

  // A later commit puts it back. The observer reports that as an addition, so the
  // drain gets a second look at a node that was never marked.
  document.body.appendChild(article);
  await settle(window);
  assert.equal(article.querySelectorAll(BUTTON).length, 1);
  assert.equal(article.getAttribute(MARKER), '');
});

// The one test that can tell a correct marker check from a broken one.
//
// button.mount is itself idempotent, so every test above asserting "one button"
// would still pass against a marker check that never matched -- a truthiness
// test against the empty string, say, which is the natural way to get this
// wrong. The button count cannot see the difference; the number of mount CALLS
// can. So the real mount is wrapped in a counter that delegates, and the root
// is then presented to the extension a second time.
//
// Delegating rather than replacing is the point: a spy that recorded calls
// without calling through would pass even if every root went unprocessed.
// spyOnMount does the wrapping; see its definition for why it is one function
// rather than three copies.
test('a second presentation of a root does not call mount again', async () => {
  const { document, window, XIW } = empty();

  const calls = spyOnMount(XIW);

  const article = tweet(document);
  document.body.appendChild(article);
  await settle(window);
  assert.equal(calls.length, 1, 'the first presentation mounts');
  assert.equal(article.querySelectorAll(BUTTON).length, 1);

  // Re-insert the same node under a different parent: the observer sees it
  // again, scan finds it again, and only the marker can stop a second mount.
  const elsewhere = document.createElement('section');
  document.body.appendChild(elsewhere);
  elsewhere.appendChild(article);
  await settle(window);

  assert.equal(calls.length, 1, 'the marker stopped the second mount, not mount() being idempotent');
  assert.equal(article.querySelectorAll(BUTTON).length, 1);
});

// The same question for a burst: five roots in one commit is five mounts, not
// five roots times however many nodes React added around them.
test('a burst produces one mount call per root and no more', async () => {
  const { document, window, XIW } = empty();

  const calls = spyOnMount(XIW);

  // Five tweets nested one level down plus a sixth as a direct child of the
  // container, so the roots sit at two depths under the single added node --
  // scan's descendants branch has to find all six, and only one of them is
  // reachable from the container itself.
  const batch = document.createElement('div');
  batch.appendChild(tweet(document, { photos: ['dd', 'ee'] }));
  for (let i = 0; i < 5; i++) {
    const inner = document.createElement('div');
    inner.appendChild(tweet(document, { photos: [`i${i}`, `j${i}`] }));
    batch.appendChild(inner);
  }
  document.body.appendChild(batch);
  await settle(window);

  assert.equal(calls.length, 6, 'one call per root, at either depth');
  assert.equal(new Set(calls).size, 6, 'and no root was passed to mount twice');
});

// The one thing the drain skips, and the reason it is worth having.
//
// A node React inserts and then removes again before the next frame -- a keyed
// list reconciling, a route change landing mid-scroll -- arrives in the queue and
// is detached by the time the drain runs. Scanning it would run the full
// collectPhotoIds query and a mount() on a subtree about to be dropped, which is
// the expensive part of this file spent on nothing.
//
// It cannot be observed from the document: a mount into a detached subtree is
// invisible either way, so the button count is 0 whether the skip happens or
// not. What is observable is whether mount was called, hence the counting spy.
test('a root added and removed within one frame is never mounted', async () => {
  const { document, window, XIW } = empty();

  const calls = spyOnMount(XIW);

  const throwaway = tweet(document);
  document.body.appendChild(throwaway);
  throwaway.remove();
  await settle(window);

  assert.equal(calls.length, 0, 'the drain skipped a node that is no longer in the document');
  assert.equal(buttons(document).length, 0);
  assert.equal(marked(document).length, 0);

  // And the skip is not a blanket "ignore anything odd": the same root, still
  // attached when the drain runs, is mounted normally. Without this the test
  // would also pass for an implementation that dropped everything queued.
  const survivor = tweet(document);
  document.body.appendChild(survivor);
  await settle(window);
  assert.equal(calls.length, 1);
  assert.equal(survivor.querySelectorAll(BUTTON).length, 1);
});

// --- 4. quoted tweets ----------------------------------------------------------

test('a quoted tweet is a root in its own right', async () => {
  const { document, window } = empty();

  // Bare, on its own -- not nested in an article. X renders quoted posts as a
  // plain div carrying the quoteTweet testid, and an article-only observer would
  // miss every one of them.
  const quoted = tweet(document, { testid: 'quoteTweet', tag: 'div' });
  document.body.appendChild(quoted);
  await settle(window);

  assert.equal(quoted.getAttribute(MARKER), '');
  assert.equal(quoted.querySelectorAll(BUTTON).length, 1);
});

// The full quoting shape: an article with its own two photos, a quoteTweet div
// inside it, and a quoted article inside that -- the same nesting
// test/fixtures.mjs builds, and the one X renders.
//
// Three roots, not two, and that is the assertion that matters. The quoted post
// is an article[data-testid="tweet"] in its own right, so the composed selector
// matches it as well as the wrapper and the outer post. Only the wrapper is
// load-bearing here (a wrapper with no article inside it is the shape a quote
// takes when the quoted post renders as a plain div), but all three are roots
// and all three get the marker.
test('an article quoting a post: every root is marked, and the outer takes only its own media', async () => {
  const { document, window, XIW } = empty();

  const outer = tweet(document, { photos: ['aa', 'bb'] });
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'quoteTweet');
  // The quoted post's photos, under ids distinct from the outer's so "which
  // media did this button end up on" is answerable from the DOM.
  const quoted = tweet(document, { photos: ['cc', 'dd'] });
  wrapper.appendChild(quoted);
  outer.appendChild(wrapper);
  document.body.appendChild(outer);
  await settle(window);

  assert.equal(rootsIn(document).length, 3, 'the outer article, the wrapper, and the quoted article');
  assert.equal(marked(document).length, 3);

  // Two buttons for two mergeable posts, not three and not one. The wrapper and
  // the quoted article share a media row -- the wrapper's own photos ARE the
  // quoted article's, by dom.js's `wrapper === root` case -- and button.mount
  // creates at most one button per row, so the two roots that name the same row
  // produce one control between them.
  assert.equal(buttons(document).length, 2);
  assert.equal(quoted.querySelectorAll(BUTTON).length, 1);
  assert.equal(wrapper.querySelectorAll(BUTTON).length, 1);

  // The containment question button.js's placement rule exists for: the outer
  // post's button is on the outer post's row and is not inside the quote at all.
  // Observable in jsdom, even though the crop that would hide a misplaced button
  // needs a layout engine.
  assert.equal(outer.querySelector(BUTTON).closest('[data-testid="quoteTweet"]'), null);
  assert.ok(wrapper.querySelector(BUTTON).closest('[data-testid="quoteTweet"]'));

  // The ownership rule, asserted against the value the rule produces and not
  // against the DOM it reads. dom.js's `quote !== root && root.contains(quote)`
  // filter decides which media a root owns; it moves no nodes, so counting
  // tweetPhoto elements off the DOM cannot detect a regression in it -- the
  // fixture is what put those elements there, and they stay there either way.
  // collectPhotoIds is the filter's output, so a broken filter changes this.
  assert.deepEqual(XIW.collectPhotoIds(outer), ['aa', 'bb'], 'the outer owns only its own media');
  assert.deepEqual(XIW.collectPhotoIds(wrapper), ['cc', 'dd'], 'the wrapper owns the media it wraps');
  assert.deepEqual(XIW.collectPhotoIds(quoted), ['cc', 'dd'], 'and the quoted article agrees');

  // Where the two buttons physically landed, which is a separate question from
  // ownership and is observable in jsdom even though the crop that would hide a
  // misplaced button needs a layout engine.
  const outerRow = outer.querySelector('[data-testid="tweetPhoto"]').parentElement;
  assert.equal(outerRow.querySelectorAll('[data-testid="tweetPhoto"]').length, 2);
  assert.equal(outerRow.querySelectorAll(BUTTON).length, 1, "the outer button is on the outer's row");
});

// The same shape arriving after startup, which is the case that actually happens
// on X: a post quoting a mergeable gallery is composed by the reader scrolling,
// not rendered on page load. Proves the observer finds the nested roots and not
// just the outermost one.
test('a quote nested in a post added later mounts every root once', async () => {
  const { document, window } = empty();

  const outer = tweet(document, { photos: ['aa', 'bb'] });
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'quoteTweet');
  wrapper.appendChild(tweet(document, { photos: ['cc', 'dd'] }));
  outer.appendChild(wrapper);
  document.body.appendChild(outer);
  await settle(window);

  assert.equal(marked(document).length, 3, 'the nested roots are found, not just the outer one');
  assert.equal(buttons(document).length, 2);
  assert.equal(outer.querySelector(BUTTON).closest('[data-testid="quoteTweet"]'), null);
  assert.ok(wrapper.querySelector(BUTTON));
});

// --- 5. the observed node IS the root ------------------------------------------

test('a root inserted directly as the observed node is mounted', async () => {
  const { document, window } = empty();

  // No wrapper. The MutationRecord's addedNodes entry is the article itself, so
  // this case is reachable only through root.matches() -- querySelectorAll does
  // not include the element it is called on, and without that line this test
  // fails with zero buttons.
  const article = tweet(document);
  document.body.appendChild(article);
  await settle(window);

  assert.equal(article.querySelectorAll(BUTTON).length, 1);
  assert.equal(article.getAttribute(MARKER), '');
});

// The bare-quote version of the same case, because the two root types are two
// alternatives in one composed selector and a break in either would pass the
// other.
test('a bare quote wrapper inserted directly as the observed node is mounted', async () => {
  const { document, window } = empty();

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-testid', 'quoteTweet');
  wrapper.appendChild(tweet(document));
  document.body.appendChild(wrapper);
  await settle(window);

  assert.equal(wrapper.getAttribute(MARKER), '');
  assert.equal(wrapper.querySelectorAll(BUTTON).length, 1);
});

// --- 6. the deferral, which every other test here depends on --------------------

// jsdom delivers MutationObserver records as a microtask. A drain that ran
// synchronously inside the callback would pass all of the tests above, so this
// one asserts the deferral itself: nothing is mounted in the tick the node is
// added in, and everything is mounted by the next frame.
test('the mount is deferred out of the observer callback', async () => {
  const { document, window } = empty();

  const article = tweet(document);
  document.body.appendChild(article);

  // A microtask turn: the observer's callback has run, the node is queued, the
  // drain has not. If scan ran inline this would already be 1.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(article.querySelectorAll(BUTTON).length, 0, 'no mount inside the callback');

  await settle(window);
  assert.equal(article.querySelectorAll(BUTTON).length, 1, 'mounted on the animation frame');
});

// --- 7. the body-missing boot path ---------------------------------------------

// The DOMContentLoaded branch in main.js's boot guard, which is unreachable at
// run_at: document_idle in a real browser and is therefore the one line of this
// file that would otherwise ship untested.
//
// jsdom's document is in readyState 'loading' synchronously after construction,
// which is what makes this reproducible: remove the body, start the extension
// (so it takes the "no body yet" branch), put a body back, fire
// DOMContentLoaded, and the tweet in it must be mounted.
test('a document with no body yet is started when DOMContentLoaded fires', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://x.com/',
    pretendToBeVisual: true,
  });
  const { document, window } = dom.window;
  assert.equal(document.readyState, 'loading', 'the precondition this test needs');

  document.documentElement.removeChild(document.body);
  assert.equal(document.body, null);

  const XIW = loadAll(hostGlobals(window));
  assert.equal(typeof XIW.button.mount, 'function', 'the extension loaded, it just has not started');
  assert.equal(buttons(document).length, 0);

  const article = tweet(document);
  document.documentElement.appendChild(document.createElement('body'));
  document.body.appendChild(article);
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle(window);

  assert.equal(article.querySelectorAll(BUTTON).length, 1, 'started on DOMContentLoaded, not before');
  assert.equal(marked(document).length, 1);

  // And the observer is live from that point, which is the half that would be
  // easy to get wrong by only running the initial scan in the callback.
  const later = tweet(document);
  document.body.appendChild(later);
  await settle(window);
  assert.equal(later.querySelectorAll(BUTTON).length, 1);
});

// The other half of that branch: a document with no body that is not still
// parsing has nothing to decorate and no event left to wait for, so main.js
// starts nothing. The claim available here is narrow -- evaluating the file over
// that document does not throw -- because there is no body for a mount to land
// in and so no observable behaviour beyond that.
test('a document with no body and no DOMContentLoaded ahead starts nothing', () => {
  const dom = new JSDOM('<!doctype html><html><head></head></html>', {
    url: 'https://x.com/',
    pretendToBeVisual: true,
  });
  const { document, window } = dom.window;
  document.documentElement.removeChild(document.body);
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });

  // No assertion on the return: the claim is that evaluating main.js over this
  // document did not throw, which reaching the next line already establishes.
  loadAll(hostGlobals(window));
  assert.equal(document.body, null);
});

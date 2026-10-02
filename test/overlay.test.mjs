import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { loadAll } from './harness.mjs';

// overlay.js is the one content script whose behaviour is almost entirely DOM
// behaviour, and `node --test` executes not one DOM statement in it without this
// file. That is not a theoretical gap: the first version of overlay.js declared
// `hide` as a property of the XIW.overlay object literal, so every internal
// `hide()` call -- the close button, the backdrop click, Escape -- threw
// ReferenceError, every close path did nothing, and every other gate in the repo
// stayed green. A parse check cannot see that. These tests run the real file.
//
// What jsdom can and cannot do here, stated up front so nobody reads more into
// them than they prove:
//
//   Can: shadow-tree construction, refs wiring, event-handler resolution, the
//        hidden toggles as properties, object-URL bookkeeping, the body-overflow
//        save/restore pair, the focus save/restore pair, the Tab cycle.
//   Cannot: layout. jsdom has no layout engine, so nothing here can prove the
//        image is not covered by the controls, or that anything is visible. The
//        one place a stylesheet is read at all is the last test, which asserts a
//        rule's text rather than its effect -- and it says so.
//
// `URL.createObjectURL` is stubbed with a counter. jsdom does not implement it,
// and the thing under test is this file's bookkeeping -- did it revoke, and did
// it revoke the right one -- not jsdom's. Blobs handed to the stub are real
// jsdom Blobs, since the overlay only ever passes them through.
//
// No existing test file is modified: setup() drives the existing loadAll()
// loader with a `document` global merged in, which is what it takes to evaluate a
// content script that touches the DOM at call time.

const META = { tweetId: '1234567890', handle: 'ada' };

// A fresh document and a fresh module instance per test. Both are needed and
// neither is enough alone: loadAll() resets XIW and re-evaluates the six manifest
// scripts, which gives overlay.js fresh module state, and a new JSDOM gives the
// re-evaluated overlay a document with no host left in it from the last test.
function setup({ overflow = 'auto' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body style="overflow: ${overflow}">` +
      '<button id="merge">Merge</button></body></html>',
  );
  const { document } = dom.window;

  const urls = { created: [], revoked: [] };
  // A subclass, not a plain object, and not a patch of the real URL: the harness
  // resolves its own file paths with the global `new URL(...)`, so replacing that
  // global with a stub breaks the loader that is running these tests
  // ("URL is not a constructor"). Extending it leaves every other use intact.
  class StubURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:test/${urls.created.length}`;
      urls.created.push({ url, blob });
      return url;
    }

    static revokeObjectURL(url) {
      urls.revoked.push(url);
    }
  }

  const XIW = loadAll({ document, URL: StubURL });

  const host = () => document.querySelector('[data-xiw-overlay]');
  const shadow = () => host() && host().shadowRoot;
  const control = (name) => shadow().querySelector('.' + name);
  const focused = () => shadow() && shadow().activeElement;

  const show = (format = 'image/png') =>
    XIW.overlay.show({ blob: new dom.window.Blob(['x'], { type: format }), format, meta: META });
  const showError = (onRetry) =>
    XIW.overlay.showError(new XIW.StitchError('NETWORK', 'HTTP 404 for media 17abc'), onRetry);
  const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, composed: true }));
  // composed: real keydowns cross the shadow boundary, and the listener this
  // asserts is on `document` above the shadow tree. The event is returned, not
  // dispatchEvent's boolean, because defaultPrevented is the claim under test.
  const press = (node, init) => {
    const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });
    node.dispatchEvent(event);
    return event;
  };

  return { dom, document, XIW, urls, host, shadow, control, focused, show, showError, click, press };
}

// --- 1. every close path actually invokes hide ---------------------------------
//
// Asserted as the teardown, never as a call: `XIW.overlay.hide` is the function
// under test, so a spy on it would pass on a build where the button was wired to
// nothing at all. What a user can observe is the host leaving the document, the
// scroll lock going away, and the object URL being released.

test('the close control closes: host removed, scroll restored, URL revoked', () => {
  const t = setup();
  t.show();
  t.click(t.control('close'));

  assert.equal(t.host(), null, 'host left the document');
  assert.equal(t.document.body.style.overflow, 'auto', 'scroll lock released');
  assert.deepEqual(t.urls.revoked, [t.urls.created[0].url], 'the displayed URL was revoked');
});

test('Escape closes: host removed, scroll restored, URL revoked', () => {
  const t = setup();
  t.show();
  t.press(t.control('download'), { key: 'Escape' });

  assert.equal(t.host(), null, 'host left the document');
  assert.equal(t.document.body.style.overflow, 'auto', 'scroll lock released');
  assert.deepEqual(t.urls.revoked, [t.urls.created[0].url], 'the displayed URL was revoked');
});

test('a click on the backdrop closes, and a click on the image does not', () => {
  const t = setup();
  t.show();

  t.click(t.shadow().querySelector('.backdrop'));
  assert.equal(t.host(), null, 'the backdrop itself closes');
  assert.equal(t.document.body.style.overflow, 'auto');

  t.show();
  t.click(t.control('image'));
  assert.notEqual(t.host(), null, 'the image is not the backdrop');
  assert.equal(t.document.body.style.overflow, 'hidden', 'and clicking it closed nothing');
  assert.deepEqual(t.urls.revoked, [t.urls.created[0].url], 'nor released anything');
});

// --- 2. object URLs are revoked on replace and on close ------------------------

test('a second show() revokes the URL it replaced, and close revokes the live one', () => {
  const t = setup();
  t.show();
  const first = t.urls.created[0].url;
  t.show();
  const second = t.urls.created[1].url;

  assert.equal(first, 'blob:test/0');
  assert.equal(second, 'blob:test/1');
  assert.deepEqual(t.urls.revoked, [first], 'replaced, not merely dropped');
  assert.equal(t.control('image').getAttribute('src'), second, 'the new URL is what is displayed');

  t.XIW.overlay.hide();
  assert.deepEqual(t.urls.revoked, [first, second], 'and the live one on close');
});

// --- 3. showError does not revoke the previous successful object URL -----------

test('an error over a displayed composite leaves that composite and its URL alive', () => {
  const t = setup();
  t.show();
  const shown = t.urls.created[0].url;
  t.showError(() => {});

  assert.deepEqual(t.urls.revoked, [], 'nothing revoked: the user is still looking at that image');
  assert.equal(t.control('image').getAttribute('src'), shown, 'and the image is still the one to download');
  assert.equal(t.control('image').hidden, false);
  assert.equal(t.control('download').hidden, false, 'the download survives the error');

  // The asymmetry has an end: closing does revoke, because closing is the user
  // saying they are done with it.
  t.XIW.overlay.hide();
  assert.deepEqual(t.urls.revoked, [shown]);
});

test('a later show() revokes what the error was covering', () => {
  const t = setup();
  t.show();
  t.showError(() => {});
  t.show();

  assert.deepEqual(t.urls.revoked, [t.urls.created[0].url], 'the success supersedes the error, and the URL goes with it');
  assert.equal(t.control('panel').hidden, true, 'and the error panel is gone');
});

// Closing the overlay must leave the reader where they were.
//
// `open()` sets `body { overflow: hidden }`, and CSS propagates a body overflow to
// the viewport when html's is visible -- so the viewport stops being scrollable and
// the browser clamps its scroll offset to 0. Restoring `overflow` on close does not
// bring the offset back, which is why a merge used to drop the reader at the top of
// the timeline, several screens from the post they were reading.
//
// jsdom has no layout engine, so it does not perform that clamp. The clamp is
// therefore simulated here -- scroll offset zeroed between show and hide -- because
// the contract under test is that hide() puts the reader back regardless of what the
// browser did to the offset while the overlay was up. Without the fix this asserts
// 0 === 420 and fails.
test('closing the overlay restores the scroll offset the reader had', () => {
  const t = setup();
  const scroller = t.document.scrollingElement || t.document.documentElement;

  scroller.scrollTop = 420;
  scroller.scrollLeft = 7;

  t.show();
  // What the browser does when the viewport stops being scrollable.
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;

  t.XIW.overlay.hide();

  assert.equal(scroller.scrollTop, 420, 'back to the post, not the top of the timeline');
  assert.equal(scroller.scrollLeft, 7);
});

// The complement: a second hide() must not re-apply a stale offset over scrolling
// the reader has done since. Same shape as the overflow double-restore guard.
test('a second close does not move the reader again', () => {
  const t = setup();
  const scroller = t.document.scrollingElement || t.document.documentElement;

  scroller.scrollTop = 420;
  t.show();
  t.XIW.overlay.hide();
  assert.equal(scroller.scrollTop, 420);

  // The reader scrolls somewhere else after closing.
  scroller.scrollTop = 900;
  t.XIW.overlay.hide();
  assert.equal(scroller.scrollTop, 900, 'a stale offset was re-applied');
});

// Opening must not move the reader either. Capturing the offset is a read; if it
// were taken after the lock, or the lock were applied before the read, the value
// saved would be the clamped zero and closing would send them to the top.
test('opening the overlay records the offset before the scroll lock', () => {
  const t = setup();
  const scroller = t.document.scrollingElement || t.document.documentElement;

  scroller.scrollTop = 1234;
  t.show();
  // Simulate the clamp happening at lock time, then confirm the SAVED value was
  // the pre-lock one by closing and checking where we land.
  scroller.scrollTop = 0;
  t.XIW.overlay.hide();
  assert.equal(scroller.scrollTop, 1234);
});

// --- 4. body overflow is saved on open and restored on close, once --------------

test('an inline overflow on body is restored exactly, not clobbered with hidden', () => {
  const t = setup({ overflow: 'scroll' });
  t.show();
  assert.equal(t.document.body.style.overflow, 'hidden');
  t.XIW.overlay.hide();
  assert.equal(t.document.body.style.overflow, 'scroll', 'the value that was there before, not hidden and not blank');
});

test('a body with no inline overflow is restored to having none', () => {
  const t = setup({ overflow: '' });
  t.show();
  t.XIW.overlay.hide();
  assert.equal(t.document.body.style.overflow, '');
});

test('a second hide() cannot restore twice, and reopening re-saves', () => {
  const t = setup();
  t.show();
  t.show();
  t.XIW.overlay.hide();
  t.XIW.overlay.hide();
  assert.equal(t.document.body.style.overflow, 'auto', 'one restore, from one open');

  // The double-save half: a second show() while open must not overwrite the
  // saved value with 'hidden', or this close would leave the page unscrollable.
  t.show();
  t.XIW.overlay.hide();
  assert.equal(t.document.body.style.overflow, 'auto', 'the second open did not save the first open’s lock');
});

// --- 5. Retry is focusable and visible only when a callback is behind it --------

test('Retry is shown and focusable when a retry callback exists', () => {
  const t = setup();
  t.showError(() => {});

  assert.equal(t.control('retry').hidden, false);
  t.control('retry').focus();
  assert.equal(t.focused(), t.control('retry'), 'and it takes focus, so it is reachable');
});

test('Retry is hidden when there is no callback, rather than being a silent no-op', () => {
  for (const [label, onRetry] of [['undefined', undefined], ['null', null], ['a non-function', 'retry()']]) {
    const t = setup();
    t.showError(onRetry);

    assert.equal(t.control('retry').hidden, true, `hidden for ${label}`);
    assert.notEqual(t.focused(), t.control('retry'), `and not the focus target for ${label}`);
    assert.equal(t.control('panel').hidden, false, `while the error itself is still shown for ${label}`);
  }
});

test('clicking Retry is the only thing that calls the retry callback', () => {
  const t = setup();
  let calls = 0;
  t.showError(() => { calls += 1; });
  assert.equal(calls, 0, 'showing the panel is not retrying');

  t.click(t.control('retry'));
  assert.equal(calls, 1, 'the click is the call, which is what keeps the user gesture');
});

// --- 6. aria-modal is backed by a real tab cycle -------------------------------
//
// The attribute says nothing outside the dialog is reachable. That is a claim
// about Tab, and it is only true because of cycleFocus(), so it gets tested the
// same way any other claim in this file is: by pressing the key.

test('Tab from the last control wraps to the first, and Shift+Tab from the first wraps to the last', () => {
  const t = setup();
  t.show();
  const download = t.control('download');
  const close = t.control('close');

  close.focus();
  const forward = t.press(close, { key: 'Tab' });
  assert.equal(t.focused(), download, 'Tab off the end came back to the start');
  assert.equal(forward.defaultPrevented, true, 'and the browser’s own move was suppressed');

  const backward = t.press(download, { key: 'Tab', shiftKey: true });
  assert.equal(t.focused(), close, 'Shift+Tab off the front came back to the end');
  assert.equal(backward.defaultPrevented, true);
});

test('Tab from inside X’s document is pulled into the overlay instead of continuing through the page', () => {
  const t = setup();
  t.show();
  // The host is the last thing in the document, so this is where the browser
  // would have gone: X's own first focusable, with the overlay still up.
  const merge = t.document.getElementById('merge');
  merge.focus();

  const event = t.press(merge, { key: 'Tab' });
  assert.equal(t.focused(), t.control('download'), 'focus came back to the overlay');
  assert.equal(event.defaultPrevented, true);
});

test('the cycle runs over the controls that are on screen, in reading order', () => {
  const t = setup();
  t.show();
  t.showError(() => {});
  const retry = t.control('retry');
  const dismiss = t.control('dismiss');
  const download = t.control('download');
  const close = t.control('close');

  assert.equal(t.focused(), retry, 'the error state puts focus on Retry first');
  t.click(dismiss);
  assert.equal(t.focused(), download, 'dismissing returns focus to the download that is still live');
  t.press(close, { key: 'Tab' });
  assert.equal(t.focused(), download, 'and with the panel gone the cycle is just Download and close');

  // The panel back up, so all four are on screen. The first in the cycle is Retry
  // and the last is close, and the wrap goes between those two -- DOM order would
  // have put Download first and this assertion would be about Download instead.
  t.showError(() => {});
  close.focus();
  t.press(close, { key: 'Tab' });
  assert.equal(t.focused(), retry, 'the cycle comes back to Retry, not to the Download button buried in the DOM');

  retry.focus();
  t.press(retry, { key: 'Tab', shiftKey: true });
  assert.equal(t.focused(), close, 'and backwards from Retry wraps to the end');
});

// --- 7. the one stylesheet assertion -------------------------------------------
//
// Read the text of a rule, not its effect, because jsdom has no layout and no
// cascade for shadow trees. This is here because the failure it guards is silent
// and total: the owner stylesheet gives .image and .control an explicit display,
// and any author-origin declaration beats the UA's `[hidden] { display: none }`
// whatever its specificity, so deleting the override below would un-hide the
// image and both buttons in Chrome while every behaviour in this file kept
// passing.

test('the owner stylesheet keeps the [hidden] override its own display rules would defeat', () => {
  const t = setup();
  t.show();
  const css = t.shadow().querySelector('style').textContent;

  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, 'the override is present');
  assert.match(css, /\.image\s*\{[^}]*display:\s*block/, 'and there is an author display for it to defeat');
});

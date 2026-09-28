var XIW = (globalThis.XIW = globalThis.XIW || {});

// The Merge button: the one thing this extension puts into X's own DOM, and the
// only place it does so. Everything else happens off-page or behind a shadow
// boundary.
//
// Three constraints govern this file. None of them is visible in the code that
// implements it, and each one is a way the extension fails silently -- the user
// sees a normal-looking X timeline and no reason to suspect otherwise.
//
//   1. The button is a child of the media ROW, never of a photo container. X
//      sets `overflow: hidden` on [data-testid="tweetPhoto"] to crop the media
//      to the grid cell, so a button appended inside one is clipped out of
//      existence on every post, with nothing on screen to debug.
//   2. Media IDs are collected again at CLICK time. The mount-time answer is
//      used only to decide whether to put a button there at all. React re-uses
//      and re-parents DOM nodes, so the media under a root at click time is not
//      necessarily the media that was under it when the button was attached.
//   3. The click handler calls stopPropagation(). X's own handler on the way up
//      opens the media viewer, and without this the user gets the viewer and the
//      composite at once.
//
// A fourth one is about idempotency and belongs to main.js, not here: mount()
// does not read or write `data-xiw-done`. The caller marks a root, because the
// marker has to survive a React re-render of that root and only the caller
// knows when a root is a root. mount() still cannot produce two buttons for one
// row, and it re-applies the row's own class and positioning on every call
// rather than only on the first, so a re-mount repairs a row whose className X
// took back.
//
// The ownership rule that decides WHICH media counts as this post's is dom.js's
// and is consumed here as XIW.ownElements, not copied. That is the only thing
// this file used to duplicate, and it is why button.js is the second consumer
// named in dom.js's export.
//
// Everything below is in an IIFE. These are classic content scripts sharing one
// globalThis with the other five, and a top-level var or function declaration in
// one becomes a property of it, so an unwrapped helper here is a name any later
// script could clobber. core.js, dom.js, stitch.js and overlay.js wrap
// themselves the same way; only XIW.button reaches the namespace.
(function () {

  /**
   * @namespace XIW.button
   * @description Injects the per-post Merge button and wires it to the stitch and
   * the overlay. Owns one stylesheet for the whole page and nothing else: no
   * listener on `document`, no state per post beyond the closures mount() hands
   * to one button, and no extension API call anywhere.
   *
   * Mergeability is decided here only to decide whether a button exists. A post
   * with two ordinary photos that are not a split image still gets a button:
   * that is the deliberate tradeoff of per-post opt-in, because a false positive
   * costs the user one click and no false positive can damage a post.
   */

  var ROW_CLASS = 'xiw-media-row';
  var BUTTON_CLASS = 'xiw-merge-button';
  var BUSY_CLASS = 'xiw-merge-button--busy';
  var STYLE_CLASS = 'xiw-styles';
  var IDLE_LABEL = 'Merge';
  var BUSY_LABEL = 'Merging...';
  var ARIA_LABEL = 'Merge images into one';

  // Owner stylesheet, injected into the page's <head> once. It cannot be a shadow
  // boundary: the button has to sit in the media row beside the post's own
  // images, and a shadow host there would bring its own box, which is the thing
  // the placement rule above exists to avoid. So every rule here is scoped to a
  // class this file adds, and `all: initial` is the first declaration on the
  // button because X's global stylesheet reaches every element on the page and
  // would otherwise be free to set this one's size, font and colour.
  //
  // Flushed left on purpose -- it is a string, not code, and indenting it under
  // the IIFE only makes every selector harder to read.
  //
  // What is NOT here: `position`, `top`, `right` and `z-index`. Those four are
  // set inline on the button, because they decide whether the control is on
  // screen in the right place at all and no author-level rule -- X's included --
  // may outrank an inline declaration. `opacity` and `transition` are here
  // rather than inline for the opposite reason: an inline opacity would beat the
  // reveal rules below and the button could never appear.
  var STYLE = `
.${BUTTON_CLASS} {
  all: initial;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 9999px;
  background-color: rgba(0, 0, 0, 0.72);
  color: #ffffff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  /* The default state. A fully-opaque control on every multi-photo post in the
     feed is visual noise on a page the user did not ask us to restyle.

     opacity, and not visibility: hidden, for two reasons and both are load
     bearing. A visibility: hidden element is not focusable, so the
     :focus-within reveal below could never fire -- the keyboard user could not
     Tab to the control at all, and the reveal would be dead code. And it is not
     hit-testable, which is the trade the other way: with opacity the button is
     clickable during the 0.12s the fade takes, and a tap on a touch device --
     where there is no hover to reveal it first -- lands on a control the user
     has not seen yet. Hovering the row reveals it before a mouse can get
     there, so that window is closed for a pointer; a finger is the open case,
     and it merges the post and shows the button arriving at the same time,
     which is a Task 8 checklist item rather than a defect to design around. */
  opacity: 0;
  transition: opacity 0.12s;
}

/* Reveal: the row is hovered, the button itself is hovered or holds focus, or a
   stitch is in flight. The busy state is a class and not only a label for the
   same reason -- pointer leaving the row mid-stitch must not hide the progress.
   The button's own hover and focus-within are not only for their own sake: a
   re-render can take the row's className back to X's own and leave this button
   standing, and a control that is then revealed by neither is as invisible as
   the one this file exists not to create.

   pointer-events: none on the busy class is the mouse half of aria-disabled: the
   control reports itself unavailable and refuses the pointer, while staying in
   the tab order and keeping the focus it already has. The click listener's own
   flag is what refuses the keyboard half. */
.${ROW_CLASS}:hover .${BUTTON_CLASS},
.${BUTTON_CLASS}:hover,
.${BUTTON_CLASS}:focus-within,
.${BUTTON_CLASS}.${BUSY_CLASS} {
  opacity: 1;
}

.${BUTTON_CLASS}.${BUSY_CLASS} {
  pointer-events: none;
  cursor: progress;
}

/* all: initial above sets outline-style to none, which beats the user agent's
   own focus ring -- so without this a keyboard user tabs to a control they
   cannot see. */
.${BUTTON_CLASS}:focus-visible {
  outline: 2px solid #1d9bf0;
  outline-offset: 2px;
}
`;

  /**
   * @function XIW.button.mount
   * @param {Element} root A tweet root: `article[data-testid="tweet"]` or
   *   `div[data-testid="quoteTweet"]`. Anything else is a no-op, and so is
   *   anything that is not an element at all.
   * @returns {void}
   * @description Puts one Merge button on the post's media row, if the post is
   * mergeable, and wires it to `XIW.stitchVertical` and `XIW.overlay`.
   *
   * A no-op, leaving the DOM untouched, when `XIW.collectPhotoIds(root)` returns
   * `null` -- no photos, one photo, a video anywhere in the post, or a photo
   * whose media URL yields no id. That call is also what makes a junk `root`
   * safe: dom.js refuses anything it cannot query, so this function never reads
   * off an element it has not just been told is a real root.
   *
   * The row's own class, positioning, stacking context and the page's one
   * stylesheet are written on every call, before the check for an existing
   * button, and the button is only created when there is not one already. So
   * calling this twice for one root produces one button and still repairs a row
   * a React re-render has taken our class back from. `data-xiw-done` is the
   * caller's marker and is neither read nor written here.
   *
   * The IDs collected to decide mergeability are not kept. The click handler
   * collects again, and if that answer is `null` it returns silently: React may
   * have swapped the post's media since the button was attached, and a post that
   * is no longer mergeable has nothing to say.
   */
  function mount(root) {
    if (XIW.collectPhotoIds(root) === null) return;

    // The row is the shared parent of the post's own photo containers -- the
    // first photo's parentElement. The own-ness is the part that is easy to get
    // wrong: an outer post quoting a two-photo post has four photo containers,
    // and appending to the first one's parent is the difference between a button
    // that merges this post's images and one that merges the quoted post's. The
    // rule is dom.js's and it is exported for exactly this second use, so the
    // two consumers cannot drift.
    var photos = XIW.ownElements(root, XIW.SELECTORS.tweetPhoto);
    var first = photos[0];
    if (!first || !first.parentElement) return;

    var row = first.parentElement;
    var doc = root.ownerDocument;

    // The repairs come before the idempotency guard, and that ordering is the
    // point of the guard being idempotent at all. A React re-render can put X's
    // own className back on the row and leave this button standing, and a
    // re-mount that returned early on finding the button would never restore the
    // class the row-hover reveal is scoped to -- a control that is on the page
    // and cannot be seen. Every write here is idempotent, so a caller that
    // reaches one root twice pays for them twice and gets one button.
    ensureStyles(doc);
    positionRow(row);
    row.classList.add(ROW_CLASS);
    row.setAttribute('data-xiw-row', '');
    if (row.querySelector('.' + BUTTON_CLASS)) return;

    var button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', ARIA_LABEL);
    button.setAttribute('data-xiw-button', '');
    button.className = BUTTON_CLASS;
    button.textContent = IDLE_LABEL;
    // Inline, for the reason given above the stylesheet: this is a positioned
    // control inside a container X also positions, and nothing at author level --
    // X's rules included -- may outrank an inline declaration. The value only
    // has to beat what is inside the media row, which positionRow's stacking
    // context is there to guarantee; see the note on that function for why a
    // small number is a deliberate choice here and not a risk.
    button.style.position = 'absolute';
    button.style.top = '8px';
    button.style.right = '8px';
    button.style.zIndex = '2';
    row.appendChild(button);

    // Per-button, not per-page: two posts can be stitched at once, and each
    // button reports on its own attempt.
    var busy = false;

    // Busy and idle are one function rather than two so the way back cannot
    // drift from the way out. The label changes and aria-busy and aria-disabled
    // are set; the aria-label does not, because "Merge images into one" stays
    // the name of the control and aria-busy is what tells a screen reader the
    // state is not idle.
    //
    // aria-disabled, NOT the disabled attribute. A disabled button cannot hold
    // focus: setting it here would drop the keyboard user's focus onto <body>
    // the moment they activate the control, re-enabling it would not give the
    // focus back, and the overlay would then snapshot <body> as the element to
    // restore on close. aria-disabled says the same thing to assistive tech
    // without taking the control out of the tab order or the focus ring, and
    // pointer-events in the busy class keeps the mouse out. What actually stops
    // a second attempt is the flag below -- a dispatched click still reaches this
    // listener, whether the button is disabled or not.
    function setBusy(next) {
      busy = next;
      button.textContent = next ? BUSY_LABEL : IDLE_LABEL;
      if (next) {
        button.setAttribute('aria-busy', 'true');
        button.setAttribute('aria-disabled', 'true');
        button.classList.add(BUSY_CLASS);
      } else {
        button.removeAttribute('aria-busy');
        button.removeAttribute('aria-disabled');
        button.classList.remove(BUSY_CLASS);
      }
    }

    async function merge() {
      if (busy) return;

      // Constraint 2. collectPhotoIds is a pure read and costs less than the
      // fetch it precedes.
      var ids = XIW.collectPhotoIds(root);
      if (ids === null) return;

      setBusy(true);
      try {
        var composite = await XIW.stitchVertical(ids);
      } catch (err) {
        // Catch and route through the overlay rather than leaving the promise
        // rejected: this is the only failure this extension has a UI for, and
        // the user asked for an image, not for a console entry. Returning here
        // is what discriminates the two outcomes -- only a stitch that resolved
        // reaches the show() below -- so there is no flag carrying an outcome
        // across the finally and no value tested for truthiness, which is what a
        // rejection reason of `undefined` would have needed guarding against.
        //
        // Retry is the same closure, called from the overlay's Retry click handler
        // and from nowhere else, which is what keeps the user gesture attached to
        // the work: the retry re-stitches inside a click the user just made
        // rather than from a timer. start() rather than merge() so neither call
        // site can leave a rejected promise unhandled.
        XIW.overlay.showError(err, function retry() {
          return start();
        });
        return;
      } finally {
        // Last, and in a finally so both paths are covered by construction. It
        // used to have to run before the overlay calls, to restore idle state
        // ahead of the overlay snapshotting document.activeElement -- a
        // constraint that only existed while the button carried the disabled
        // attribute, and which aria-disabled removes along with the focus loss
        // that made it look necessary.
        setBusy(false);
      }

      // Outside the try on purpose. Inside it, a throw from the overlay -- a
      // non-Blob blob, which overlay.js says is reachable and which createObjectURL
      // throws on -- would be caught by the stitch's own catch and shown to the
      // user as a failed merge, which is a lie about an internal bug and hides it
      // behind a Retry. Here it propagates to start() instead, and is named in
      // the console as what it is.
      XIW.overlay.show({
        blob: composite.blob,
        format: composite.format,
        meta: XIW.tweetMeta(root)
      });
    }

    // merge() rejects only if the overlay itself throws, which is this
    // extension's own bug and not something the user can do anything about --
    // overlay.js itself anticipates createObjectURL rejecting on a non-Blob. It
    // still has to end here: the promise has no other consumer, so an unhandled
    // rejection per click is a strictly worse way to learn about it than one
    // named line in the console.
    function start() {
      return merge().catch(reportUnexpected);
    }

    button.addEventListener('click', function (event) {
      // Constraint 3, and preventDefault with it: without both, X's own handler
      // opens the media viewer over the top of the composite.
      event.preventDefault();
      event.stopPropagation();
      start();
    });
  }

  XIW.button = { mount: mount };

  function reportUnexpected(err) {
    console.error('X Image Weaver: the overlay threw while showing a composite', err);
  }

  // `position: relative` on the row is what makes the button's `absolute` mean
  // "top-right of the media" rather than "top-right of whatever ancestor X left
  // positioned" -- often the whole page. Only written when there is nothing to
  // inherit, so a row X already positions keeps its own.
  function positionRow(row) {
    var view = row.ownerDocument && row.ownerDocument.defaultView;
    var position = '';
    var zIndex = '';
    if (view && typeof view.getComputedStyle === 'function') {
      // getComputedStyle is the honest question -- the value can come from a
      // stylesheet rule, not only from an inline style -- and it throws on
      // elements in a document with no view, which is not a failure worth
      // propagating: a row we cannot measure is a row we make positioned.
      try {
        position = view.getComputedStyle(row).position || '';
        zIndex = view.getComputedStyle(row).zIndex || '';
      } catch {
        position = '';
        zIndex = '';
      }
    }
    if (position === '' || position === 'static') row.style.position = 'relative';

    // A stacking context on the row, and this is the second half of why the
    // button's own z-index is safe. A positioned element with z-index: auto does
    // not create one, so without this the button's z-index is compared against
    // every z-index on the page -- and X's own modals and menus sit in the
    // hundreds. With one, the comparison is confined to the media row, where the
    // values in play are single digits, and the button cannot out-paint X's
    // overlay chrome either, which is correct: an overlay that covers the media
    // is entitled to cover the control that sits on it.
    //
    // Only written when the row has none. Overwriting a z-index X chose would
    // demote the row itself, and a row that already has one already is a
    // stacking context, so there is nothing to add.
    if (zIndex === '' || zIndex === 'auto') row.style.zIndex = '0';
  }

  // One stylesheet for the page, found by its own class. Injected per document
  // rather than per root, because a page with forty mergeable posts must carry
  // one <style>, not forty.
  function ensureStyles(doc) {
    if (!doc || doc.querySelector('style.' + STYLE_CLASS)) return;
    var style = doc.createElement('style');
    style.className = STYLE_CLASS;
    style.setAttribute('data-xiw-styles', '');
    style.textContent = STYLE;
    var parent = doc.head || doc.documentElement;
    if (parent) parent.appendChild(style);
  }
})();

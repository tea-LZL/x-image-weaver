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
// knows when a root is a root. mount() is nonetheless a no-op if its own button
// is already in the row, so a caller that scans one root twice cannot produce
// two buttons.
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
     feed is visual noise on a page the user did not ask us to restyle, and
     opacity rather than visibility keeps the button focusable while it is
     invisible -- Tab still reaches it, which is the whole reason this is a real
     <button>. */
  opacity: 0;
  transition: opacity 0.12s;
}

/* Reveal: the row is hovered, the button itself is hovered or holds focus, or a
   stitch is in flight. The busy state is a class and not only a label for the
   same reason -- pointer leaving the row mid-stitch must not hide the progress.
   The button's own hover and focus-within are not only for their own sake: a
   re-render can take the row's className back to X's own and leave this button
   standing, and a control that is then revealed by neither is as invisible as
   the one this file exists not to create. */
.${ROW_CLASS}:hover .${BUTTON_CLASS},
.${BUTTON_CLASS}:hover,
.${BUTTON_CLASS}:focus-within,
.${BUTTON_CLASS}.${BUSY_CLASS} {
  opacity: 1;
}

.${BUTTON_CLASS}:disabled {
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
   * A no-op when the row already carries this file's button, so calling it twice
   * for one root produces one button. `data-xiw-done` is the caller's marker and
   * is neither read nor written here.
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
    // that merges this post's images and one that merges the quoted post's.
    var photos = ownPhotos(root);
    var first = photos[0];
    if (!first || !first.parentElement) return;

    var row = first.parentElement;
    // Idempotent in its own terms, and cheaper than the alternative: one query
    // on a row that holds a handful of children, run once per post.
    if (row.querySelector('.' + BUTTON_CLASS)) return;

    var doc = root.ownerDocument;
    ensureStyles(doc);
    positionRow(row);
    row.classList.add(ROW_CLASS);
    row.setAttribute('data-xiw-row', '');

    var button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', ARIA_LABEL);
    button.setAttribute('data-xiw-button', '');
    button.className = BUTTON_CLASS;
    button.textContent = IDLE_LABEL;
    // Inline, for the reason given above the stylesheet: this is a positioned
    // control inside a container X also positions, and z-index is the difference
    // between painting above the post's own media and under it.
    button.style.position = 'absolute';
    button.style.top = '8px';
    button.style.right = '8px';
    button.style.zIndex = '2';
    row.appendChild(button);

    // Per-button, not per-page: two posts can be stitched at once, and each
    // button reports on its own attempt.
    var busy = false;

    // Busy and idle are one function rather than two so the way back cannot
    // drift from the way out. The label changes and `aria-busy` is set; the
    // aria-label does not, because "Merge images into one" stays the name of the
    // control and aria-busy is what tells a screen reader the state is not idle.
    function setBusy(next) {
      busy = next;
      button.disabled = next;
      button.textContent = next ? BUSY_LABEL : IDLE_LABEL;
      if (next) {
        button.setAttribute('aria-busy', 'true');
        button.classList.add(BUSY_CLASS);
      } else {
        button.removeAttribute('aria-busy');
        button.classList.remove(BUSY_CLASS);
      }
    }

    async function merge() {
      // The guard is load-bearing, not belt-and-braces: `disabled` stops a real
      // user click, but a dispatched click event still reaches the listener, and
      // a second composite would be a second canvas of the same multi-megabyte
      // tiles with nothing to explain either of them.
      if (busy) return;

      // Constraint 2. collectPhotoIds is a pure read and costs less than the
      // fetch it precedes.
      var ids = XIW.collectPhotoIds(root);
      if (ids === null) return;

      setBusy(true);
      var composite = null;
      var failure = null;
      var failed = false;
      try {
        composite = await XIW.stitchVertical(ids);
      } catch (err) {
        // Catch and re-raise through the overlay rather than leaving the promise
        // rejected: this is the only failure this extension has a UI for, and
        // the user asked for an image, not for a console entry.
        failed = true;
        failure = err;
      }

      // Idle before the overlay opens, never in a `finally` after it. The
      // overlay captures document.activeElement when it opens and hands focus
      // back to it on close, and a disabled button cannot hold focus -- so a
      // `finally` here would leave every keyboard user's focus dropped on body.
      setBusy(false);

      if (failed) {
        // Retry is the same closure, called from the overlay's Retry click
        // handler and from nowhere else, which is what keeps the user gesture
        // attached to the work: the retry re-stitches inside a click the user
        // just made rather than from a timer.
        XIW.overlay.showError(failure, function retry() {
          return merge();
        });
        return;
      }
      XIW.overlay.show({
        blob: composite.blob,
        format: composite.format,
        meta: XIW.tweetMeta(root)
      });
    }

    button.addEventListener('click', function (event) {
      // Constraint 3, and preventDefault with it: without both, X's own handler
      // opens the media viewer over the top of the composite.
      event.preventDefault();
      event.stopPropagation();
      merge();
    });
  }

  XIW.button = { mount: mount };

  // The post's own [data-testid="tweetPhoto"] containers, in document order.
  //
  // dom.js applies exactly this rule and keeps it private, so it is repeated
  // rather than borrowed: XIW exports no accessor for "the elements this root
  // owns", and modifying dom.js is not this task's to do. The two must be
  // changed together -- if dom.js ever stops excluding quoted media, the first
  // photo's parent is no longer necessarily this post's row.
  function ownPhotos(root) {
    var matched = root.querySelectorAll(XIW.SELECTORS.tweetPhoto);
    var kept = [];
    for (var i = 0; i < matched.length; i++) {
      var quote = matched[i].closest(XIW.SELECTORS.quoteTweet);
      // The identity check is not redundant: closest() matches a root that IS a
      // quote wrapper, and dom.js counts that wrapper's media as its own.
      if (quote && quote !== root && root.contains(quote)) continue;
      kept.push(matched[i]);
    }
    return kept;
  }

  // `position: relative` on the row is what makes the button's `absolute` mean
  // "top-right of the media" rather than "top-right of whatever ancestor X left
  // positioned" -- often the whole page. Only written when there is nothing to
  // inherit, so a row X already positions keeps its own.
  function positionRow(row) {
    var view = row.ownerDocument && row.ownerDocument.defaultView;
    var position = '';
    if (view && typeof view.getComputedStyle === 'function') {
      // getComputedStyle is the honest question -- the value can come from a
      // stylesheet rule, not only from an inline style -- and it throws on
      // elements in a document with no view, which is not a failure worth
      // propagating: a row we cannot measure is a row we make positioned.
      try {
        position = view.getComputedStyle(row).position || '';
      } catch {
        position = '';
      }
    }
    if (position === '' || position === 'static') row.style.position = 'relative';
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

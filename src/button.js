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

  var BAR_CLASS = 'xiw-merge-bar';
  var COUNT_CLASS = 'xiw-merge-count';
  var ICON_CLASS = 'xiw-merge-icon';
  var BUTTON_CLASS = 'xiw-merge-button';
  var BUSY_CLASS = 'xiw-merge-button--busy';
  var STYLE_CLASS = 'xiw-styles';
  var IDLE_LABEL = 'Merge';
  var BUSY_LABEL = 'Merging...';
  var ARIA_LABEL = 'Merge images into one';

  // Owner stylesheet, injected into the page's <head> once.
  //
  // It cannot be a shadow boundary: the control has to sit in the post's own flow,
  // between the media and the timestamp, and a shadow host there would bring its own
  // box, which is the thing the placement rule exists to avoid. So every rule is
  // scoped to a class this file adds, and `all: initial` is the first declaration on
  // each of our elements because X's global stylesheet reaches every element on the
  // page and would otherwise set their size, font and colour.
  //
  // There is no absolute positioning, no z-index and no hover reveal here, and that
  // is the point of the shape rather than an omission. The control is in the normal
  // flow below the media, like the one TapToSee draws, so it cannot cover the
  // composite, cannot need a stacking context on X's own row, and does not have to
  // be invisible until hovered -- an always-visible control that is not on top of
  // anything is not visual noise.
  //
  // Flushed left on purpose -- it is a string, not code, and indenting it under the
  // IIFE only makes every selector harder to read.
  var STYLE = `
.${BAR_CLASS} {
  all: initial;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 0 4px;
  font: 400 15px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

.${COUNT_CLASS} {
  all: initial;
  box-sizing: border-box;
  color: rgb(113, 118, 123);
  font: inherit;
  white-space: nowrap;
}

.${BUTTON_CLASS} {
  all: initial;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 18px;
  border: 0;
  border-radius: 9999px;
  background-color: rgb(29, 155, 240);
  color: #ffffff;
  font: 700 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.${BUTTON_CLASS}:hover {
  background-color: rgb(26, 140, 216);
}

/* all: initial above sets outline-style to none, which beats the user agent's own
   focus ring -- so without this a keyboard user tabs to a control they cannot see. */
.${BUTTON_CLASS}:focus-visible {
  outline: 2px solid rgb(29, 155, 240);
  outline-offset: 2px;
}

/* Busy is a class and not only the label, so the state survives the pointer moving
   away. pointer-events: none is the mouse half of aria-disabled: the control reports
   itself unavailable and refuses the pointer while staying in the tab order and
   keeping the focus it already has. The click listener's own flag refuses the
   keyboard half. */
.${BUTTON_CLASS}.${BUSY_CLASS} {
  pointer-events: none;
  cursor: progress;
  opacity: 0.75;
}

.${ICON_CLASS} {
  all: initial;
  display: block;
  width: 16px;
  height: 16px;
  fill: currentColor;
}
`;

  /**
   * @function XIW.button.mount
   * @param {Element} root A tweet root: `article[data-testid="tweet"]` or
   *   `div[data-testid="quoteTweet"]`. Anything else is a no-op, and so is
   *   anything that is not an element at all.
   * @returns {boolean} True when a button is on the post after this call, false
   *   when the post is not mergeable yet or not mergeable at all. The caller owns
   *   the `data-xiw-done` marker and must only write it on `true`; see below.
   * @description Puts one Merge button on the post's media row, if the post is
   * mergeable, and wires it to `XIW.stitchImages` and `XIW.overlay`.
   *
   * A no-op, leaving the DOM untouched, when `XIW.collectPhotoSources(root)`
   * returns `null` -- no photos, one photo, a video anywhere in the post, or a
   * photo whose media URL yields no id. That call is also what makes a junk `root`
   * safe: dom.js refuses anything it cannot query, so this function never reads
   * off an element it has not just been told is a real root.
   *
   * The row's own class, positioning, stacking context and the page's one
   * stylesheet are written on every call, before the check for an existing
   * button, and the button is only created when there is not one already. So
   * calling this twice for one root produces one button and still repairs a row
   * a React re-render has taken our class back from.
   *
   * The return value is not decoration, and neither is the absent marker write:
   * `false` is the only thing that keeps a half-rendered post eligible. React
   * fills a tweet's media in over more than one commit, so a root is routinely
   * seen while it has zero or one photo, and a post whose media has not arrived
   * looks exactly like a post that is not a gallery. A caller that marked both
   * as done would never look at the first one again -- which is exactly what made
   * the button appear inconsistently in the feed.
   *
   * The sources collected to decide mergeability are not kept either. The click
   * handler collects again, and if that answer is `null` it returns silently:
   * React may have swapped the post's media since the button was attached, and a
   * post that is no longer mergeable has nothing to say.
   */
  function mount(root) {
    if (XIW.collectPhotoSources(root) === null) return false;

    // The media block: the deepest node that holds ALL of the post's own photos.
    // The control goes immediately after it, so it sits under the images and above
    // the timestamp -- the position TapToSee uses.
    //
    // Not the first photo's parentElement, which is what this used to do: X nests a
    // 4-image gallery, so the first photo's parent is one row of the grid rather
    // than the gallery, and the control ended up inside the media at a different
    // height depending on how many images there were.
    //
    // Own-photos, not all photos: an outer post quoting a two-photo post has four
    // photo containers in its subtree, and the common ancestor of all four would be
    // the outer article. The rule for which media a root owns is dom.js's and is
    // exported for exactly this second use, so the two consumers cannot drift.
    var photos = XIW.ownElements(root, XIW.SELECTORS.tweetPhoto);
    var media = commonAncestor(photos);
    if (!media) return false;
    var doc = root.ownerDocument;

    ensureStyles(doc);

    // Own-elements, for the same reason the photos are: an outer post quoting a
    // mergeable post has the quoted post's bar somewhere in its subtree, and
    // `root.querySelector` would find it and conclude this post already has one.
    if (XIW.ownElements(root, '.' + BAR_CLASS).length > 0) return true;

    var bar = doc.createElement('div');
    bar.className = BAR_CLASS;
    bar.setAttribute('data-xiw-bar', '');

    // "2 Images" beside the control, as in the reference. The gallery is never a
    // single image -- collectPhotoSources refuses fewer than two -- so this is
    // always plural.
    var count = doc.createElement('span');
    count.className = COUNT_CLASS;
    count.textContent = photos.length + ' Images';
    bar.appendChild(count);

    var button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', ARIA_LABEL);
    button.setAttribute('data-xiw-button', '');
    button.className = BUTTON_CLASS;
    button.appendChild(icon(doc));
    button.appendChild(doc.createTextNode(IDLE_LABEL));
    bar.appendChild(button);

    // After the media, so the post reads media -> control -> timestamp. When the
    // media block IS the root -- photos as direct children of the article, which X
    // does not do but which no rule here should turn into an insertion outside the
    // post -- appending inside the root is the safe direction to fail.
    if (media !== root && media.parentElement) {
      media.parentElement.insertBefore(bar, media.nextSibling);
    } else {
      root.appendChild(bar);
    }

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

      // Constraint 2. collectPhotoSources is a pure read and costs less than the
      // fetch it precedes. The sources, not the ids: each one carries the format
      // as well as the id, and the id alone does not name a fetchable URL.
      var sources = XIW.collectPhotoSources(root);
      if (sources === null) return;

      // Read at click time, like the sources: X can re-lay-out a post's media
      // after the button was attached, and the direction is a fact about the
      // layout, not about the post.
      var direction = XIW.joinDirection(root);

      setBusy(true);
      try {
        var composite = await XIW.stitchImages(sources, direction);
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

    return true;
  }

  // The deepest element that contains every one of `elements`.
  //
  // Starts at the first element and walks upwards only as far as the others
  // require, so the answer is the deepest common ancestor rather than any
  // ancestor. `contains` is inclusive, which is what makes the single-element case
  // return that element rather than its parent.
  //
  // Returns null for an empty list, and cannot return null otherwise: every photo
  // in a post shares the article as an ancestor at worst. Callers still check,
  // because the empty case is the one they must not anchor to.
  function commonAncestor(elements) {
    if (elements.length === 0) return null;
    var node = elements[0];
    for (var i = 1; i < elements.length; i++) {
      while (node && !node.contains(elements[i])) node = node.parentElement;
      if (!node) return null;
    }
    return node;
  }

  // The glyph beside the label: two panels with a bar under them, the split-image
  // mark the reference uses. Inline SVG rather than a text glyph or a background
  // image, so it inherits `currentColor` from the button and needs no request.
  function icon(doc) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', ICON_CLASS);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var paths = ['M2 4h8v12H2z', 'M14 4h8v12h-8z', 'M2 18h20v2H2z'];
    for (var i = 0; i < paths.length; i++) {
      var path = doc.createElementNS(NS, 'path');
      path.setAttribute('d', paths[i]);
      svg.appendChild(path);
    }
    return svg;
  }

  XIW.button = { mount: mount };

  function reportUnexpected(err) {
    console.error('X Image Weaver: the overlay threw while showing a composite', err);
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

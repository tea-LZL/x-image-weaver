var XIW = (globalThis.XIW = globalThis.XIW || {});

// The Merge button: the one thing this extension puts into X's own DOM, and the
// only place it does so. Everything else happens off-page or behind a shadow
// boundary.
//
// Three constraints govern this file. None of them is visible in the code that
// implements it, and each one is a way the extension fails silently -- the user
// sees a normal-looking X timeline and no reason to suspect otherwise.
//
//   1. The button is never a child of a photo container, and in a feed it is not
//      a child of the gallery either. X sets `overflow: hidden` on
//      [data-testid="tweetPhoto"] and on the box around the gallery, so a button
//      inside either is clipped, and one that overflows that box lands on top of
//      the timestamp. The feed control is a child of the post. The status-page
//      bar is the previous sibling of the timestamp row, outside the gallery.
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
  var LABEL_CLASS = 'xiw-merge-label';
  var GUTTER_CLASS = 'xiw-merge-gutter';
  var DOTS_CLASS = 'xiw-merge-dots';
  var DOT_CLASS = 'xiw-merge-dot';
  var ICON_ONLY_CLASS = 'xiw-merge-button--icon';
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
  // Two shapes, and the difference is where each one is allowed to paint.
  //
  // On a post's own page the control is in normal flow, on its own line under the
  // media and above the timestamp. It used to share that line. Two different
  // mistakes put it there: inserting it inside the box X sizes to the pictures
  // (that box does not grow, so the pill overflows onto the views), and a
  // flex-basis of 100%, which in the column a post is laid out in is a height, so
  // the bar stretched over the time. The z-index that exists so the card link
  // cannot swallow the click then swallows the views link instead.
  //
  // In a feed there is no line to give it. The control sits in the gutter to the
  // left of the images — the avatar column, vertically centred on the media — the
  // way TapToSee draws it. It is not on the picture. A mark on the picture covers
  // the art and, on a pale or busy image, disappears into it.
  //
  // Flushed left on purpose -- it is a string, not code, and indenting it under the
  // IIFE only makes every selector harder to read.
  var STYLE = `
.${BAR_CLASS} {
  all: initial;
  box-sizing: border-box;
  /* Positioned, so it paints above X's stretched card link rather than under it.
     That link is an absolutely positioned overlay covering the whole tweet and it
     is what made the button do nothing when clicked: the click was landing on the
     link, not on the button, so the handler never ran. Any positioned element with
     a z-index beats an absolutely positioned one with z-index: auto, which is what
     that overlay is. */
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  /* Its own line under the media, and only as tall as the pill.
     flex-basis 100% was the overlap: in a row it is a width, but in the column
     X lays a post out in it is a height, so the bar grew to the post and the pill
     landed on the timestamp. auto is the content height in a column and, with
     width 100%, still a full-width line in a row. grid-column is the same request
     made of a grid parent. Empty parts of the line pass clicks through, so a bar
     that still shares a pixel with the view count does not take the click. */
  flex: 0 0 auto;
  align-self: stretch;
  width: 100%;
  max-width: 100%;
  height: auto;
  grid-column: 1 / -1;
  clear: both;
  pointer-events: none;
  /* A line of its own, with a gap the size of the pill both above it and before
     the timestamp. 10px over 4px still read as the pill sitting on the time. */
  padding: 28px 0 28px;
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
  pointer-events: auto;
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

/* The timeline control. A labelled pill under every card would change the shape of
   the feed, and a mark on the picture covers the art. TapToSee puts a small icon
   in the gutter to the left of the images, centred on the avatar column and on the
   media's vertical middle, with one dot per image underneath. The left and top are
   written inline, because they are measured from the post; this rule only owns the
   box. Absolute against the post, which is positioned for exactly this, so X's
   overflow:hidden on the gallery cannot clip it. pointer-events stay off the box
   and on the button, so the gutter does not steal clicks from the avatar column. */
.${GUTTER_CLASS} {
  all: initial;
  box-sizing: border-box;
  position: absolute;
  z-index: 2;
  display: block;
  width: 34.75px;
  height: 34.75px;
  pointer-events: none;
}

.${DOTS_CLASS} {
  all: initial;
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 4px;
  display: flex;
  gap: 3px;
  pointer-events: none;
}

.${DOT_CLASS} {
  all: initial;
  display: block;
  box-sizing: border-box;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background-color: rgb(113, 118, 123);
}

.${BUTTON_CLASS}.${ICON_ONLY_CLASS} {
  width: 34.75px;
  height: 34.75px;
  padding: 0;
  border-radius: 9999px;
  /* No disc. On lights-out the gutter is the same black as the page, and a filled
     circle reads as a sticker on it. The mark is X's own gray, which is what reply
     and repost use, so at rest it belongs to the timeline. Hover is Twitter blue:
     the icon itself, plus the faint wash X puts behind a hovered action. */
  background-color: transparent;
  color: rgb(113, 118, 123);
}

.${BUTTON_CLASS}.${ICON_ONLY_CLASS}:hover {
  background-color: rgba(29, 155, 240, 0.1);
  color: rgb(29, 155, 240);
}

.${GUTTER_CLASS}:hover .${DOT_CLASS} {
  background-color: rgb(29, 155, 240);
}

.${BUTTON_CLASS}.${ICON_ONLY_CLASS} .${ICON_CLASS} {
  width: 18.75px;
  height: 18.75px;
}

.${BUTTON_CLASS}.${ICON_ONLY_CLASS} .${LABEL_CLASS} {
  /* Clipped rather than hidden. display: none would take the words out of the
     accessibility tree in engines that fall back to contents for the name, and
     this button's name is the only thing a screen reader has to go on once the
     label is off screen. Zero-size and clipped keeps it compact without lying
     about what the control is. */
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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

/* The timeline control has no visible label, so "Merging..." never shows. The
   icon stays put and breathes, in Twitter blue, for as long as the merge runs.
   The dots under it breathe in the same rhythm, a step apart, so the loading
   state is a pulse rather than a spinner. No disc: the black gutter stays black.
   Reduced motion holds the blue and skips the pulse. */
@keyframes xiw-merge-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.${BUTTON_CLASS}.${ICON_ONLY_CLASS}.${BUSY_CLASS} {
  opacity: 1;
  background-color: transparent;
  color: rgb(29, 155, 240);
}

.${BUTTON_CLASS}.${ICON_ONLY_CLASS}.${BUSY_CLASS} .${ICON_CLASS} {
  animation: xiw-merge-pulse 1.2s ease-in-out infinite;
}

.${GUTTER_CLASS}:has(.${BUSY_CLASS}) .${DOT_CLASS} {
  background-color: rgb(29, 155, 240);
  animation: xiw-merge-pulse 1.2s ease-in-out infinite;
}

.${GUTTER_CLASS}:has(.${BUSY_CLASS}) .${DOT_CLASS}:nth-child(2) { animation-delay: 0.15s; }
.${GUTTER_CLASS}:has(.${BUSY_CLASS}) .${DOT_CLASS}:nth-child(3) { animation-delay: 0.3s; }
.${GUTTER_CLASS}:has(.${BUSY_CLASS}) .${DOT_CLASS}:nth-child(4) { animation-delay: 0.45s; }

@media (prefers-reduced-motion: reduce) {
  .${BUTTON_CLASS}.${ICON_ONLY_CLASS}.${BUSY_CLASS} .${ICON_CLASS},
  .${GUTTER_CLASS}:has(.${BUSY_CLASS}) .${DOT_CLASS} {
    animation: none;
    opacity: 1;
  }
}

.${ICON_CLASS} {
  all: initial;
  display: block;
  width: 16px;
  height: 16px;
  /* all: initial sets color to black, and the mark is filled with currentColor.
     Without inherit the button's gray, and the Twitter blue on hover and while
     merging, never reach the icon. On a black timeline that is an invisible mark. */
  color: inherit;
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
    // On a post's own page the bar goes immediately before the timestamp row, so
    // it sits under the images and above the time. In a feed the gutter control
    // is measured against this block and anchored to the post, not placed inside it.
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
    noteTheme(doc);

    // Own-elements, for the same reason the photos are: an outer post quoting a
    // mergeable post has the quoted post's control somewhere in its subtree, and
    // `root.querySelector` would find it and conclude this post already has one.
    // The marker attribute is what is looked for, not a class, because the two
    // variants carry different classes.
    if (XIW.ownElements(root, '[data-xiw-control]').length > 0) return true;

    // The control has two shapes and the context decides which. On a post's own
    // page there is room under the images for a labelled pill beside an image
    // count. In a feed the reference puts a compact icon in the gutter left of
    // the images. Same button, same behaviour, different furniture.
    var onPostPage = isPostDetail(root);

    var button = doc.createElement('button');
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', ARIA_LABEL);
    button.setAttribute('data-xiw-button', '');
    button.className = onPostPage ? BUTTON_CLASS : BUTTON_CLASS + ' ' + ICON_ONLY_CLASS;
    button.appendChild(icon(doc, onPostPage ? SPLIT_MARK : FRAME_MARK));

    // A span rather than a bare text node, so the icon-only variant can hide the
    // words without touching the icon, and so busy/idle rewrites exactly one node.
    var label = doc.createElement('span');
    label.className = LABEL_CLASS;
    label.textContent = IDLE_LABEL;
    button.appendChild(label);

    var control = doc.createElement('div');
    control.setAttribute('data-xiw-control', '');

    if (onPostPage) {
      // "2 Images" beside the control, as in the reference. The gallery is never a
      // single image -- collectPhotoSources refuses fewer than two -- so this is
      // always plural.
      control.className = BAR_CLASS;
      control.setAttribute('data-xiw-bar', '');
      var count = doc.createElement('span');
      count.className = COUNT_CLASS;
      count.textContent = photos.length + ' Images';
      control.appendChild(count);
      control.appendChild(button);

      // Before the timestamp row, so the post reads media, then the bar, then the
      // time and the views. The gallery's box is only as tall as the pictures;
      // a bar inside it overflows onto that row.
      attachBar(root, media, control);
    } else {
      control.className = GUTTER_CLASS;
      control.appendChild(button);
      control.appendChild(imageDots(doc, photos.length));
      // On the post, not in the gallery. The gallery is overflow:hidden, which is
      // what clips a control that hangs off the left of the pictures, and it is
      // also what made a control inside it cover the art.
      //
      // The host is the innermost article that owns this media, not always the
      // root we were handed. A quote wrapper and the quoted article are two roots
      // for one gallery. A control on the wrapper sits outside the article, so
      // the article cannot see it and grows a second button. The article contains
      // the media both of them own, so one control there is found by both.
      var host = gutterHost(root, media);
      ensurePositioned(host);
      host.appendChild(control);
      watchGutter(host, control);
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
      label.textContent = next ? BUSY_LABEL : IDLE_LABEL;
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
      if (sources === null) {
        // Reported, not swallowed. This used to be a bare return, and a bare
        // return here is a control that is on screen, is clicked, and does
        // nothing at all -- the exact failure the spec calls out as reading as a
        // broken extension. It is reachable: the post's media can be re-rendered
        // between the mount and the click, and a post that was a gallery when the
        // button was attached need not still be one.
        //
        // The control goes too. It has nothing left to act on, and leaving it
        // would invite the same dead click again.
        control.remove();
        XIW.overlay.showError(
          { code: 'NO-MEDIA', message: "This post's images can no longer be read." },
          null
        );
        return;
      }

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

  // Is this post being read on its own page rather than in a feed?
  //
  // The path is the reliable signal: a post's own page is /<handle>/status/<id>,
  // and every feed -- home, profile, search, a media tab -- is something else. The
  // id is compared as well, because replies render on a post's page too and those
  // are ordinary cards, not the post being read; giving them a labelled bar would
  // put one under every reply.
  //
  // Location comes off the root's own view rather than the global, so this keeps
  // working when the file is evaluated into another realm -- which is exactly what
  // the test harness does, and what an `instanceof` or a bare `location` would
  // break on.
  function isPostDetail(root) {
    var view = root.ownerDocument && root.ownerDocument.defaultView;
    var location = view && view.location;
    if (!location || typeof location.pathname !== 'string') return false;

    var onPost = /^\/[^/]+\/status\/(\d+)/.exec(location.pathname);
    if (!onPost) return false;

    return XIW.tweetMeta(root).tweetId === onPost[1];
  }

  // Where the status-page bar is inserted: the line immediately before the
  // post's own timestamp, in the same column as that row.
  //
  // Putting it after the gallery instead is what still laid the pill on the
  // views. X wraps the pictures in a box sized to them. That box is not always
  // absolute or overflow-hidden, so it is not always recognisable as chrome, and
  // a bar inserted inside it does not make the post taller. It overflows onto
  // the timestamp, and the z-index that clears the card link then takes the
  // clicks that belonged to the time and the view count.
  //
  // The timestamp row is already outside that box. The bar goes in front of the
  // row, which keeps the time and the views together and pushes both down.
  // There is no timestamp yet on a half-rendered post; the action bar is the
  // same kind of row and sits in the same place. With neither, the bar falls
  // back to the first node outside the box that crops the gallery.
  function attachBar(root, media, control) {
    var before = metaRow(root, media);
    if (before && before.parentElement) {
      before.parentElement.insertBefore(control, before);
      return;
    }
    var anchor = flowAnchor(media, root);
    if (anchor !== root && anchor.parentElement) {
      anchor.parentElement.insertBefore(control, anchor.nextSibling);
    } else {
      root.appendChild(control);
    }
  }

  // The timestamp row, or the action bar when the timestamp has not been
  // rendered. A header time sits above the pictures; the one that belongs under
  // them is the first owned time that follows the gallery. A quote's time is
  // not this post's.
  function metaRow(root, media) {
    var time = firstFollowing(root, media, 'time');
    if (time) return rowOutsideMedia(time, media, root);
    var group = firstFollowing(root, media, '[role="group"]');
    if (group) return rowOutsideMedia(group, media, root);
    return null;
  }

  function firstFollowing(root, media, selector) {
    var nodes = root.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      if (isInsideQuote(nodes[i], root)) continue;
      if (follows(media, nodes[i])) return nodes[i];
    }
    return null;
  }

  function follows(earlier, later) {
    var view = earlier.ownerDocument && earlier.ownerDocument.defaultView;
    var flag = view && view.Node ? view.Node.DOCUMENT_POSITION_FOLLOWING : 4;
    return Boolean(earlier.compareDocumentPosition(later) & flag);
  }

  // Highest ancestor of the timestamp that is still outside the gallery. Its
  // parent contains the pictures, so that parent is the column, and this node
  // is the row the bar has to precede. A node inside the gallery is not a row.
  function rowOutsideMedia(node, media, root) {
    while (node.parentElement && node.parentElement !== root && !node.parentElement.contains(media)) {
      node = node.parentElement;
    }
    if (!node.parentElement || node.contains(media) || media.contains(node)) return null;
    return node;
  }

  function flowAnchor(media, root) {
    var node = media;
    for (var i = 0; i < 8; i++) {
      var parent = node.parentElement;
      if (!parent || parent === root) break;
      if (!isMediaChrome(parent)) break;
      if (containsPostMeta(parent, root)) break;
      node = parent;
    }
    return node;
  }

  // A box that crops or covers the gallery, and so cannot be the bar's parent.
  // Inline styles and computed styles both count: X sets some of these as
  // classes and some as the padding-bottom aspect-ratio trick.
  function isMediaChrome(el) {
    var style = computedStyle(el);
    if (!style) return false;
    var position = style.position || '';
    if (position === 'absolute' || position === 'fixed') return true;
    if (isHiddenOverflow(style.overflow) || isHiddenOverflow(style.overflowX) || isHiddenOverflow(style.overflowY)) {
      return true;
    }
    var ratio = style.aspectRatio || '';
    if (ratio && ratio !== 'auto') return true;
    // The padding-bottom percentage trick. Computed padding is in pixels, and a
    // box whose padding is what gives it height has almost no content height.
    var pad = parseFloat(style.paddingBottom) || 0;
    var height = parseFloat(style.height) || 0;
    return pad > 20 && pad >= height;
  }

  function isHiddenOverflow(value) {
    return value === 'hidden' || value === 'clip';
  }

  // The timestamp or the action bar. Their presence means this node is the post
  // body, not the gallery chrome, and the bar has to stay inside it.
  function containsPostMeta(el, root) {
    var nodes = el.querySelectorAll('time, [role="group"]');
    for (var i = 0; i < nodes.length; i++) {
      if (!isInsideQuote(nodes[i], root)) return true;
    }
    return false;
  }

  function isInsideQuote(element, root) {
    var quote = element.closest('[data-testid="quoteTweet"]');
    return Boolean(quote) && quote !== root && root.contains(quote);
  }

  // The article the gutter control is anchored to. The root itself, unless this
  // root is a quote wrapper around that article — see mount().
  function gutterHost(root, media) {
    if (!media || typeof media.closest !== 'function') return root;
    var article = media.closest('article[data-testid="tweet"]');
    if (article && article !== root && root.contains(article)) return article;
    return root;
  }

  // The feed control, in the gutter.
  //
  // Horizontal centre is the avatar's, which is the column to the left of the
  // images. Vertical centre is the media's, because the avatar itself sits at
  // the top of the post and the control belongs beside the pictures. With no
  // avatar, the same idea is a fixed step to the left of the media. With no
  // layout at all — the test realm, or a post whose pictures have not been
  // measured yet — it parks on the avatar-column centre until a resize says
  // otherwise.
  //
  // The thread line runs down that same column. Where it is a thin strip, a
  // mask opens a gap around the control so the line does not strike through the
  // icon. Anything wider is not the line, and masking it would punch a hole in
  // the post, so it is left alone.
  var AVATAR_SELECTOR = '[data-testid="Tweet-User-Avatar"]';
  var GUTTER_INSET = 36;
  var GUTTER_PARKED = '28px';
  // One observer per post. Keyed by the root so a re-mount, which builds a new
  // control after X has thrown the previous one away, disconnects the observer
  // that was watching the detached control instead of leaving it on the post.
  var gutterObservers = new WeakMap();

  function watchGutter(root, control) {
    placeGutter(root, control);
    var view = root.ownerDocument && root.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver !== 'function') return;
    var existing = gutterObservers.get(root);
    if (existing && existing.control === control) return;
    if (existing) existing.observer.disconnect();
    var observer;
    try {
      observer = new view.ResizeObserver(function () {
        if (!control.isConnected) {
          observer.disconnect();
          if (gutterObservers.get(root) && gutterObservers.get(root).observer === observer) {
            gutterObservers.delete(root);
          }
          return;
        }
        placeGutter(root, control);
      });
    } catch {
      return;
    }
    gutterObservers.set(root, { observer: observer, control: control });
    try {
      observer.observe(root);
      var photos = XIW.ownElements(root, XIW.SELECTORS.tweetPhoto);
      var media = commonAncestor(photos);
      if (media && media !== root) observer.observe(media);
    } catch {
      observer.disconnect();
      gutterObservers.delete(root);
    }
  }

  function placeGutter(root, control) {
    var photos = XIW.ownElements(root, XIW.SELECTORS.tweetPhoto);
    var media = commonAncestor(photos);
    if (!media || !root.getBoundingClientRect || !media.getBoundingClientRect) {
      control.style.left = GUTTER_PARKED;
      control.style.top = '50%';
      control.style.transform = 'translate(-50%, -50%)';
      return;
    }
    var rootRect = root.getBoundingClientRect();
    var mediaRect = media.getBoundingClientRect();
    if (!mediaRect.width && !mediaRect.height) {
      control.style.left = GUTTER_PARKED;
      control.style.top = '50%';
      control.style.transform = 'translate(-50%, -50%)';
      return;
    }
    var avatar = XIW.ownElements(root, AVATAR_SELECTOR)[0];
    var avatarRect = avatar && avatar.getBoundingClientRect ? avatar.getBoundingClientRect() : null;
    var centerX;
    if (avatarRect && avatarRect.width) {
      centerX = avatarRect.left + avatarRect.width / 2 - rootRect.left;
    } else {
      centerX = mediaRect.left - rootRect.left - GUTTER_INSET;
    }
    var centerY = mediaRect.top + mediaRect.height / 2 - rootRect.top;
    control.style.left = centerX + 'px';
    control.style.top = centerY + 'px';
    control.style.transform = 'translate(-50%, -50%)';
    clearThreadLine(root, control, avatar);
  }

  function clearThreadLine(root, control, avatar) {
    if (!avatar || !avatar.parentElement || !control.getBoundingClientRect) return;
    var line = threadLine(avatar);
    if (!line) return;
    var lineRect = line.getBoundingClientRect();
    var btnRect = control.getBoundingClientRect();
    if (lineRect.width <= 0 || lineRect.width > 4 || lineRect.height < 24) return;
    if (btnRect.height < 1) return;
    var gapTop = Math.max(0, btnRect.top - 6 - lineRect.top);
    // The dots hang below the button and are not part of its border box.
    var gapBottom = Math.max(0, btnRect.bottom + 16 - lineRect.top);
    if (gapTop >= lineRect.height || gapBottom <= 0) return;
    var topPct = ((gapTop / lineRect.height) * 100).toFixed(2);
    var bottomPct = ((gapBottom / lineRect.height) * 100).toFixed(2);
    var mask = 'linear-gradient(to bottom, black ' + topPct + '%, transparent ' + topPct +
      '%, transparent ' + bottomPct + '%, black ' + bottomPct + '%)';
    line.style.maskImage = mask;
    line.style.webkitMaskImage = mask;
  }

  function threadLine(avatar) {
    var column = avatar.parentElement;
    if (!column || typeof column.querySelectorAll !== 'function') return null;
    var nodes = column.querySelectorAll('div');
    var line = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el === avatar || avatar.contains(el) || el.contains(avatar)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.width <= 4 && rect.height > 24) line = el;
    }
    return line;
  }

  function imageDots(doc, count) {
    var dots = doc.createElement('div');
    dots.className = DOTS_CLASS;
    dots.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < count; i++) {
      var dot = doc.createElement('span');
      dot.className = DOT_CLASS;
      dots.appendChild(dot);
    }
    return dots;
  }

  // `position: relative` on the post, so the gutter control's absolute position
  // means "inside this post" rather than "inside whatever ancestor X happened to
  // position". Written only when the post has no position of its own, so a post
  // X already positioned is left alone.
  //
  // This is the one place the extension writes a layout property onto an element
  // it did not create. The gutter carries its own z-index because a positioned
  // element with z-index: auto is not a stacking context, and without one the
  // control's number would be compared against every z-index on the page.
  function ensurePositioned(el) {
    var style = computedStyle(el);
    if (!style) {
      el.style.position = 'relative';
      return;
    }
    var position = style.position || '';
    if (position === '' || position === 'static') el.style.position = 'relative';
  }

  function computedStyle(el) {
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return null;
    try {
      return view.getComputedStyle(el);
    } catch {
      return null;
    }
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

  // The mark beside the label. Inline SVG rather than a text glyph or a background
  // image, so it inherits `currentColor` from the button and needs no request.
  //
  // Two marks, because the reference uses two. The labelled pill carries a
  // split-image mark (two panels and a bar). The feed icon carries the two frames
  // and the inward arrows TapToSee draws in the gutter. Same control; the mark is
  // the shape of the furniture. fill-rule evenodd is what makes the frame paths
  // hollow — both subpaths wind the same way, and the default fill would paint
  // them solid.
  var SPLIT_MARK = ['M2 4h8v12H2z', 'M14 4h8v12h-8z', 'M2 18h20v2H2z'];
  var FRAME_MARK = [
    'M2 4h7v16H2V4zm2 2v12h3V6H4z',
    'M15 4h7v16h-7V4zm2 2v12h3V6h-3z',
    'M10 12l3-2.5v5z',
    'M14 12l-3-2.5v5z'
  ];

  function icon(doc, mark) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', ICON_CLASS);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill-rule', 'evenodd');
    var paths = mark || SPLIT_MARK;
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
  // X sets color-scheme and the page background on the root. Recorded so a black
  // timeline can be told from a white one. The gutter mark does not take a
  // different colour from it: X's gray already sits on both, and a white disc
  // on black is what refused to blend in.
  function noteTheme(doc) {
    var root = doc.documentElement;
    if (!root || !root.setAttribute) return;
    var next = isDarkPage(doc) ? 'dark' : 'light';
    if (root.getAttribute('data-xiw-theme') !== next) root.setAttribute('data-xiw-theme', next);
  }

  function isDarkPage(doc) {
    var view = doc.defaultView;
    var root = doc.documentElement;
    if (!view || typeof view.getComputedStyle !== 'function' || !root) return false;
    var nodes = [root, doc.body];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      var style;
      try {
        style = view.getComputedStyle(nodes[i]);
      } catch {
        continue;
      }
      if (!style) continue;
      var scheme = String(style.colorScheme || '').toLowerCase();
      var saysDark = scheme.indexOf('dark') !== -1;
      var saysLight = scheme.indexOf('light') !== -1;
      if (saysDark && !saysLight) return true;
      if (saysLight && !saysDark) return false;
      var rgb = canvasRgb(style.backgroundColor);
      if (rgb) return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 128;
    }
    return false;
  }

  function canvasRgb(value) {
    var match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([0-9.]+))?/.exec(value || '');
    if (!match) return null;
    if (match[4] !== undefined && parseFloat(match[4]) === 0) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

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

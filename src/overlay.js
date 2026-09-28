var XIW = (globalThis.XIW = globalThis.XIW || {});

// The full-screen viewer, the Download button, and the error state. It is the
// only singleton in this extension: one host element, one object URL, one
// keydown listener, one remembered body overflow, for as long as the tab is
// open. That is why this file is organized around the transitions (open, show,
// showError, hide) rather than around the three exports -- every resource the
// overlay takes is taken in exactly one place and released in exactly one other,
// and the pairs are listed here so a fourth transition cannot be added without
// someone noticing the missing half:
//
//   object URL   taken in show(),        released in show() (replaced) and hide()
//   keydown      taken in open(),        released in hide()
//   body overflow taken in open(),       restored in hide()
//   focus        taken in open(),        returned in hide()
//
// The keydown listener does two jobs, not one: it closes on Escape, and it holds
// the Tab cycle that makes the dialog's aria-modal="true" true rather than
// aspirational. See cycleFocus().
//
// The image is capped at 92vh/92vw as an upper bound, and the two control bands
// are reserved out of that budget rather than laid over it: --xiw-band-top and
// --xiw-band-bottom are subtracted from the cap, so the Download button and the
// close control cannot cover the composite they exist to serve. The first draft
// of this file got that wrong in both directions at once -- a control bar in flow
// clipped the image, and moving it out of flow put it on top of the last rows --
// and the arithmetic that now holds is in the stylesheet next to the numbers.
//
// Two of those are deliberately asymmetric. showError takes the overlay open and
// releases nothing: a second merge can fail while the first composite is still on
// screen, and revoking that URL would blank an image the user is still looking at
// and has not downloaded. Only hide() revokes it, and hide() is the user saying
// they are done.
//
// Shadow DOM is mandatory, not stylistic. X's global stylesheet mangles injected
// `img` and `div` elements: without the shadow boundary the composite renders at
// the wrong size, on the wrong background, clipped. The boundary stops selectors
// reaching in, but not inheritance -- font, color and line-height still cross the
// host from X's body -- so .backdrop re-declares them, and the handful of
// properties X could take from the host element itself are set inline, where no
// author-level rule outranks them.
//
// Everything below is in an IIFE. These are classic content scripts sharing one
// globalThis with the other five, and a top-level var or function declaration in
// one becomes a property of it, so an unwrapped helper here is a name any later
// script could clobber. core.js, dom.js and stitch.js wrap themselves the same way.
(function () {

  /**
   * @namespace XIW.overlay
   * @description The full-screen composite viewer. Owns one shadow-DOM host,
   * appended to `document.body` on first use and reused for the life of the page.
   *
   * The three exports below assume nothing of the caller except the arguments
   * named in their own JSDoc: any of them may be called in any order, more than
   * once, while the previous call's overlay is still open.
   */

  // Owner stylesheet. Flushed left on purpose -- it is a string, not code, and
  // indenting it under the IIFE only makes every selector harder to read.
  var STYLE = `
:host {
  /* The two control bands, declared once and spent twice: as the backdrop's
     padding, which is what reserves them, and as the subtraction below, which is
     what keeps the image out of them. Two numbers that had to agree by hand
     would be a silent regression the day one of them moved. */
  --xiw-band-top: 56px;
  --xiw-band-bottom: 72px;
  all: initial;
}

* { box-sizing: border-box; }

.backdrop {
  all: initial;
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Reserving the control bands here, not by nudging the controls: the controls
     are out of flow, so nothing but this padding stands between them and the
     image. Abspos children resolve against the padding box, so .close and
     .toolbar keep their 12px and 24px offsets from the viewport edge and land
     inside the bands rather than on top of the composite. */
  padding: var(--xiw-band-top) 0 var(--xiw-band-bottom);
  background: rgba(0, 0, 0, 0.92);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.4;
  color: #fff;
  text-align: left;
}

[hidden] { display: none !important; }

.stage {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

/* The cap is the smaller of the two limits the spec allows, arrived at without a
   percentage. 92vh alone is a ceiling the layout does not reach: it never shrinks
   to fit, so with the stage at 100vh - 128px a 92vh image still runs under the
   controls. min(92vh, 100%) would fit, but 100% resolves against whether a flex
   item's used height counts as definite for its children, which is engine
   behaviour rather than arithmetic. Subtracting the bands is the same value as
   that minimum -- 100vh - bands is always the larger of the two -- and it holds
   by construction: the image is centred in a box exactly 92vh - 128px shorter
   than the one 92vh would have needed, so its top and bottom edges sit 4vh inside
   the stage, which is inside the bands. The cap reaches zero at a 139px-tall
   viewport, below which the stage has no height left either and there is nothing
   to show; no browser window gets that short, so it is left as arithmetic rather
   than a max(0px, ...) wrapper. */
.image {
  display: block;
  max-height: calc(92vh - var(--xiw-band-top) - var(--xiw-band-bottom));
  max-width: 92vw;
  object-fit: contain;
}

/* Out of the flex flow, which is what lets the stage have a height to reserve
   the bands from. Kept shrink-to-fit rather than full width, so the space beside
   a tall narrow composite really is backdrop, and clicking it really is the
   close-by-click the spec asks for. Vertically it lives in the bottom band: 24px
   up, ~39px tall, so it ends at 63px, and the band is 72px. */
.toolbar {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
}

.control {
  appearance: none;
  border: 0;
  border-radius: 999px;
  padding: 10px 20px;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
  font: inherit;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
}

.control:hover { background: rgba(255, 255, 255, 0.26); }

.control:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.control--primary {
  background: #fff;
  color: #000;
}

.control--primary:hover { background: #e2e2e6; }

/* In the top band: 12px down, 40px tall, so it ends at 52px and the band is 56px.
   Horizontally it needs nothing -- above a 1300px viewport the image is 4vw from
   the right edge and the control is inside that margin entirely, and below that
   its box does overlap the image's horizontal span but the top band already keeps
   it above the image's first row. */
.close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}

.panel {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(520px, 84vw);
  padding: 20px 24px;
  border-radius: 12px;
  background: rgba(20, 20, 23, 0.98);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
  text-align: center;
}

.panel-title {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
}

.panel-code {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #fca5a5;
}

.panel-message {
  margin: 0 0 18px;
  font-size: 13px;
  color: #d4d4d8;
  overflow-wrap: anywhere;
}

.panel-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}
`;

  // The host, built on the first show() and kept for the life of the page, and
  // the shadow-tree nodes it holds. `refs` is null until then, so every other
  // piece of state below is only meaningful once an overlay has been opened at
  // least once. A leaked object URL outlives the overlay by exactly as long as
  // the tab does, which is why there is at most one of them and it is tracked
  // here rather than read back off the <img> it points at.
  var host = null;
  var refs = null;

  // True between open() and hide(). Independent of `host` existing: the host is
  // created once and outlives every open, so it cannot be the open/closed flag,
  // and using it as one would double-add the keydown listener and re-save an
  // already-saved 'hidden' overflow.
  var isOpen = false;

  var objectUrl = '';
  var filename = '';
  var onRetry = null;
  var savedOverflow = null;
  var previousFocus = null;

  // The three exports are declared here rather than written as
  // `XIW.overlay = { show: ..., hide: ... }` because two of them are also the
  // escape hatches for this file's own event handlers. A function *expression* as
  // an object property is scoped to itself, so a `hide()` in a click handler
  // below would be a ReferenceError rather than a call. The namespace still gains
  // exactly one new name, at the bottom.

  /**
   * @function XIW.overlay.show
   * @param {{blob: Blob, format: string, meta: {tweetId: string, handle: string}}} options
   *   `blob` and `format` are the `{blob, format}` pair `XIW.stitchVertical`
   *   resolved with, and `meta` is `XIW.tweetMeta`'s result for the post.
   * @returns {void}
   * @description Opens the overlay on the composite, or replaces what is already
   * in it. Called again while a composite is displayed, this revokes the previous
   * object URL before creating the new one, so there is never more than one live
   * URL, and the host, the keydown listener and the saved body overflow are all
   * left exactly as they are -- the overlay was already open.
   *
   * `format` is passed to `XIW.downloadFilename` unchanged and is never checked
   * here. That function already owns the one rule for a format this file does not
   * know ('jpg' for 'image/jpeg', 'png' for anything else), and a second rule in
   * this file could only disagree with it: the extension has one encoder, and the
   * filename follows the encoding that actually produced the blob.
   */
  function show(options) {
    var input = options || {};
    open();

    // Replace, in that order: the old URL is dead before the new one exists,
    // which is the whole reason a second show() cannot leak. If
    // URL.createObjectURL then throws, the caller passed something that is not a
    // Blob and Task 6's await has already rejected; there is no image left to
    // save in that case either way.
    releaseUrl();
    objectUrl = URL.createObjectURL(input.blob);
    filename = XIW.downloadFilename(input.meta, input.format);

    refs.image.src = objectUrl;
    refs.image.hidden = false;
    refs.download.hidden = false;
    // A success supersedes an error sitting over a previous composite, and with
    // it the retry callback, which by then describes a failed attempt at
    // something the user now has on screen.
    refs.panel.hidden = true;
    onRetry = null;

    focusFirst();
  }

  /**
   * @function XIW.overlay.showError
   * @param {XIW.StitchError} err The error `XIW.stitchVertical` threw.
   * @param {function(): void} onRetryCallback Called from the Retry click handler
   *   and from nowhere else, which is what keeps the user gesture that the
   *   caller's work has to be started from attached to that work.
   * @returns {void}
   * @description Opens the overlay in its error state.
   *
   * The panel is laid over the image area rather than replacing what is there. A
   * second merge can fail while the first composite is still on screen -- the
   * user asked for another post, the stitch failed, and the first image is the
   * only one they have -- so the image stays visible and usable underneath, the
   * Download button stays live, and the panel carries a Dismiss control to take
   * it away again. The object URL is not revoked here, for the same reason: it
   * belongs to the image on screen.
   *
   * `err` is read for `.code` and `.message` and never through instanceof, so a
   * caller that hands over something else gets a panel that says so instead of a
   * thrown one. `err.message` is written with textContent: it embeds a media id
   * scraped from the page, and it is still page data.
   */
  function showError(err, onRetryCallback) {
    open();

    onRetry = typeof onRetryCallback === 'function' ? onRetryCallback : null;
    refs.code.textContent = errorCode(err);
    refs.message.textContent = errorMessage(err);
    refs.panel.hidden = false;
    // Same rule as Dismiss below, and for the same reason: a Retry with nothing
    // behind it is the silent no-op the spec calls out as reading as a broken
    // extension. A caller that has no work to re-run does not get the button.
    refs.retry.hidden = !onRetry;
    // Only offered when dismissing reveals something. With no composite
    // underneath there is no prior state to go back to and the button would be a
    // lie.
    refs.dismiss.hidden = !objectUrl;

    focusFirst();
  }

  /**
   * @function XIW.overlay.hide
   * @returns {void}
   * @description Closes the overlay and gives back everything it took: the
   * keydown listener, the body overflow it saved, the focus it borrowed, the
   * object URL, and the host's place in the document. Idempotent, and a no-op when
   * nothing is open.
   */
  function hide() {
    if (!isOpen) return;
    isOpen = false;

    document.removeEventListener('keydown', onKeyDown, true);
    if (savedOverflow !== null) {
      // The exact string, including '' for a body that had no inline overflow of
      // its own. Restoring 'hidden' here, or clobbering an unrelated author value,
      // is the bug this line exists to prevent.
      document.body.style.overflow = savedOverflow;
      savedOverflow = null;
    }
    // Back where the user was -- the Merge button, normally. Guarded because the
    // page under the overlay is a live React tree and the element that was
    // focused on open may not exist any more.
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
      previousFocus.focus();
    }
    previousFocus = null;

    releaseUrl();
    // After the revoke: a revoked URL left on an <img> is a broken-image element,
    // and removeAttribute drops it without the request an empty `src = ''` makes.
    refs.image.removeAttribute('src');
    refs.image.hidden = true;
    refs.download.hidden = true;
    refs.panel.hidden = true;
    onRetry = null;

    // Removed rather than hidden, so a closed overlay leaves nothing of this
    // extension in X's DOM. The element itself is kept: it is the one host for
    // the life of the page.
    host.remove();
  }

  // One assignment at the end, so the namespace gains exactly one new name and
  // the three exports cannot drift apart.
  XIW.overlay = { show: show, showError: showError, hide: hide };

  // Adds the keydown listener, locks body scroll, and puts the host in the
  // document -- the three things that belong to being open rather than to any
  // one view, and that therefore have to happen once per open, not once per
  // show(). A second show() lands here with isOpen already true and changes
  // nothing.
  function open() {
    ensureHost();
    if (isOpen) return;

    if (!host.isConnected) document.body.appendChild(host);
    isOpen = true;

    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    previousFocus = document.activeElement;

    // Capture, because this is X's document too and X has its own Escape
    // handling on the way up, so a bubble-phase listener could be stopped before
    // it arrived. The event crosses the shadow boundary on its way, so this one
    // listener covers the whole overlay including the image.
    document.addEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      hide();
      return;
    }
    if (event.key === 'Tab') cycleFocus(event);
  }

  // The one object URL, revoked here and nowhere else. Both the replacement in
  // show() and the teardown in hide() funnel through it so there is a single
  // place a leak could be introduced.
  function releaseUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    filename = '';
  }

  // The synthetic download. A detached anchor, not appended: Chrome runs the
  // anchor's activation behaviour whether or not it is in the document, and not
  // being in the document means there is nothing for X's stylesheet to restyle
  // and nothing for its observers to react to. This deliberately does not call
  // chrome.downloads: the manifest declares no permissions precisely because the
  // download attribute on a blob URL does not need any.
  function save() {
    if (!objectUrl) return;
    var anchor = document.createElement('a');
    anchor.href = objectUrl;
    // The filename follows the encoding that succeeded, not the one that was
    // requested, so a JPEG fallback does not land in the Downloads folder named
    // .png.
    anchor.download = filename;
    anchor.click();
  }

  // Focus moves into the overlay on open, so Tab does not walk the timeline
  // behind it, and lands on whichever control this transition actually put on
  // screen. Shadow-tree focus is invisible to anything outside: the document's
  // activeElement is the host, and the button is the shadow root's.
  //
  // This is half of the tab boundary and not all of it -- see cycleFocus() for
  // the other half, without which one Tab keypress from here escapes the overlay.
  function focusFirst() {
    if (!refs) return;
    if (!refs.panel.hidden) {
      if (!refs.retry.hidden) refs.retry.focus();
      else if (!refs.dismiss.hidden) refs.dismiss.focus();
      else refs.close.focus();
      return;
    }
    if (!refs.download.hidden) refs.download.focus();
    else refs.close.focus();
  }

  // The controls Tab may visit, in the order the user reads the screen: the
  // action that just failed, then the way out of the error, then the primary
  // action, then close. Not DOM order, which would put the panel's controls last
  // because the panel is the last child of the backdrop, and a Retry button two
  // Tab presses away is a Retry button most people never reach.
  function tabOrder() {
    var order = [];
    if (!refs.panel.hidden) {
      if (!refs.retry.hidden) order.push(refs.retry);
      if (!refs.dismiss.hidden) order.push(refs.dismiss);
    }
    if (!refs.download.hidden) order.push(refs.download);
    // Never absent: the overlay is up, so there is always something to land on.
    order.push(refs.close);
    return order;
  }

  // Tab and Shift+Tab cycle the overlay's own controls, which is what
  // aria-modal="true" on the backdrop asserts: that nothing outside is reachable
  // while this is up. Focus alone does not deliver that. Focusing one control
  // creates no boundary, the host is the last thing in the document, and Tab from
  // the last control runs off the end of the document and wraps into X's
  // timeline -- still visible, still announced as unreachable, and still
  // focusable, under an overlay that has not gone anywhere.
  //
  // Only the two wraps are handled. A Tab in the middle of the cycle is left to
  // the browser, which is what keeps Shift+Tab, the platform's own ordering, and
  // any future control in the right place without this function knowing about it.
  function cycleFocus(event) {
    var order = tabOrder();
    var index = order.indexOf(host.shadowRoot.activeElement);

    // Focus is on the host itself, or somewhere in X's tree entirely: not ours,
    // and not where a Tab from here should go. Pull it in at the end the
    // direction is heading rather than letting it continue into the page.
    if (index === -1) {
      event.preventDefault();
      (event.shiftKey ? order[order.length - 1] : order[0]).focus();
      return;
    }

    var next = event.shiftKey ? index - 1 : index + 1;
    if (next === -1 || next === order.length) {
      // preventDefault first: without it the browser would also run its own focus
      // move, from the control we are about to leave, and land somewhere in X.
      event.preventDefault();
      (event.shiftKey ? order[order.length - 1] : order[0]).focus();
    }
  }

  function errorCode(err) {
    if (err && typeof err.code === 'string' && err.code) return err.code;
    return 'UNKNOWN';
  }

  function errorMessage(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return 'The merge failed for an unknown reason.';
  }

  // Built once, on the first show(). Nothing above this point touches the
  // document, which is what lets the file be evaluated in a context with no
  // `document` at all -- as the loader test does.
  function ensureHost() {
    if (host) return;

    host = document.createElement('div');
    host.setAttribute('data-xiw-overlay', '');
    // Inline, and set here rather than in the stylesheet above. A :host rule
    // loses to the outer document's rules on the host element by cascade order,
    // so these are the only declarations that cannot be overridden by X's global
    // stylesheet. Nothing else about the host matters; everything visible is
    // inside the shadow tree, where X's selectors cannot reach.
    host.style.position = 'fixed';
    host.style.inset = '0';
    // Above X's own modals, which sit far lower than this.
    host.style.zIndex = '2147483647';
    host.style.display = 'block';
    host.style.margin = '0';
    host.style.padding = '0';
    host.style.border = '0';
    host.style.background = 'transparent';

    var shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    refs = buildView();
    shadow.appendChild(refs.backdrop);
  }

  function buildView() {
    var view = {};

    view.image = element('img', 'image');
    view.image.alt = 'The merged image from the post';
    // In the tree from the start and hidden, rather than created on the first
    // show(): the error state shows the same stage, and the `[hidden]` rule in
    // the stylesheet above is what stops .image's own `display: block` from
    // putting an empty img on screen.
    view.image.hidden = true;

    var stage = element('div', 'stage');
    stage.appendChild(view.image);

    view.close = element('button', 'control close');
    view.close.type = 'button';
    view.close.textContent = '✕';
    view.close.setAttribute('aria-label', 'Close');

    view.download = element('button', 'control control--primary download');
    view.download.type = 'button';
    // Not "Download PNG": the composite is a JPEG whenever stitchVertical had to
    // fall back, and the label would then be false. The extension's filename
    // extension already says which encoding the user is getting.
    view.download.textContent = 'Download';
    view.download.hidden = true;

    var toolbar = element('div', 'toolbar');
    toolbar.appendChild(view.download);

    var title = element('p', 'panel-title');
    title.textContent = "Couldn't merge this post's images.";

    view.code = element('p', 'panel-code');
    view.message = element('p', 'panel-message');

    view.retry = element('button', 'control control--primary retry');
    view.retry.type = 'button';
    view.retry.textContent = 'Retry';
    // Hidden until showError() has a callback to put behind it.
    view.retry.hidden = true;

    view.dismiss = element('button', 'control dismiss');
    view.dismiss.type = 'button';
    view.dismiss.textContent = 'Dismiss';
    // Offers itself only over a composite that is still underneath; showError
    // reveals it when there is one.
    view.dismiss.hidden = true;

    var actions = element('div', 'panel-actions');
    actions.appendChild(view.retry);
    actions.appendChild(view.dismiss);

    view.panel = element('div', 'panel');
    // An alert, so the failure is announced rather than appearing silently over
    // an image the user is reading.
    view.panel.setAttribute('role', 'alert');
    view.panel.appendChild(title);
    view.panel.appendChild(view.code);
    view.panel.appendChild(view.message);
    view.panel.appendChild(actions);
    view.panel.hidden = true;

    view.backdrop = element('div', 'backdrop');
    view.backdrop.setAttribute('role', 'dialog');
    // True, and not aspirational: the backdrop covers the viewport, body scroll
    // is locked, and cycleFocus() keeps Tab inside this shadow tree, so nothing
    // outside the dialog is reachable by keyboard. Dropping the attribute instead
    // would have been the cheaper fix and would have been a lie about the
    // controls this dialog does cover.
    view.backdrop.setAttribute('aria-modal', 'true');
    view.backdrop.setAttribute('aria-label', 'Merged image');
    view.backdrop.appendChild(stage);
    view.backdrop.appendChild(toolbar);
    view.backdrop.appendChild(view.close);
    view.backdrop.appendChild(view.panel);

    view.backdrop.addEventListener('click', function (event) {
      // The backdrop itself and nothing else. The stage fills it, so this is the
      // padding around the image and it is the only close-by-click surface; a
      // click on the image, the toolbar or the panel has a different target and
      // is left to those elements.
      if (event.target === view.backdrop) hide();
    });
    view.close.addEventListener('click', function () { hide(); });
    view.download.addEventListener('click', save);
    view.retry.addEventListener('click', function () {
      // Read at click time, not captured when the panel was built, so the most
      // recent onRetry is the one that runs. Called here and only here: this is
      // the user gesture the caller's work has to be started from.
      if (onRetry) onRetry();
    });
    view.dismiss.addEventListener('click', function () {
      // The panel is a layer over the image, not a replacement for it, so
      // dismissing it means taking the panel away. With nothing underneath there
      // is no state to go back to and the button is hidden anyway.
      view.panel.hidden = true;
      focusFirst();
    });

    return view;
  }

  function element(tag, className) {
    var node = document.createElement(tag);
    node.className = className;
    return node;
  }
})();

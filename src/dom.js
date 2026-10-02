var XIW = (globalThis.XIW = globalThis.XIW || {});

// X's data-testid attributes are the only stable handle this extension has on the
// page and they can change without notice, so that risk lives in this file and
// every one of X's own selectors is read from XIW.SELECTORS rather than written
// here. The only selectors written inline are element names X's contract does
// not name -- 'img' and '*' -- which have no business in a table of testids.
//
// Everything below is in an IIFE. These are classic content scripts sharing one
// globalThis with the other five, and a top-level var or function declaration in
// one becomes a property of it, so an unwrapped helper here is a name any later
// script could clobber. The whole XIW namespace exists to keep this extension's
// internals out of X's way and out of each other's; leaking six names back out
// undoes it. Only the five exports below reach the namespace.
//
// Selectors are read per call, never resolved once at load: media is
// re-collected at click time because React can swap a node's media after a
// button was attached.
(function () {

  // The root's own media, in DOM order, as `{ id, format }` pairs, or null when
  // this is not a mergeable gallery. null is the common answer -- most posts on the
  // timeline are not split galleries -- so it has to be cheap and quiet: a pure
  // read, no logging, no throwing, no mutation of what it inspected.
  //
  // The format travels with the id because the id alone cannot build a fetchable
  // URL: X's CDN needs `?format=<fmt>&name=orig`, and a URL missing the format is a
  // 404 against the live CDN. `format` can be null if a URL omits it; stitch.js
  // owns the default, so this file never guesses.
  //
  // Reads XIW.ownElements rather than a local copy of it, which is the whole
  // reason that is exported: the two callers that need to know which media a
  // root OWNS must not be able to disagree about it.
  XIW.collectPhotoSources = function collectPhotoSources(root) {
    if (!isQueryable(root)) return null;

    // Mixed media is not a split gallery. Refuse the whole post rather than
    // merging the photos and quietly dropping the video.
    if (XIW.ownElements(root, XIW.SELECTORS.videoPlayer).length > 0) return null;

    var photos = XIW.ownElements(root, XIW.SELECTORS.tweetPhoto);
    if (photos.length < 2) return null;

    var sources = [];
    for (var i = 0; i < photos.length; i++) {
      var source = XIW.mediaSourceFromUrl(photoSourceUrl(photos[i]));
      // One unreadable photo makes the whole post unreadable: stitching a subset
      // of a split gallery yields a plausible-looking wrong image, which is worse
      // than offering no button at all.
      if (!source) return null;
      // Pushed, never deduplicated. X permits the same image twice in one
      // gallery, and a Set would silently drop a tile.
      sources.push(source);
    }
    return sources;
  };

  // Which way this post's parts should be joined, read from how they are laid out
  // on the page. See XIW.composeDirection for why the layout is the best available
  // statement of how the original was cut.
  //
  // Geometry first, structure second, and the order matters. A browser gives real
  // rectangles and they answer the question directly, including the 2x2 grid case
  // that structure cannot distinguish from a row. When there are no rectangles to
  // read -- jsdom has no layout engine, and an off-screen or display:none subtree
  // measures as zeroes -- the structure is the only signal left: photos that share
  // one parent are siblings in a row, and photos that do not are nested, which is
  // what a grid looks like. The fallback is a weaker answer, not a guess, and it
  // errs the way the product shipped.
  XIW.joinDirection = function joinDirection(root) {
    var photos = XIW.ownElements(root, XIW.SELECTORS.tweetPhoto);
    if (photos.length < 2) return 'vertical';

    var rects = [];
    var measurable = true;
    for (var i = 0; i < photos.length; i++) {
      var rect = measurableRect(photos[i]);
      if (rect === null) {
        measurable = false;
        break;
      }
      rects.push(rect);
    }

    var fromGeometry = measurable ? XIW.composeDirection(rects) : null;
    if (fromGeometry !== null) return fromGeometry;

    var parent = photos[0].parentElement;
    for (var j = 1; j < photos.length; j++) {
      if (photos[j].parentElement !== parent) return 'vertical';
    }
    return 'horizontal';
  };

  // A part's vertical extent, or null when the element has no measurable box.
  //
  // Zero width AND zero height is the signal for "no layout here": a real image
  // container is never both, and jsdom answers zeroes for everything. Checking both
  // rather than either keeps a genuinely thin element from being read as absent.
  function measurableRect(element) {
    if (typeof element.getBoundingClientRect !== 'function') return null;
    var rect;
    try {
      rect = element.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { top: rect.top, bottom: rect.bottom };
  }

  // deciding whether it is mergeable, or reading a post back in a test. A view of
  // collectPhotoSources, not a second implementation, so the two cannot disagree.
  XIW.collectPhotoIds = function collectPhotoIds(root) {
    var sources = XIW.collectPhotoSources(root);
    if (sources === null) return null;
    var ids = [];
    for (var i = 0; i < sources.length; i++) ids.push(sources[i].id);
    return ids;
  };

  // The two strings a download filename is built from. Either can be missing --
  // not every post renders a permalink or a profile link -- so each degrades to an
  // empty string and the filename degrades with it. The empty string is reported
  // rather than replaced here: downloadFilename is the only consumer and already
  // owns the 'unknown' fallback, and doing it in both places would make one of
  // them dead.
  XIW.tweetMeta = function tweetMeta(root) {
    var meta = { tweetId: '', handle: '' };
    if (!isQueryable(root)) return meta;

    // getAttribute, not .href: the selector matched the written attribute, and the
    // attribute is what carries the status id. Own-elements for the same reason as
    // the author cell below: a permalink inside a quoted post is the quoted post's
    // id, and two lookups in one function should not disagree about ownership.
    var permalink = XIW.ownElements(root, XIW.SELECTORS.tweetPermalink)[0];
    if (permalink) {
      var status = /\/status\/(\d+)/.exec(permalink.getAttribute('href') || '');
      if (status) meta.tweetId = status[1];
    }

    meta.handle = handleFromProfileLink(root);
    return meta;
  };

  // The handle is the profile anchor's href and nothing else. The author cell's
  // textContent is not a fallback: X renders the display name and the @handle
  // concatenated in that one element, so it reads "Ada Lovelace@ada", which does
  // not begin with an @ and which stripping a leading @ leaves untouched.
  function handleFromProfileLink(root) {
    // The root's own author cell, by the same rule collectPhotoIds uses for media
    // and for the same reason. A plain root.querySelector() searches the whole
    // subtree, so an outer post whose own author cell has not rendered would
    // otherwise adopt the quoted post's author cell and report the quoted author
    // as its own.
    var authorCell = XIW.ownElements(root, XIW.SELECTORS.userName)[0];
    if (!authorCell) return '';

    var links = authorCell.querySelectorAll(XIW.SELECTORS.profileLink);
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      // One segment or it is not a profile path. The cell also contains the
      // /status/ permalink, and /i/user/<id> routes can appear here too; both are
      // relative anchors, and neither is a handle. The grammar admits a single
      // segment, so the last segment is the whole href after the slash.
      if (HANDLE_PATH.test(href)) return href.slice(1);
    }
    return '';
  }

  // X's handle grammar: 1-15 characters, alphanumerics and underscore. Declared
  // here rather than in SELECTORS because it is a pattern for deciding what a
  // scraped href means, not a selector -- the split is selectors in core.js, DOM
  // judgement in dom.js. Hoisted to be evaluated once; the IIFE above is what
  // keeps it off the shared global, not this.
  var HANDLE_PATH = /^\/[A-Za-z0-9_]{1,15}$/;

  /**
   * @function XIW.ownElements
   * @param {Element} root
   * @param {string} selector Any of XIW.SELECTORS.
   * @returns {Element[]} Everything matching `selector` under root that root
   *   itself owns, in document order. A quoted post's elements are left out so
   *   they stay attributable to the quoted root.
   * @description Exported because "which elements does this root own" is a
   * question with exactly one answer and this file was answering it twice.
   * There are two consumers and they need different things from it:
   *
   *   - collectPhotoIds, above, which turns the photos into ids and refuses a
   *     post that is not a mergeable gallery.
   *   - button.js, which appends the Merge button to the parent of the first
   *     element this returns for [data-testid="tweetPhoto"]. An outer post
   *     quoting a two-photo post has four photo containers, and the difference
   *     between a button that merges this post's images and one that merges the
   *     quoted post's is entirely this filter.
   *
   * It was a private helper with a copy in button.js, and the copy is the worse
   * of the two risks: the canonical rule lives here, so a maintainer editing
   * isQuotedBy below would have had no signal from the other file at all. A
   * divergence cannot break the composite -- the ids still come from
   * collectPhotoIds -- but it does move the button onto the quoted post's media
   * row, silently, on exactly the posts where a user would be merging a quote.
   * If this rule ever needs to change, this is the only copy.
   * @see isQuotedBy, below, for the rule itself.
   */
  XIW.ownElements = function ownElements(root, selector) {
    var matched = root.querySelectorAll(selector);
    var kept = [];
    for (var i = 0; i < matched.length; i++) {
      if (!isQuotedBy(matched[i], root)) kept.push(matched[i]);
    }
    return kept;
  };

  // True when `element`'s nearest quote wrapper sits strictly below root, which
  // makes the media belong to a quoted post inside this one.
  //
  // closest() keeps walking up past root, out into whatever contains it, so the
  // match alone cannot be trusted. Three cases, and the two guards below are what
  // tell them apart:
  //
  //   wrapper strictly above root   root IS the quoted post; the media is its own
  //   wrapper === root              root is the quote wrapper itself, which the
  //                                 spec names as a root type; also its own
  //   wrapper strictly below root   a quote this root contains; not its media
  //
  // The identity check is not redundant with contains(). Node.contains is an
  // inclusive descendant test -- node.contains(node) is true -- so without it a
  // quoteTweet root discards every element it wraps and both exports go dead for
  // quoted posts, with no error to diagnose.
  function isQuotedBy(element, root) {
    var quote = element.closest(XIW.SELECTORS.quoteTweet);
    return Boolean(quote) && quote !== root && root.contains(quote);
  }

  // currentSrc is the URL the browser actually painted, which for a srcset is not
  // the src attribute. src is the declared URL. The inline background-image is the
  // last resort and the reason a lazy-loaded timeline image still yields an ID.
  function photoSourceUrl(photo) {
    var images = photo.querySelectorAll('img');
    for (var i = 0; i < images.length; i++) {
      var fromImage = images[i].currentSrc || images[i].src;
      if (fromImage) return fromImage;
    }
    return backgroundImageUrl(photo);
  }

  // The element itself first, then everything under it in document order, because
  // X sets this on a wrapper inside the photo container as often as on the
  // container. A stylesheet rule is not readable from here and X sets this one
  // inline; the CSSOM normalizes it to url("...").
  function backgroundImageUrl(element) {
    var candidates = [element].concat(Array.from(element.querySelectorAll('*')));
    for (var i = 0; i < candidates.length; i++) {
      var inline = candidates[i].style ? candidates[i].style.backgroundImage : '';
      var match = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(inline || '');
      if (match && match[2]) return match[2];
    }
    return '';
  }

  // Duck-typed on purpose, never `instanceof Element`. This file is evaluated in
  // Node's realm by the test harness and handed jsdom elements from another one,
  // so every instanceof check against a host global is false in the tests and true
  // in Chrome -- exactly backwards. The two methods below are all this file asks
  // of a root, and both are what X hands it.
  function isQueryable(node) {
    return Boolean(node) && typeof node.querySelectorAll === 'function' && typeof node.contains === 'function';
  }
})();

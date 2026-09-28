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
// undoes it. Only the two exports below reach the namespace.
//
// Selectors are read per call, never resolved once at load: media is
// re-collected at click time because React can swap a node's media after a
// button was attached.
(function () {

  // root's own media IDs, in DOM order, or null when this is not a mergeable
  // gallery. null is the common answer -- most posts on the timeline are not split
  // galleries -- so it has to be cheap and quiet: a pure read, no logging, no
  // throwing, no mutation of what it inspected.
  XIW.collectPhotoIds = function collectPhotoIds(root) {
    if (!isQueryable(root)) return null;

    // Mixed media is not a split gallery. Refuse the whole post rather than
    // merging the photos and quietly dropping the video.
    if (ownElements(root, XIW.SELECTORS.videoPlayer).length > 0) return null;

    var photos = ownElements(root, XIW.SELECTORS.tweetPhoto);
    if (photos.length < 2) return null;

    var ids = [];
    for (var i = 0; i < photos.length; i++) {
      var id = XIW.mediaIdFromUrl(photoSourceUrl(photos[i]));
      // One unreadable photo makes the whole post unreadable: stitching a subset
      // of a split gallery yields a plausible-looking wrong image, which is worse
      // than offering no button at all.
      if (!id) return null;
      // Pushed, never deduplicated. X permits the same image twice in one
      // gallery, and a Set would silently drop a tile.
      ids.push(id);
    }
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
    var permalink = ownElements(root, XIW.SELECTORS.tweetPermalink)[0];
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
    var authorCell = ownElements(root, XIW.SELECTORS.userName)[0];
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

  // Everything matching `selector` under root that root itself owns, in document
  // order. A quoted post's media is left out so it stays attributable to the
  // quoted root.
  function ownElements(root, selector) {
    var matched = root.querySelectorAll(selector);
    var kept = [];
    for (var i = 0; i < matched.length; i++) {
      if (!isQuotedBy(matched[i], root)) kept.push(matched[i]);
    }
    return kept;
  }

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

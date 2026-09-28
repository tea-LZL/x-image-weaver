var XIW = (globalThis.XIW = globalThis.XIW || {});

// X's data-testid attributes are the only stable handle this extension has on the
// page and they can change without notice, so that risk lives in this file and
// every selector it uses is read from XIW.SELECTORS rather than written here.
// Nothing below is looked up once and cached: IDs are re-collected at click time
// because React can swap a node's media after a button was attached.

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
// not every post renders a permalink or a display name -- so each degrades to an
// empty string and the filename degrades with it. The empty string is reported
// rather than replaced here: downloadFilename is the only consumer and already
// owns the 'unknown' fallback, and doing it in both places would make one of
// them dead.
XIW.tweetMeta = function tweetMeta(root) {
  var meta = { tweetId: '', handle: '' };
  if (!isQueryable(root)) return meta;

  // getAttribute, not .href: the selector matched the written attribute, and the
  // attribute is what carries the status id.
  var permalink = root.querySelector('a[href*="/status/"]');
  if (permalink) {
    var status = /\/status\/(\d+)/.exec(permalink.getAttribute('href') || '');
    if (status) meta.tweetId = status[1];
  }

  var userName = root.querySelector('[data-testid="User-Name"]');
  if (userName) {
    meta.handle = (userName.textContent || '').trim().replace(/^@/, '');
  }
  return meta;
};

// Everything matching `selector` under root that root itself owns, in document
// order. A quoted post's media is left out so it stays attributable to the
// quoted root.
function ownElements(root, selector) {
  var matched = root.querySelectorAll(selector);
  var kept = [];
  for (var i = 0; i < matched.length; i++) {
    if (!isQuotedBy(root, matched[i])) kept.push(matched[i]);
  }
  return kept;
}

// True when `element`'s nearest quote wrapper sits at or below root, which makes
// the media belong to a quoted post inside this one.
//
// closest() keeps walking up past root, out into whatever contains it, so the
// match alone cannot be trusted. When the wrapper is a strict ancestor of root,
// root IS the quoted post and this media is its own; the two cases are
// distinguished by direction, which is what the contains() call is asking.
function isQuotedBy(root, element) {
  var quote = element.closest(XIW.SELECTORS.quoteTweet);
  return Boolean(quote) && root.contains(quote);
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

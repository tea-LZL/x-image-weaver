var XIW = (globalThis.XIW = globalThis.XIW || {});

XIW.VERSION = '0.1.0';

XIW.TUNABLES = {
  MAX_CANVAS_HEIGHT: 16000,
  MAX_CANVAS_AREA: 250_000_000,
  FETCH_TIMEOUT_MS: 20000,
  JPEG_FALLBACK_QUALITY: 0.95
};

// The whole of X's DOM contract, transcribed from the spec's table. Every
// selector this extension evaluates lives here rather than inline in the file
// that reads it, so the day X renames one data-testid is a one-line change in a
// single place instead of a search across dom.js and button.js.
XIW.SELECTORS = {
  tweet: 'article[data-testid="tweet"]',
  quoteTweet: 'div[data-testid="quoteTweet"]',
  tweetPhoto: 'div[data-testid="tweetPhoto"]',
  videoPlayer: 'div[data-testid="videoPlayer"]',
  userName: '[data-testid="User-Name"]',
  profileLink: '[data-testid="User-Name"] a[href^="/"]',
  tweetPermalink: 'a[href*="/status/"]'
};

// The host check is load-bearing, not the path match: a bare `/media/<id>` search
// would happily return an id from any origin. X's media URLs carry no trailing
// slash after the id — the query string starts immediately — so anchoring on the
// end of the pathname is what makes this correct.
XIW.mediaIdFromUrl = function mediaIdFromUrl(raw) {
  var url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== 'pbs.twimg.com') return null;
  var media = /^\/media\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  return media ? media[1] : null;
};

XIW.computeCanvasSize = function computeCanvasSize(tiles) {
  if (!Array.isArray(tiles) || tiles.length === 0) {
    throw new TypeError('computeCanvasSize requires a non-empty array of tiles');
  }

  var castWidth = 0;
  var castHeight = 0;
  for (var i = 0; i < tiles.length; i++) {
    castWidth = Math.max(castWidth, tiles[i].width);
    castHeight += tiles[i].height;
  }

  // Scale is settled before any pixel dimension is derived, then each dimension
  // is rounded once from the unscaled extent. That holds for the area re-scale
  // too: it recomputes from castWidth/castHeight, never from the pixels already
  // rounded above, and the two differ by one pixel when the recomputed value
  // lands on a .5 tie. Task 4 draws at these dimensions, so it has to scale the
  // same extents rather than the rounded ones.
  var scale = 1;
  if (castHeight > XIW.TUNABLES.MAX_CANVAS_HEIGHT) {
    scale = XIW.TUNABLES.MAX_CANVAS_HEIGHT / castHeight;
  }

  var width = Math.round(castWidth * scale);
  var height = Math.round(castHeight * scale);

  var area = width * height;
  if (area > XIW.TUNABLES.MAX_CANVAS_AREA) {
    scale *= XIW.TUNABLES.MAX_CANVAS_AREA / area;
    width = Math.round(castWidth * scale);
    height = Math.round(castHeight * scale);
  }

  // A tile narrower than a couple of pixels rounds to 0 once the height cap has
  // scaled it, and Chrome rejects a 0-width canvas outright, so the caller would
  // fail the whole stitch rather than produce a small one. One pixel is far
  // below anything a real image can be, so the floor costs nothing.
  return { width: Math.max(1, width), height: Math.max(1, height), scale: scale };
};

XIW.downloadFilename = function downloadFilename(meta, format) {
  var ext = format === 'image/jpeg' ? 'jpg' : 'png';
  var source = meta || {};
  return 'x-image-weaver-' + sanitizeNamePart(source.handle) + '-' + sanitizeNamePart(source.tweetId) + '.' + ext;
};

// The handle is scraped from a page, so a name that survives sanitizing is
// required; a value that sanitizes to nothing degrades to 'unknown'.
function sanitizeNamePart(value) {
  var cleaned = value == null ? '' : String(value).replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned || 'unknown';
}

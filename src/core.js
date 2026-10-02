var XIW = (globalThis.XIW = globalThis.XIW || {});

// Everything below is in an IIFE, and only the XIW assignments inside it are
// meant to escape. These are classic content scripts sharing one globalThis with
// the other five, where a top-level var or function declaration becomes a
// property of it: left unwrapped, sanitizeNamePart below was a name any later
// script could clobber. The XIW namespace exists to keep this extension's
// internals out of X's way and out of each other's, and that only holds if
// nothing is declared at the top level. dom.js wraps itself the same way.
(function () {
  XIW.VERSION = '0.1.0';

  XIW.TUNABLES = {
    MAX_CANVAS_HEIGHT: 16000,
    // The same bound on the other axis, for a composite joined left to right. A
    // single dimension may go to 32767 in Chrome, but a 16000-wide strip is already
    // far past anything a split gallery produces, and the area cap is what actually
    // constrains a wide composite.
    MAX_CANVAS_WIDTH: 16000,
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
  //
  // The id alone is not enough to fetch a part, which is the bug this pair exists
  // to prevent. X's CDN resolves an image's encoding from the `format` query
  // parameter, and a URL that carries only `?name=orig` is a 404 — verified against
  // the live CDN. X's DOM always spells the format out, because the thumbnail it
  // renders is itself `?format=jpg&name=small` (or png/webp), so the format is
  // right there to be read off the same URL as the id.
  //
  // `format` comes back lowercased, and null when it is absent or does not look
  // like an image extension — never a value a caller could build a URL out of
  // blindly. A caller that needs a definite format picks its own default. The
  // check is deliberately loose rather than an allowlist of today's formats, so a
  // format X adds later still works.
  XIW.mediaSourceFromUrl = function mediaSourceFromUrl(raw) {
    var url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.hostname !== 'pbs.twimg.com') return null;
    var media = /^\/media\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!media) return null;

    var format = url.searchParams.get('format');
    if (format !== null) format = format.toLowerCase();
    if (format !== null && !/^[a-z0-9]{2,5}$/.test(format)) format = null;

    return { id: media[1], format: format };
  };

  XIW.mediaIdFromUrl = function mediaIdFromUrl(raw) {
    var source = XIW.mediaSourceFromUrl(raw);
    return source === null ? null : source.id;
  };

  // Which way the parts should be joined, from where they sit on the page.
  //
  // A post whose images are laid out side by side is one picture split into left
  // and right; a post whose images are stacked is one picture split into top and
  // bottom. Joining them the other way produces a picture that is technically a
  // composite and visibly wrong, so the layout the reader can see is the best
  // available statement of how the original was cut.
  //
  // The test is a single row: every part overlaps every other vertically, so the
  // vertical intersection of the whole set is non-empty. A 2x2 grid fails it --
  // its top row and bottom row do not overlap -- and correctly joins vertically,
  // which is also what the "tap to see" posts want.
  //
  // `rects` are `{top, bottom}` in viewport coordinates, or null where a part could
  // not be measured. Returns null when the answer cannot be read from geometry, and
  // the caller decides what to do instead; guessing here would be invisible.
  XIW.composeDirection = function composeDirection(rects) {
    if (!Array.isArray(rects) || rects.length < 2) return null;
    for (var i = 0; i < rects.length; i++) {
      if (!rects[i]) return null;
    }

    var top = -Infinity;
    var bottom = Infinity;
    for (var j = 0; j < rects.length; j++) {
      top = Math.max(top, rects[j].top);
      bottom = Math.min(bottom, rects[j].bottom);
    }

    // Strictly greater: parts that merely touch, or share an edge, have no band of
    // overlap and are not a row. A zero-height rect lands here too and answers
    // vertical, which is the safe default -- the caller only reaches this with
    // measurable rects.
    return top < bottom ? 'horizontal' : 'vertical';
  };

  XIW.computeCanvasSize = function computeCanvasSize(tiles, direction) {
    if (!Array.isArray(tiles) || tiles.length === 0) {
      throw new TypeError('computeCanvasSize requires a non-empty array of tiles');
    }

    // The direction decides which axis is summed and which is the maximum. Getting
    // this wrong is not a scale error, it is a different picture: two images that
    // belong side by side come out stacked, which is the bug this parameter exists
    // to fix. Defaults to vertical, the direction the product shipped with, so a
    // caller that does not care cannot silently get neither.
    var horizontal = direction === 'horizontal';

    var castWidth = 0;
    var castHeight = 0;
    for (var i = 0; i < tiles.length; i++) {
      if (horizontal) {
        castWidth += tiles[i].width;
        castHeight = Math.max(castHeight, tiles[i].height);
      } else {
        castWidth = Math.max(castWidth, tiles[i].width);
        castHeight += tiles[i].height;
      }
    }

    // Scale is settled before any pixel dimension is derived, then each dimension
    // is rounded once from the unscaled extent. That holds for the area re-scale
    // too: it recomputes from castWidth/castHeight, never from the pixels already
    // rounded above, and the two differ by one pixel when the recomputed value
    // lands on a .5 tie. Task 4 draws at these dimensions, so it has to scale the
    // same extents rather than the rounded ones.
    // Only the SUMMED axis is capped, and each direction has its own bound for it.
    // A vertical stack is bounded in height and takes its width from the widest
    // part; a horizontal strip is the reverse. Capping the maximum axis as well
    // would shrink a composite whose individual parts are already inside the limit,
    // which is not a real constraint -- the area cap below is what bounds the total.
    var summed = horizontal ? castWidth : castHeight;
    var summedCap = horizontal ? XIW.TUNABLES.MAX_CANVAS_WIDTH : XIW.TUNABLES.MAX_CANVAS_HEIGHT;

    var scale = 1;
    if (summed > summedCap) {
      scale = summedCap / summed;
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

  // Where each part lands on the canvas, for a given direction.
  //
  // Pure and separate from the drawing so the placement can be checked without a
  // canvas: a composite joined the wrong way is a different picture, and until this
  // existed the only thing that could tell the two apart was a human looking at the
  // output. `size` is computeCanvasSize's answer for the same tiles and direction.
  //
  // The joined axis accumulates; the other centers each part, so parts of differing
  // sizes line up on the edge they share. Each part is drawn at `tile.width *
  // size.scale`, never at a size re-derived from the rounded canvas -- see
  // computeCanvasSize for why that distinction is a seam and not a rounding detail.
  XIW.tileBoxes = function tileBoxes(tiles, size, direction) {
    var horizontal = direction === 'horizontal';
    var boxes = [];
    var offset = 0;

    for (var i = 0; i < tiles.length; i++) {
      var width = tiles[i].width * size.scale;
      var height = tiles[i].height * size.scale;
      if (horizontal) {
        boxes.push({ x: offset, y: (size.height - height) / 2, width: width, height: height });
        offset += width;
      } else {
        boxes.push({ x: (size.width - width) / 2, y: offset, width: width, height: height });
        offset += height;
      }
    }

    return boxes;
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
})();

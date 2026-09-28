var XIW = (globalThis.XIW = globalThis.XIW || {});

/**
 * Fetch, decode, and vertically composite the parts of a split post into one
 * image.
 *
 * This file has no automated behavior test on purpose. `createImageBitmap` and
 * Canvas 2D do not exist in Node or jsdom, so a mock here would only test the
 * mock; its coverage is the Task 8 manual browser checklist. What is enforced
 * automatically is that the file parses and that its composition arithmetic
 * consumes XIW.computeCanvasSize rather than re-deriving it.
 *
 * The two names below are the only two this file adds to the XIW namespace.
 *
 * @class XIW.StitchError
 * @extends Error
 * @description Every failure XIW.stitchVertical reports. Carries a `code`, which
 * is one of exactly two values:
 *
 *   - `'NETWORK'` -- a fetch rejected (DNS, connection reset, CORS), an
 *     AbortSignal.timeout(XIW.TUNABLES.FETCH_TIMEOUT_MS) fired, a response came
 *     back non-OK, or a response body could not be read to completion.
 *   - `'DECODE'` -- a response body could not be turned into something
 *     drawable: `createImageBitmap` failed *and* the `Image` + `decode()`
 *     fallback failed, or the decoded image reported zero width or height; or
 *     the canvas yielded no blob in either the PNG or the JPEG encoding.
 *
 * Exceeding XIW.TUNABLES.MAX_CANVAS_HEIGHT or XIW.TUNABLES.MAX_CANVAS_AREA is
 * deliberately NOT one of these. computeCanvasSize answers with a smaller
 * `scale` instead, and the stitch is silently downscaled to fit.
 *
 * @function XIW.stitchVertical
 * @async
 * @param {string[]} mediaIds X media ids in DOM order -- the order
 *   XIW.collectPhotoIds returns them, and the whole contract, because part n is
 *   drawn at the running y offset of the n-1 parts above it.
 * @returns {Promise<{blob: Blob, format: 'image/png'|'image/jpeg'}>} Resolves
 *   once with the composited image. `blob.type` is the same string as `format`;
 *   PNG is attempted first and JPEG at XIW.TUNABLES.JPEG_FALLBACK_QUALITY only
 *   when the PNG encode produced nothing.
 * @throws {XIW.StitchError} `code` `'NETWORK'` or `'DECODE'`, per above. A
 *   non-array or empty `mediaIds` is a caller bug rather than a runtime failure,
 *   so it is left to propagate as the TypeError XIW.computeCanvasSize throws
 *   rather than laundered into one of the two codes above -- XIW.collectPhotoIds
 *   already refuses anything with fewer than two photos, so nothing shipped
 *   can reach that path.
 *
 * Everything below is in an IIFE. These are classic content scripts sharing one
 * globalThis with the other five, and a top-level var or function declaration in
 * one becomes a property of it, so an unwrapped helper here is a name any later
 * script could clobber. core.js and dom.js wrap themselves the same way.
 */
(function () {

  class StitchError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'StitchError';
      this.code = code;
    }
  }
  XIW.StitchError = StitchError;

  XIW.stitchVertical = async function stitchVertical(mediaIds) {
    // Fetches in parallel: they are independent, and a 6-part gallery would
    // otherwise pay the round trip six times over.
    var blobs = await Promise.all(mediaIds.map(fetchOriginal));

    // Decodes one at a time on purpose. A stitched canvas up to
    // MAX_CANVAS_HEIGHT tall is the memory this function cannot avoid; N
    // simultaneously-decoded full-resolution bitmaps on top of it is the half
    // it can, and bitmaps are what decodeTile holds regardless of how the
    // fetch stage was scheduled.
    var tiles = [];
    try {
      for (var i = 0; i < blobs.length; i++) {
        var mediaId = mediaIds[i];
        var source = await decodeTile(blobs[i], mediaId);
        tiles.push(tileFrom(source, mediaId));
      }
      return await encode(compose(tiles));
    } finally {
      // compose() already released each bitmap as it finished drawing it, which
      // is the point -- toBlob is the slow step and it should not run holding
      // every tile. This is the backstop for the paths that never got there: a
      // decode failure three parts in, or compose itself throwing.
      for (var j = 0; j < tiles.length; j++) releaseTile(tiles[j]);
    }
  };

  // name=orig is the untouched upload. Every other size X serves is
  // post-processed and, for a long edge over 4096, smaller than the original --
  // compositing downscaled parts produces a downscaled, softer result that
  // still looks correct at a glance.
  function originalUrl(mediaId) {
    return 'https://pbs.twimg.com/media/' + mediaId + '?name=orig';
  }

  async function fetchOriginal(mediaId) {
    var response;
    try {
      response = await fetch(originalUrl(mediaId), {
        // force-cache, not the default: the timeline has already pulled a
        // thumbnail of every part, and revalidating one request per part is a
        // visible stall. ?name=orig is a distinct cache key from the thumbnail,
        // so the first stitch of a post is a miss and every later one is a hit.
        cache: 'force-cache',
        signal: AbortSignal.timeout(XIW.TUNABLES.FETCH_TIMEOUT_MS)
      });
    } catch {
      // One catch for a rejected fetch and an aborted one: the caller can only
      // retry or give up, and the distinction is not actionable from a button.
      throw new StitchError('NETWORK', 'fetch failed for media ' + mediaId);
    }

    if (!response.ok) {
      throw new StitchError('NETWORK', 'HTTP ' + response.status + ' for media ' + mediaId);
    }

    try {
      return await response.blob();
    } catch {
      // The body stream died partway. Fetch reported success and the image is
      // still not here, but it failed in transit, so it is a NETWORK.
      throw new StitchError('NETWORK', 'could not read the response body for media ' + mediaId);
    }
  }

  // Returns an ImageBitmap, or -- when that path is unavailable or fails -- an
  // HTMLImageElement. The two are not interchangeable downstream, so the caller
  // only ever touches `width`/`height`/`close` off whatever came back.
  async function decodeTile(blob, mediaId) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(blob);
      } catch {
        // Fall through to the element path. createImageBitmap rejects on bytes
        // some decoders still render (progressive JPEG in older builds, chiefly),
        // and the fallback is the only thing that can tell the two apart.
      }
    }

    var objectUrl = URL.createObjectURL(blob);
    try {
      var image = new Image();
      image.src = objectUrl;
      await image.decode();
      return image;
    } catch {
      throw new StitchError('DECODE', 'could not decode media ' + mediaId);
    } finally {
      // Revoked on both exits. The object URL pins the Blob for the lifetime of
      // the document, and a gallery the user retries -- or scrolls past and
      // comes back to -- leaks one per failed decode for as long as the tab is
      // open. Revoking after a successful decode is safe: decode() has already
      // materialized the pixels, and the image no longer reads the URL.
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Wraps a decoded image as a tile: intrinsic size, plus a handle to release.
  // The size is read off the tile and not off the response, because these are
  // the numbers computeCanvasSize multiplies by `scale` and the numbers drawn.
  function tileFrom(source, mediaId) {
    // naturalWidth/naturalHeight on an HTMLImageElement, width/height on an
    // ImageBitmap. `width` on an element is a layout property and a detached
    // image is never laid out, so reading it there would be reading the wrong
    // pair of numbers even when it happens to agree.
    var width = 'naturalWidth' in source ? source.naturalWidth : source.width;
    var height = 'naturalHeight' in source ? source.naturalHeight : source.height;

    // Zero in either axis is a decode that reported success and produced nothing
    // usable. It has to fail here rather than reach computeCanvasSize: the
    // function floors the *canvas* at 1px but not the tile extents it sums, so
    // a 0-height tile would shrink the canvas, contribute no rows to the stack,
    // and silently leave a gap where a part should be. A missing part is worse
    // than no image.
    if (!(width > 0) || !(height > 0)) {
      release(source);
      throw new StitchError('DECODE', 'media ' + mediaId + ' decoded to a ' + width + 'x' + height + ' image');
    }

    return { width: width, height: height, source: source };
  }

  function compose(tiles) {
    var size = XIW.computeCanvasSize(tiles);
    var canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    var context = canvas.getContext('2d');
    if (!context) {
      // TUNABLES is meant to keep the request under what Chrome will allocate.
      // If it did not -- a tighter budget, an exhausted GPU process -- the 2D
      // context comes back null and the answer is still "no image", which is
      // the only one of the two codes that is true here.
      throw new StitchError('DECODE', 'could not get a 2D context for a ' + size.width + 'x' + size.height + ' canvas');
    }

    // Opaque white under everything. A JPEG has no alpha channel, so an
    // unfilled canvas encodes transparent as black, and any tile narrower than
    // the canvas would then sit on a black stripe rather than on white.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    // The three lines inside this loop are computeCanvasSize's arithmetic,
    // restated. It summed the tile heights into castHeight, scaled that by
    // `scale`, and rounded the product once to get canvas.height -- rounding
    // from the *unscaled* extent, not from the pixels it had already rounded.
    // So the draw size has to be tile.width * `scale` too. Re-deriving it from
    // the canvas instead -- canvas.width and canvas.height, the obvious-looking
    // substitution -- rounds the same quantity a second time and lands on the
    // other side of a .5 tie for some gallery shapes, which puts each boundary
    // a fraction of a pixel off the one above it and shows up as a hairline
    // seam. `scale` is the only number here that never got rounded.
    var y = 0;
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var drawWidth = tile.width * size.scale;
      var drawHeight = tile.height * size.scale;
      // Centered, not left-aligned: tiles of differing widths line up on their
      // shared edge, which is what the split-in-the-post posts expect.
      context.drawImage(tile.source, (canvas.width - drawWidth) / 2, y, drawWidth, drawHeight);
      y += drawHeight;
      // Released here rather than in one sweep at the end: toBlob is the slow
      // step below and should not run holding every part in decoded memory.
      // releaseTile() clears the handle, so the backstop sweep in
      // stitchVertical is free to run over these tiles again on a throw.
      releaseTile(tile);
    }

    return canvas;
  }

  async function encode(canvas) {
    var blob = await toBlob(canvas, 'image/png');
    if (blob) return { blob: blob, format: 'image/png' };

    // PNG encoding returns null rather than throwing when the canvas is too
    // large for it. JPEG at the tuned quality is the one retry; a JPEG is lossy
    // and has no alpha, which is why it is second and not first.
    blob = await toBlob(canvas, 'image/jpeg', XIW.TUNABLES.JPEG_FALLBACK_QUALITY);
    if (blob) return { blob: blob, format: 'image/jpeg' };

    throw new StitchError('DECODE', 'canvas encoded to nothing as PNG or JPEG');
  }

  // toBlob reports failure as a null blob, and throwing is not something it is
  // documented to do, but a canvas that lost its backing store can anyway. Both
  // mean the same thing to the caller, so both resolve null and let the retry
  // and the final throw above stay the only place that decides.
  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(resolve, type, quality);
      } catch {
        resolve(null);
      }
    });
  }

  // Drops the decoded pixels behind a tile and clears the handle, so neither the
  // backstop sweep in stitchVertical nor a second pass can release it twice.
  function releaseTile(tile) {
    release(tile.source);
    tile.source = null;
  }

  // An HTMLImageElement has no close(); its pixels go when the element does.
  // Only an ImageBitmap holds a real handle on decoded memory.
  function release(source) {
    if (source && typeof source.close === 'function') source.close();
  }
})();

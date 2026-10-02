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
 * @description Every failure XIW.stitchImages reports. Carries a `code`, which
 * is one of exactly two values:
 *
 *   - `'NETWORK'` -- a fetch rejected (DNS, connection reset, CORS), an
 *     AbortSignal.timeout(XIW.TUNABLES.FETCH_TIMEOUT_MS) fired, a response came
 *     back non-OK, or a response body could not be read to completion.
 *   - `'DECODE'` -- a response body could not be turned into something
 *     drawable: `createImageBitmap` failed *and* the `Image` + `decode()`
 *     fallback failed, or the decoded image reported zero width or height; or
 *     the canvas could not be given a 2D context at all, which is a canvas too
 *     large to allocate even inside the TUNABLES caps; or the canvas yielded no
 *     blob in either the PNG or the JPEG encoding.
 *
 * Exceeding XIW.TUNABLES.MAX_CANVAS_HEIGHT or XIW.TUNABLES.MAX_CANVAS_AREA is
 * deliberately NOT one of these. computeCanvasSize answers with a smaller
 * `scale` instead, and the stitch is silently downscaled to fit.
 *
 * @function XIW.stitchImages
 * @async
 * @param {Array<{id: string, format: string|null}>} sources X media in DOM order
 *   -- the order XIW.collectPhotoSources returns them, and the whole contract,
 *   because part n is drawn at the running offset of the n-1 parts before it.
 *   The format travels with the id because the id alone is not a fetchable
 *   resource; see originalUrl.
 * @param {'horizontal'|'vertical'} [direction] Which axis the parts are joined on.
 *   Vertical (the default, and what the product shipped with) stacks them top to
 *   bottom; horizontal lays them left to right. XIW.joinDirection reads this off
 *   the post's layout, because a post whose images sit side by side is one picture
 *   split down the middle and stacking it produces a visibly wrong composite.
 * @returns {Promise<{blob: Blob, format: 'image/png'|'image/jpeg'}>} Resolves
 *   once with the composited image. `blob.type` is the same string as `format`;
 *   PNG is attempted first and JPEG at XIW.TUNABLES.JPEG_FALLBACK_QUALITY only
 *   when the PNG encode produced nothing.
 * @throws {XIW.StitchError} `code` `'NETWORK'` or `'DECODE'`, per above. A
 *   non-array or empty `sources` is a caller bug rather than a runtime failure,
 *   so it is left to propagate as the TypeError XIW.computeCanvasSize throws
 *   rather than laundered into one of the two codes above -- XIW.collectPhotoSources
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

  XIW.stitchImages = async function stitchImages(sources, direction) {
    // Fetches in parallel: they are independent, and a 6-part gallery would
    // otherwise pay the round trip six times over.
    var blobs = await Promise.all(sources.map(fetchOriginal));

    // Decodes one at a time on purpose. A stitched canvas up to
    // MAX_CANVAS_HEIGHT tall is the memory this function cannot avoid; N
    // simultaneously-decoded full-resolution bitmaps on top of it is the half
    // it can, and bitmaps are what decodeTile holds regardless of how the
    // fetch stage was scheduled.
    var tiles = [];
    var canvas = null;
    try {
      for (var i = 0; i < blobs.length; i++) {
        var mediaId = sources[i].id;
        var source = await decodeTile(blobs[i], mediaId);
        tiles.push(tileFrom(source, mediaId));
      }
      canvas = compose(tiles, direction);
      return await encode(canvas);
    } finally {
      // compose() already released each bitmap as it finished drawing it, which
      // is the point -- toBlob is the slow step and it should not run holding
      // every tile. This is the backstop for the paths that never got there: a
      // decode failure three parts in, or compose itself throwing.
      for (var j = 0; j < tiles.length; j++) releaseTile(tiles[j]);
      // The backing store, released the same way. TUNABLES permits a canvas of
      // up to MAX_CANVAS_AREA pixels, which at four bytes each is close to a
      // gigabyte of allocation with no deterministic release anywhere else in
      // this file. Assigning width resets the bitmap to 0x0 and hands it back.
      // Safe against the resolved value: `await encode(...)` does not settle
      // until toBlob has already produced the Blob, and the Blob holds its own
      // bytes rather than a view onto the canvas.
      if (canvas) {
        canvas.width = 0;
        canvas = null;
      }
    }
  };

  // The URL X's CDN will actually serve the untouched upload from.
  //
  // Two parameters, and both are load-bearing. `name=orig` is the untouched upload;
  // every other size X serves is post-processed and, for a long edge over 4096,
  // smaller than the original -- compositing downscaled parts produces a
  // downscaled, softer result that still looks correct at a glance. `format` is
  // what tells the CDN which encoding to resolve at all: the id alone is not a
  // fetchable resource, and `?name=orig` without a format is a 404, verified
  // against the live CDN.
  //
  // A source with no usable format -- which X's markup does not produce, but which
  // this must survive rather than fail on -- falls back to jpg, by far the most
  // common upload. The check is on the value, not on `null`: an empty string or a
  // non-string would build `?format=&name=orig`, which is the same 404 as omitting
  // it, so the guard has to be "is this a usable format" rather than "is this
  // field present". Guessing is the last resort here and not the strategy: a
  // format that arrives from the DOM is always used as given.
  function originalUrl(source) {
    var format = source.format;
    if (typeof format !== 'string' || format === '') format = 'jpg';
    return 'https://pbs.twimg.com/media/' + source.id + '?format=' + encodeURIComponent(format) + '&name=orig';
  }

  async function fetchOriginal(source) {
    var mediaId = source.id;
    var response;
    try {
      response = await fetch(originalUrl(source), {
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

  function compose(tiles, direction) {
    var size = XIW.computeCanvasSize(tiles, direction);
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

    // Nearest-neighbour, and this is load-bearing rather than a preference.
    // Smoothing defaults to true, and once the height cap has scaled the
    // composite down, every tile lands on a non-integer destination origin and
    // a non-integer height. Skia then filters, and the destination rows at each
    // part boundary become a partial blend of that tile's last row against the
    // white fill underneath -- a light seam on a dark photo, which is a seam.
    // With filtering off, each destination pixel takes exactly one source
    // pixel, so a fractional origin shifts the row selection by at most one row
    // instead of blending two.
    //
    // The cost is that a heavily downscaled part is marginally more aliased
    // than a mipmap-filtered draw would be. Seamlessness wins: the product
    // promise is one image with no gap, and at scale === 1 -- the common case,
    // every gallery that fits inside the caps -- smoothing has no visible effect
    // at all, so this line costs nothing there. Do not helpfully turn it back
    // on: the geometry above is exact, and smoothing is what would undo it.
    context.imageSmoothingEnabled = false;

    // The draw size inside this loop is computeCanvasSize's arithmetic, restated.
    // It scaled the *unscaled* extents by `scale` and rounded each product once to
    // get the canvas dimensions. So the draw size has to be tile.width * `scale`
    // too. Re-deriving it from the canvas instead -- canvas.width and canvas.height,
    // the obvious-looking substitution -- rounds the same quantity a second time and
    // lands on the other side of a .5 tie for some gallery shapes, which puts each
    // boundary a fraction of a pixel off the one before it and shows up as a
    // hairline seam. `scale` is the only number here that never got rounded.
    //
    // `offset` is the running position on the axis being joined: y for a vertical
    // stack, x for a horizontal strip. The perpendicular axis centers each part, so
    // parts of differing sizes line up on their shared edge -- which is what a
    // split gallery expects in either direction.
    // The placement arithmetic lives in core.js so it can be tested without a
    // canvas; this loop only draws what it is told to.
    var boxes = XIW.tileBoxes(tiles, size, direction);
    for (var i = 0; i < tiles.length; i++) {
      var tile = tiles[i];
      var box = boxes[i];
      context.drawImage(tile.source, box.x, box.y, box.width, box.height);
      // Released here rather than in one sweep at the end: toBlob is the slow
      // step below and should not run holding every part in decoded memory.
      // releaseTile() clears the handle, so the backstop sweep in
      // stitchImages is free to run over these tiles again on a throw.
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
  // backstop sweep in stitchImages nor a second pass can release it twice.
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

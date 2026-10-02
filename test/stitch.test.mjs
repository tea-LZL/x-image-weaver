import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from './harness.mjs';

// The URL stitch.js asks the CDN for, which is where the extension was broken in
// the field: it requested `?name=orig` with no `format`, X's CDN answered 404 for
// every part, and the user saw "NETWORK HTTP 404" and no composite. Nothing is
// wrong with the rest of the pipeline when that happens -- the id is right, the
// decode never runs -- so the only assertion that catches it is the URL itself.
//
// These tests drive the real stitchVertical with a stubbed fetch and stop at the
// first thing that needs a browser. Decoding fails in Node, and that failure is
// expected and swallowed: by then the request has already been made and recorded,
// which is the whole point. The suite asserts the requests, not the composite.
const quietDecodeFailure = (promise) => promise.catch(() => {});

async function requestedUrls(sources) {
  const urls = [];
  const realFetch = globalThis.fetch;
  try {
    const XIW = loadAll({
      fetch: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(['not a real image']),
        };
      },
    });
    await quietDecodeFailure(XIW.stitchVertical(sources));
  } finally {
    globalThis.fetch = realFetch;
  }
  return urls;
}

test('requests the untouched upload with an explicit format', async () => {
  const urls = await requestedUrls([{ id: 'HTnhMtkbkAA6C-i', format: 'jpg' }]);
  assert.deepEqual(urls, ['https://pbs.twimg.com/media/HTnhMtkbkAA6C-i?format=jpg&name=orig']);
});

test('carries each part its own format, so a mixed gallery fetches correctly', async () => {
  const urls = await requestedUrls([
    { id: 'aaa', format: 'png' },
    { id: 'bbb', format: 'jpg' },
    { id: 'ccc', format: 'webp' },
  ]);
  assert.deepEqual(urls, [
    'https://pbs.twimg.com/media/aaa?format=png&name=orig',
    'https://pbs.twimg.com/media/bbb?format=jpg&name=orig',
    'https://pbs.twimg.com/media/ccc?format=webp&name=orig',
  ]);
});

test('falls back to jpg only when the source genuinely has no format', async () => {
  // Unreachable from X's markup -- every photo URL it renders spells the format
  // out -- but a source is data, and a missing format must not become the string
  // "null" in a URL. jpg is the fallback because it is by far the most common
  // upload, not because guessing is the strategy.
  const urls = await requestedUrls([{ id: 'abc', format: null }]);
  assert.deepEqual(urls, ['https://pbs.twimg.com/media/abc?format=jpg&name=orig']);
});

test('never builds a url without a format parameter', async () => {
  // The regression guard. Every shape of missing or malformed format must still
  // produce a URL the CDN can answer, because the failure mode is a 404 the user
  // sees as "couldn't merge this post" with no way to tell why.
  for (const format of [null, undefined, '']) {
    const urls = await requestedUrls([{ id: 'abc', format }]);
    assert.match(urls[0], /[?&]format=[a-z0-9]+&/, `format=${String(format)} produced ${urls[0]}`);
    assert.ok(!urls[0].includes('format=null'), 'literal null leaked into the URL');
    assert.ok(!urls[0].includes('format=undefined'), 'literal undefined leaked into the URL');
    assert.ok(urls[0].includes('name=orig'), 'the original size is the reason for the request');
  }
});

test('requests parts in the order they were handed over', async () => {
  // Order is the whole positioning contract: part n is drawn below part n-1, and
  // a reordered fetch would not be caught by any assertion about the composite.
  const urls = await requestedUrls([
    { id: 'first', format: 'jpg' },
    { id: 'second', format: 'jpg' },
    { id: 'third', format: 'jpg' },
  ]);
  assert.deepEqual(
    urls.map((u) => /media\/([^?]+)/.exec(u)[1]),
    ['first', 'second', 'third'],
  );
});

test('an empty source list is a caller bug and is not reported as a network failure', async () => {
  // stitchVertical is documented to let this propagate rather than launder it
  // into NETWORK or DECODE; collectPhotoSources refuses anything under two
  // photos, so nothing shipped can reach it. Pinned so the contract is deliberate.
  const XIW = loadAll({ fetch: async () => { throw new Error('must not be called'); } });
  await assert.rejects(XIW.stitchVertical([]), (err) => err.code === undefined);
});

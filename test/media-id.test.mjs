import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const { mediaIdFromUrl } = loadCore();

test('extracts an id from a full-size URL', () => {
  assert.equal(
    mediaIdFromUrl('https://pbs.twimg.com/media/dQw4w9WgXcQ?format=jpg&name=orig'),
    'dQw4w9WgXcQ',
  );
});

test('extracts an id from a thumbnail URL with a size query', () => {
  assert.equal(
    mediaIdFromUrl('https://pbs.twimg.com/media/abc123XYZ_-9?format=jpg&name=medium'),
    'abc123XYZ_-9',
  );
});

test('rejects a non-pbs host', () => {
  assert.equal(mediaIdFromUrl('https://example.com/media/dQw4w9WgXcQ?format=jpg'), null);
});

test('rejects a pbs path that is not /media/<id>', () => {
  assert.equal(mediaIdFromUrl('https://pbs.twimg.com/extensions/abc/img/foo.jpg'), null);
});

test('rejects empty and malformed input', () => {
  assert.equal(mediaIdFromUrl(''), null);
  assert.equal(mediaIdFromUrl('not a url'), null);
});

// `new URL` only reports the host and path, so a scheme outside http(s) is not
// rejected here. Unreachable: every URL comes from an img src or a background-image
// on a page already served over https. Pinned so the leniency stays a decision.
test('accepts a non-http scheme once the host and path match', () => {
  assert.equal(mediaIdFromUrl('ftp://pbs.twimg.com/media/abc123XYZ_-9'), 'abc123XYZ_-9');
});

// Userinfo is not part of a URL's hostname, so `user@pbs.twimg.com` really is the
// pbs host. Same unreachable-by-origin argument as the scheme test above.
test('accepts a URL carrying userinfo, since hostname excludes it', () => {
  assert.equal(mediaIdFromUrl('https://user:pw@pbs.twimg.com/media/abc123XYZ_-9'), 'abc123XYZ_-9');
});

// The complement of the test above, and the one that makes the host check
// load-bearing. Userinfo can carry any host at all, so if hostname were read as
// everything before the path this would return an id scraped from a page X does
// not control, and stitch.js would fetch it.
test('rejects a media-shaped path on a host hidden behind userinfo', () => {
  assert.equal(mediaIdFromUrl('https://user:secret@evil.com/media/abc123XYZ_-9'), null);
});

// --- mediaSourceFromUrl: the format half -----------------------------------------
//
// The format is not a convenience. X's CDN resolves an image's encoding from the
// `format` query parameter, so a URL built from the id alone is a 404 -- verified
// against the live CDN with a real media id, which is what this pair exists to
// prevent from coming back.
const { mediaSourceFromUrl } = loadCore();

test('carries the format alongside the id', () => {
  assert.deepEqual(
    mediaSourceFromUrl('https://pbs.twimg.com/media/HTnhMtkbkAA6C-i?format=jpg&name=small'),
    { id: 'HTnhMtkbkAA6C-i', format: 'jpg' },
  );
});

test('reads the format regardless of parameter order', () => {
  assert.deepEqual(
    mediaSourceFromUrl('https://pbs.twimg.com/media/abc?name=orig&format=png'),
    { id: 'abc', format: 'png' },
  );
});

test('lowercases the format so a caller cannot build a URL from casing differences', () => {
  assert.deepEqual(
    mediaSourceFromUrl('https://pbs.twimg.com/media/abc?format=JPG'),
    { id: 'abc', format: 'jpg' },
  );
});

test('reports a missing format as null rather than guessing', () => {
  assert.deepEqual(mediaSourceFromUrl('https://pbs.twimg.com/media/abc?name=orig'), {
    id: 'abc',
    format: null,
  });
});

test('reports a format that is not extension-shaped as null', () => {
  // The value comes off a page, so it is not trusted to be sane: a caller that
  // used it verbatim would build a URL out of whatever was there.
  assert.equal(mediaSourceFromUrl('https://pbs.twimg.com/media/abc?format=a/b').format, null);
  assert.equal(mediaSourceFromUrl('https://pbs.twimg.com/media/abc?format=').format, null);
  assert.equal(mediaSourceFromUrl('https://pbs.twimg.com/media/abc?format=image%2Fpng').format, null);
});

test('still rejects the wrong host and the wrong path, format or not', () => {
  assert.equal(mediaSourceFromUrl('https://example.com/media/abc?format=jpg'), null);
  assert.equal(mediaSourceFromUrl('https://pbs.twimg.com/media/abc/def?format=jpg'), null);
  assert.equal(mediaSourceFromUrl('https://pbs.twimg.com/abc?format=jpg'), null);
  assert.equal(mediaSourceFromUrl('not a url'), null);
});

test('mediaIdFromUrl is exactly the id half of mediaSourceFromUrl', () => {
  // A view, not a second parser: if the two ever disagree, one of them is wrong.
  for (const raw of [
    'https://pbs.twimg.com/media/abc123XYZ_-9?format=jpg&name=medium',
    'https://pbs.twimg.com/media/abc?name=orig',
    'https://example.com/media/abc?format=jpg',
    '',
  ]) {
    const source = mediaSourceFromUrl(raw);
    assert.equal(mediaIdFromUrl(raw), source === null ? null : source.id, raw);
  }
});

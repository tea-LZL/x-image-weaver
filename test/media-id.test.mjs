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

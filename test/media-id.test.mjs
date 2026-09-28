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

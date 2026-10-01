import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore } from './harness.mjs';

const { downloadFilename } = loadCore();

test('uses a .png extension for a PNG composite', () => {
  assert.equal(
    downloadFilename({ handle: 'ada', tweetId: '98765' }, 'image/png'),
    'x-image-weaver-ada-98765.png',
  );
});

test('follows a JPEG fallback to a .jpg extension', () => {
  assert.equal(
    downloadFilename({ handle: 'ada', tweetId: '98765' }, 'image/jpeg'),
    'x-image-weaver-ada-98765.jpg',
  );
});

test('degrades to unknown handle and id rather than producing a broken name', () => {
  assert.equal(
    downloadFilename({ handle: '', tweetId: '' }, 'image/png'),
    'x-image-weaver-unknown-unknown.png',
  );
});

test('strips path-hostile characters from the handle', () => {
  assert.equal(
    downloadFilename({ handle: '../etc', tweetId: '1/2' }, 'image/png'),
    'x-image-weaver-etc-12.png',
  );
});

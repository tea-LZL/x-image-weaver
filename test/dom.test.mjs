import test from 'node:test';
import assert from 'node:assert/strict';
import { tweetFixture } from './fixtures.mjs';
import { loadDom } from './harness.mjs';

const { collectPhotoIds, tweetMeta, downloadFilename } = loadDom();
const first = (doc) => doc.querySelector('article[data-testid="tweet"]');

test('returns ids for a two-image post', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'bbb']);
});

test('preserves order for a four-image post', () => {
  const doc = tweetFixture({ photos: ['one', 'two', 'three', 'four'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['one', 'two', 'three', 'four']);
});

test('returns null for a single image', () => {
  const doc = tweetFixture({ photos: ['only'] });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('returns null for a post with no media', () => {
  const doc = tweetFixture({ photos: [] });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('returns null when a video is mixed in with photos', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], videos: 1 });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('returns null for a video-only post', () => {
  const doc = tweetFixture({ photos: [], videos: 1 });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('falls back to background-image when src is absent', () => {
  const doc = tweetFixture({ photos: [null, 'bbb'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'bbb']);
});

test('returns null when any photo fails to parse', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bad'] });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('preserves duplicate ids', () => {
  const doc = tweetFixture({ photos: ['aaa', 'aaa'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'aaa']);
});

test('attributes quoted media to the inner root only', () => {
  const doc = tweetFixture({ photos: [], quote: { photos: ['inner1', 'inner2'] } });
  const outer = doc.querySelector('article[data-testid="tweet"]');
  const inner = doc.querySelector('div[data-testid="quoteTweet"] article[data-testid="tweet"]');
  assert.equal(collectPhotoIds(outer), null);
  assert.deepEqual(collectPhotoIds(inner), ['inner1', 'inner2']);
});

test('reads tweetId and handle from the permalink and display name', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], tweetId: '98765', handle: 'ada' });
  assert.deepEqual(tweetMeta(first(doc)), { tweetId: '98765', handle: 'ada' });
});

// X sets the background-image on a wrapper inside the photo container as often
// as on the container itself, so the last link in the chain walks the subtree
// rather than reading one element.
test('falls back to a background-image on a nested element', () => {
  const doc = tweetFixture({ photos: [null, 'bbb'] });
  const photo = doc.querySelector('div[data-testid="tweetPhoto"]');
  photo.removeAttribute('style');
  const wrapper = doc.createElement('div');
  wrapper.setAttribute('style', 'background-image: url("https://pbs.twimg.com/media/nested?format=jpg")');
  photo.appendChild(wrapper);
  assert.deepEqual(collectPhotoIds(first(doc)), ['nested', 'bbb']);
});

// jsdom runs no image loader, so currentSrc is always '' and the first link in
// the chain would otherwise be untested. In Chrome it is the srcset-selected
// URL, which is not the src attribute, so the order has to be pinned. An own
// property shadows the prototype getter.
test('prefers currentSrc over src', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'] });
  const img = doc.querySelector('img');
  Object.defineProperty(img, 'currentSrc', {
    value: 'https://pbs.twimg.com/media/picked?format=jpg',
    configurable: true,
  });
  assert.deepEqual(collectPhotoIds(first(doc)), ['picked', 'bbb']);
});

// A missing permalink or display name must not cost the user their download.
// tweetMeta reports the empty string and downloadFilename, its only consumer,
// is what turns that into 'unknown' -- one place that decides, not two.
test('tweetMeta degrades to empty strings when the permalink and name are absent', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'] });
  doc.querySelector('a[href*="/status/"]').remove();
  doc.querySelector('[data-testid="User-Name"]').remove();
  const meta = tweetMeta(first(doc));
  assert.deepEqual(meta, { tweetId: '', handle: '' });
  assert.equal(downloadFilename(meta, 'image/png'), 'x-image-weaver-unknown-unknown.png');
});

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

// The rule: a video mixed into a gallery is not a split gallery, so the whole
// post is refused rather than merged with the video dropped. Two photos clear
// the two-photo gate, which is what makes this the *only* test that can pin the
// video rule -- with zero photos the gate returns null first, the video is never
// counted, and the test still passed after the video rule was deleted outright.
test('returns null when a video is mixed in with photos', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], videos: 1 });
  assert.equal(collectPhotoIds(first(doc)), null);
});

test('falls back to background-image when src is absent', () => {
  const doc = tweetFixture({ photos: [null, 'bbb'] });
  assert.deepEqual(collectPhotoIds(first(doc)), ['aaa', 'bbb']);
});

// The quote wrapper is a root type in its own right -- the spec names it, and
// Task 7 passes it as one -- so the wrapper itself has to answer for the post it
// wraps. Its inner media is at or below it, but it is not *inside* itself, and
// Node.contains is inclusive: wrapper.contains(wrapper) is true. Treat the
// wrapper as a boundary only when it is strictly below the root, or every quoted
// post silently loses its button.
test('attributes quoted media to the quote wrapper used as the root', () => {
  const doc = tweetFixture({ photos: [], quote: { photos: ['inner1', 'inner2'] } });
  const quoteRoot = doc.querySelector('div[data-testid="quoteTweet"]');
  assert.deepEqual(collectPhotoIds(quoteRoot), ['inner1', 'inner2']);
});

// The same inclusive-contains call governs the meta lookups, so the wrapper root
// goes just as dead there: empty id, empty handle, and a filename of
// x-image-weaver-unknown-unknown.png for a post whose real id and handle are
// right there in the DOM.
test('reads the quoted post meta from the quote wrapper used as the root', () => {
  const doc = tweetFixture({
    photos: [],
    quote: { tweetId: '98765', handle: 'ada', photos: ['inner1', 'inner2'] },
  });
  const quoteRoot = doc.querySelector('div[data-testid="quoteTweet"]');
  assert.deepEqual(tweetMeta(quoteRoot), { tweetId: '98765', handle: 'ada' });
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

test('reads tweetId from the permalink and the handle from the profile link', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], tweetId: '98765', handle: 'ada' });
  assert.deepEqual(tweetMeta(first(doc)), { tweetId: '98765', handle: 'ada' });
});

// The author cell is one element holding the display name and the @handle
// concatenated, so its textContent is "Ada Lovelace@ada" -- which does not begin
// with an @, and which stripping a leading @ leaves entirely intact. Neither
// half of that string is the handle; only the profile anchor's href is.
test('reads the handle from the profile link, not the concatenated author cell text', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], tweetId: '98765', handle: 'ada' });
  const cell = doc.querySelector('[data-testid="User-Name"]');
  assert.equal(cell.textContent, 'Ada Lovelace@ada', 'the cell really does concatenate both');
  assert.equal(tweetMeta(first(doc)).handle, 'ada');
});

// The status permalink lives in the same cell and is also a relative anchor, so
// the first one found, or the last path segment of any one of them, is wrong:
// "status/123" or "123" rather than "ada". Only the bare-profile-path filter
// separates them, so this is the test that makes that filter load-bearing.
test('picks the handle and not the permalink when both sit in the author cell', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], tweetId: '123', handle: 'ada' });
  const cell = doc.querySelector('[data-testid="User-Name"]');
  assert.deepEqual(
    [...cell.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    ['/ada/status/123', '/ada'],
    'the permalink is the first relative anchor in the cell',
  );
  assert.deepEqual(tweetMeta(first(doc)), { tweetId: '123', handle: 'ada' });
});

// An author cell that never rendered a profile link -- a locked account, a feed
// card, a cell that has not hydrated. The tweet id is read from a different part
// of the post and survives; only the handle goes empty, and nothing throws.
test('degrades to an empty handle when the author cell has no profile link', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], handle: 'ada' });
  const cell = doc.querySelector('[data-testid="User-Name"]');
  for (const anchor of cell.querySelectorAll('a')) anchor.remove();

  assert.equal(tweetMeta(first(doc)).handle, '');
  assert.equal(tweetMeta(first(doc)).tweetId, '123', 'the permalink is an independent source');
});

// /i/user/<id> is a route, not a profile path, and it is the shape most likely to
// be mistaken for one: it starts with / and it sits exactly where a handle does.
// A single-segment requirement is what rejects it.
test('rejects a non-profile route sitting where the handle would be', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'], handle: 'ada' });
  const cell = doc.querySelector('[data-testid="User-Name"]');
  for (const anchor of cell.querySelectorAll('a')) anchor.remove();
  const route = doc.createElement('a');
  route.setAttribute('href', '/i/user/123456');
  cell.appendChild(route);

  assert.equal(tweetMeta(first(doc)).handle, '');
});

// A quoted post's author cell and status permalink belong to the quoted post,
// and root.querySelector() searches the whole subtree including the quote. Both
// lookups are scoped to the root's own elements, so an outer post that rendered
// neither degrades to empty rather than taking the quoted post's author and id --
// which would name the file after a different tweet than the one whose images
// were merged.
test("reads the outer post's own handle and id, never a quoted post's", () => {
  const doc = tweetFixture({
    photos: ['aaa', 'bbb'],
    tweetId: '111',
    handle: 'outer',
    quote: { tweetId: '222', handle: 'inner', photos: ['i1', 'i2'] },
  });
  const outer = doc.querySelector('article[data-testid="tweet"]');
  const inner = doc.querySelector('div[data-testid="quoteTweet"] article[data-testid="tweet"]');

  assert.deepEqual(tweetMeta(outer), { tweetId: '111', handle: 'outer' });
  assert.deepEqual(tweetMeta(inner), { tweetId: '222', handle: 'inner' });

  outer.querySelector('[data-testid="User-Name"]').remove();
  for (const link of outer.querySelectorAll(':scope > a[href*="/status/"]')) link.remove();
  assert.deepEqual(tweetMeta(outer), { tweetId: '', handle: '' });
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
// is what turns that into 'unknown' -- one place that decides, not two. Every
// status link goes, not just the first: a post has more than one.
test('tweetMeta degrades to empty strings when the permalink and name are absent', () => {
  const doc = tweetFixture({ photos: ['aaa', 'bbb'] });
  for (const link of doc.querySelectorAll('a[href*="/status/"]')) link.remove();
  doc.querySelector('[data-testid="User-Name"]').remove();
  const meta = tweetMeta(first(doc));
  assert.deepEqual(meta, { tweetId: '', handle: '' });
  assert.equal(downloadFilename(meta, 'image/png'), 'x-image-weaver-unknown-unknown.png');
});

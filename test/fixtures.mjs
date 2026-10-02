import { JSDOM } from 'jsdom';

// The id a `null` photo entry carries. X paints some timeline images as a CSS
// background instead of an <img>, so the fixture needs a media id to put in that
// background-image; a fixed stand-in keeps the expected array in a test readable.
const BACKGROUND_ONLY_ID = 'aaa';

// A src that is media-shaped but not a pbs.twimg.com /media/<id> URL, so
// collecting it fails on the host check rather than on the path check.
const UNPARSEABLE_SRC = 'https://example.com/media/bad?format=jpg&name=orig';

const pbsUrl = (id) => `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;

// The display name is derived from the handle and never equals it, and it has a
// space in it, because that is the trap: X renders the display name and the
// @handle concatenated in one element, so the cell's textContent cannot separate
// them. `ada` gives the real page's "Ada Lovelace@ada".
const displayNameFor = (handle) => `${handle.charAt(0).toUpperCase()}${handle.slice(1)} Lovelace`;

// Builds a document holding one tweet, shaped like the part of X's DOM that
// collectPhotoIds and tweetMeta read.
//
//   photos   media ids for the post's own [data-testid="tweetPhoto"] containers,
//            in order. `null` means background-painted (no src, inline
//            background-image); the string 'bad' means an unparseable src.
//   videos   how many [data-testid="videoPlayer"] containers to add beside them.
//   quote    false/null for none, or another spec object -- passed straight back
//            through this function -- wrapped in div[data-testid="quoteTweet"]
//            inside the outer article.
export function tweetFixture({
  photos = [],
  videos = 0,
  quote = null,
  tweetId = '123',
  handle = 'someone',
  // The page the post is being read on, which is a fact about the DOM the fixture
  // builds and not only about the test: button.js chooses its control from the
  // path, so a fixture on a status URL is a post being read on its own page and a
  // fixture anywhere else is one in a feed.
  url = 'https://x.com/',
} = {}) {
  // A real base URL matters: `img.src` resolves against it, and X's real page
  // has one.
  const document = new JSDOM('<!doctype html><html><body></body></html>', {
    url,
  }).window.document;

  const article = document.createElement('article');
  article.setAttribute('data-testid', 'tweet');

  const permalink = document.createElement('a');
  permalink.setAttribute('href', `https://x.com/${handle}/status/${tweetId}`);
  permalink.textContent = '2h';
  article.appendChild(permalink);

  article.appendChild(authorCell(document, handle, tweetId));

  const media = document.createElement('div');
  for (const id of photos) media.appendChild(photoElement(document, id));
  for (let i = 0; i < videos; i++) {
    const player = document.createElement('div');
    player.setAttribute('data-testid', 'videoPlayer');
    media.appendChild(player);
  }
  article.appendChild(media);

  if (quote) {
    // The quoted post is a real nested article, not a flattened stub: that
    // nesting is the whole point, because the quote wrapper sits between the
    // outer root and the inner root and each is passed in as `root` in turn.
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-testid', 'quoteTweet');
    const inner = tweetFixture(quote).querySelector('article[data-testid="tweet"]');
    wrapper.appendChild(document.importNode(inner, true));
    article.appendChild(wrapper);
  }

  document.body.appendChild(article);
  return document;
}

// [data-testid="User-Name"] as X renders it: a status permalink, a display name
// span and the @handle, all in one element. The handle is only recoverable from
// the profile anchor's href -- the cell's textContent is "Ada Lovelace@ada" and
// does not begin with an @, so stripping a leading one yields the whole string.
function authorCell(document, handle, tweetId) {
  const cell = document.createElement('div');
  cell.setAttribute('data-testid', 'User-Name');

  // First on purpose. This is also an a[href^="/"], it is inside the same cell,
  // and it is the one thing a "first relative anchor in the cell" read would
  // wrongly pick up. The bare-path filter is what rejects it.
  const permalink = document.createElement('a');
  permalink.setAttribute('href', `/${handle}/status/${tweetId}`);
  cell.appendChild(permalink);

  const displayName = document.createElement('span');
  displayName.textContent = displayNameFor(handle);
  cell.appendChild(displayName);

  const handleSpan = document.createElement('span');
  const profile = document.createElement('a');
  profile.setAttribute('href', `/${handle}`);
  profile.textContent = `@${handle}`;
  handleSpan.appendChild(profile);
  cell.appendChild(handleSpan);

  return cell;
}

function photoElement(document, id) {
  const photo = document.createElement('div');
  photo.setAttribute('data-testid', 'tweetPhoto');

  if (id === null) {
    photo.setAttribute('style', `background-image: url("${pbsUrl(BACKGROUND_ONLY_ID)}")`);
  } else {
    const img = document.createElement('img');
    img.setAttribute('src', id === 'bad' ? UNPARSEABLE_SRC : pbsUrl(id));
    photo.appendChild(img);
  }
  return photo;
}

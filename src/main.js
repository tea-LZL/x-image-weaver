var XIW = (globalThis.XIW = globalThis.XIW || {});

// The last script the manifest loads, and the only one that starts anything.
//
// X is a React SPA, and every surface this extension decorates -- the home
// timeline, a profile, search results, a post's own page, a thread's replies, a
// media tab, a quoted tweet inside another post -- is the same handful of
// selectors, appearing and disappearing without a page load. So discovery is not
// "scan the page": it is "notice every tweet that ever appears", continuously,
// for as long as the tab is open.
//
// That is what the MutationObserver below is for, and its shape is the whole
// difficulty. Two failure modes bracket it, and both are silent:
//
//   Scanning the whole document on every mutation. X commits thousands of
//   unrelated DOM changes a second, and a full document query over a long
//   timeline is tens of thousands of nodes. That is the difference between a
//   page that scrolls and a page that does not.
//
//   Scanning only the added nodes' *descendants*. React mounts a tweet by
//   inserting the tweet element itself, so a tweet added as a bare root is the
//   one case the descendant query cannot see. Hence matches() as well as
//   querySelectorAll() below, and that is the only reason it is there.
//
// The Set and the requestAnimationFrame between them are the third thing, and
// they are not optimization dressing. React adds many nodes in one commit (a
// whole batch of timeline posts arrives as one commit), so the Set is what turns
// "fifty added nodes" into "fifty candidates, scanned once"; and the rAF is what
// turns a fast scroll -- a burst of commits across many frames -- into one drain
// per frame rather than one scan per commit.
//
// The `data-xiw-done` attribute is the idempotency marker, and it is an
// attribute rather than a WeakSet on purpose. React re-uses and re-parents DOM
// nodes: the same element object can be a different node in a different place in
// the tree from one commit to the next, and it can be discarded entirely and a
// visually identical one created. Node identity is therefore not a stable
// statement about "this post", while an attribute written onto the element
// survives a re-render of the element itself. It is also the honest marker for
// what it records -- that the *DOM node* was mounted -- so a node that arrives
// already carrying it was processed, whether by us now or by X copying it.
//
// Everything below is in an IIFE, for the reason the other five say: these are
// classic content scripts sharing one isolated world, and a top-level var or
// function becomes a property of it, which is a name any of them could clobber.
// Nothing here reaches the namespace -- main.js produces no exports at all, it
// only calls what button.js published.
(function () {

  // The roots are BOTH kinds, and the second is not optional. A quoted post is
  // not reliably an <article>: X renders it as a plain div carrying the
  // quoteTweet testid, and watching for articles alone misses every quoted
  // post, which is exactly where a mergeable gallery is most likely to be
  // hiding. Composed from XIW.SELECTORS rather than written out, so the day X
  // renames one testid it is one edit in core.js and not two here.
  //
  // Resolved per call and not hoisted, which is every other selector read in
  // this extension's house style: the composed string is a pure function of the
  // namespace, and resolving it inside scan() is also what keeps this file from
  // reading XIW.SELECTORS at load time -- see the boot guard at the bottom.
  function rootSelector() {
    return XIW.SELECTORS.tweet + ', ' + XIW.SELECTORS.quoteTweet;
  }

  // Candidate roots waiting for the next frame, and whether that frame is already
  // requested. A Set and not an array because React inserts the same element
  // more than once in a burst far more often than intuition suggests, and a
  // duplicate in the queue is a second mount attempt for a root that is about to
  // be marked anyway.
  var pending = new Set();
  var frameScheduled = false;

  /**
   * @function scan
   * @param {Node} root Any node: an added node, or document.body.
   * @returns {void}
   * @description Mounts every tweet root at or under `root` that has not been
   * mounted already. Scoped to the node it is given, never to the document --
   * the whole reason the drain below walks a queue instead of re-querying.
   *
   * A no-op for anything that cannot be queried. That is not a formality:
   * MutationRecord.addedNodes is a NodeList of whatever was inserted, and X
   * inserts text nodes constantly.
   */
  function scan(root) {
    if (!isQueryable(root)) return;

    var selector = rootSelector();
    var roots = [];

    // Before the descendants, and both. querySelectorAll does not include the
    // element it is called on, so without this line a tweet inserted as a bare
    // root is invisible to its own observer callback -- the failure is not that
    // the post is missed permanently, it is that no later mutation necessarily
    // touches it again either.
    if (typeof root.matches === 'function' && root.matches(selector)) roots.push(root);

    var found = root.querySelectorAll(selector);
    for (var i = 0; i < found.length; i++) roots.push(found[i]);

    for (var j = 0; j < roots.length; j++) mountGuarded(roots[j]);
  }

  // One root's failure must not cost its siblings their button, and containment
  // belongs here rather than around scan() in the drain: a subtree can hold
  // several roots (a post, its quote wrapper, the quoted post), so a catch one
  // level up would still abandon every root after the throwing one in the same
  // subtree. The drain empties the queue into a snapshot before scanning, so a
  // root skipped by an exception has no second copy anywhere -- the only thing
  // that brings it back is a later mutation touching the same subtree, which for
  // a post already scrolled past may never come.
  //
  // The marker is written only when a button actually landed, and that is the
  // difference between a working feed and an intermittent one. React fills a
  // tweet's media in across more than one commit, so a root is routinely observed
  // while it has zero or one photo -- and a post whose media has not rendered yet
  // is indistinguishable from a post that is not a gallery. Marking both as done
  // means the first kind is never examined again: the root is already marked, and
  // the commit that adds its media is a childList change *inside* it, which only
  // re-scans the added node and finds no root. Leaving it unmarked keeps it
  // eligible for the next look. That is also why the enqueue below re-examines a
  // root when something lands inside it.
  //
  // A root that throws is marked anyway. That is the one case where retrying is
  // wrong: a fault is not "not yet", and an unmarked faulting root would be
  // re-attempted on every later mutation of that post, logging each time. Marking
  // it fails toward "this post has no button", which the user can see and recover
  // from by reloading.
  //
  // No UI surface exists for "this post could not be decorated", so the console is
  // the only honest one. Swallowing it would leave a post with no button and no
  // record of why -- and a silent failure is the failure mode this whole file is
  // written against.
  function mountGuarded(root) {
    // `!== undefined`, and not a truthiness test. The marker is written as the
    // empty string, which is the DOM convention for a valueless flag, so a
    // truthiness check reads it as absent on every root and examines every post
    // on every scan. That failure is quieter than it looks -- mount() is itself
    // idempotent, so no second button appears and the timeline looks correct --
    // but it throws away this file's entire cost bound, re-running the
    // mergeability read and its two getComputedStyle reads per post per frame,
    // for nothing.
    if (root.dataset.xiwDone !== undefined) return;

    var mounted = false;
    try {
      mounted = XIW.button.mount(root) === true;
    } catch (err) {
      root.dataset.xiwDone = '';
      console.error('[x-image-weaver] could not decorate a post', err);
      return;
    }

    if (mounted) root.dataset.xiwDone = '';
  }

  // Duck-typed, never `instanceof Element`, and for the reason dom.js documents:
  // this file is evaluated in Node's realm by the test harness and handed jsdom
  // elements from another one, so an instanceof check against a host global is
  // false in the tests and true in Chrome. A Text node reaches here from every
  // mutation X commits that inserts text, and it has neither method.
  function isQueryable(node) {
    return Boolean(node) && typeof node.querySelectorAll === 'function' && typeof node.matches === 'function';
  }

  // One frame, not one mutation. A drain empties the whole queue and clears it
  // before scanning, so a scan that somehow causes a new mutation enqueues for
  // the NEXT frame rather than re-entering this one.
  function drain() {
    frameScheduled = false;
    if (pending.size === 0) return;

    var nodes = Array.from(pending);
    pending.clear();
    for (var i = 0; i < nodes.length; i++) {
      // A node React inserted and then removed again before this frame -- a
      // keyed list reconciling, or a route change landing mid-scroll -- is
      // detached now. Mounting into it would be invisible work on a subtree
      // about to be dropped, and the scan is the expensive part, so it is
      // skipped. `isConnected` rather than a `document.contains` walk: it is one
      // property read, and it is the property that answers exactly this.
      //
      // Note what this does NOT skip: a re-parented node is still connected, so
      // a tweet React moves elsewhere in the tree is still scanned at its new
      // position. That is the case the marker exists for.
      if (nodes[i].isConnected === false) continue;
      scan(nodes[i]);
    }
  }

  // Decide what a mutation should make us look at, and it is usually a post rather
  // than the node that changed.
  //
  // The obvious rule -- enqueue the added node, scan it and its descendants -- is
  // what missed late media. A tweet's images arrive in a commit *after* the
  // article does, and that commit adds a node deep inside a root, where scanning
  // the node and its descendants finds no root at all; the root that needs
  // re-examining is upwards. So walk up to the nearest enclosing root first and
  // queue that. A media commit inside a post then re-examines exactly that post.
  //
  // The cost bound is the Set plus the marker: a root is re-examined once per
  // frame no matter how many of its descendants changed, and an already-mounted
  // root costs one dataset read. The posts that get re-examined for real are the
  // ones with no button, which is the work that has to happen anyway -- a post
  // that is not a gallery stays unmarked on purpose, because "not a gallery" and
  // "media has not rendered yet" are indistinguishable at the moment we look.
  //
  // A node that is not inside any root still gets queued as itself: it may BE a
  // root, or contain several, which is how a whole new post is discovered.
  function enqueue(node) {
    if (!isQueryable(node)) return;
    var ancestorRoot = node.closest(rootSelector());
    pending.add(ancestorRoot === null ? node : ancestorRoot);
  }

  // The observer callback. Collects, then schedules -- never scans inline. A scan
  // inside this callback would run per commit, and X commits a lot; every root
  // mount here writes to the DOM, which means scanning inline also mutates the
  // tree the observer is reporting on, and the callback would re-enter itself.
  function collect(records) {
    for (var i = 0; i < records.length; i++) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j++) enqueue(added[j]);
    }
    scheduleDrain();
  }

  // A boolean and not the rAF handle. The handle would be equally correct --
  // frame ids are positive longs -- but a boolean states the one fact this needs
  // ("is a drain already waiting?") without importing the host's id convention,
  // and it stays correct if this ever schedules more than one kind of frame
  // callback.
  function scheduleDrain() {
    if (frameScheduled) return;
    frameScheduled = true;
    requestAnimationFrame(drain);
  }

  function observe() {
    // Rooted at document.body, not at document and not at a container. body is
    // the node X renders into and the node that survives every SPA route change,
    // and it is the narrowest node under which every surface the extension cares
    // about is still reachable: home timeline, profile, search, a post's own
    // page, thread replies, a media tab, a quoted post. Watching a timeline
    // container instead would work on the home tab and fail everywhere else, and
    // watching document would only add the head.
    //
    // childList + subtree, and nothing else. Not attributes: the only attribute
    // this extension writes is its own marker, so observing attributes would
    // report back every mount this file performs and make each drain re-scan the
    // subtree it just wrote to. Not characterData: X rewrites tweet text
    // constantly as posts stream in, and no text node can contain a root.
    new MutationObserver(collect).observe(document.body, { childList: true, subtree: true });
  }

  /**
   * @function start
   * @returns {void}
   * @description The one-time bootstrap: cover what is already on screen, then
   * watch for everything after it.
   *
   * The initial scan comes first on purpose. There is a window between the
   * document being parsed and the observer being attached, and the tweets
   * already rendered are in it; attaching first and scanning second would still
   * find them (the scan does not depend on the observer having been there), but
   * doing the scan first means the two never overlap, so no root is mounted by
   * both and the marker is not load-bearing for correctness at startup.
   */
  function start() {
    scan(document.body);
    observe();
  }

  // The boot guard, and it is not defensive padding: this file is evaluated by
  // test/loader.test.mjs in a bare vm context with no `document` at all, and a
  // ReferenceError at load time would fail that suite for every future script
  // added to the manifest. It also covers a real browser case -- a content
  // script matching a document that never had a body.
  if (typeof document !== 'undefined' && document && typeof MutationObserver === 'function') {
    if (document.body) {
      start();
    } else if (document.readyState === 'loading') {
      // Still parsing, so a body is coming. Only reachable outside
      // document_idle, which is why it is not the common path: Chrome injects
      // content scripts at document_idle, after the document is interactive, at
      // which point document.body always exists. The reverse case -- no body and
      // not loading -- is a document that has nothing to decorate, and there is
      // no event left to wait for, so nothing is scheduled and nothing breaks.
      document.addEventListener(
        'DOMContentLoaded',
        function () {
          if (document.body) start();
        },
        { once: true }
      );
    }
  }

  // Deliberately not kept in a variable, and deliberately never disconnected.
  // A MutationObserver is kept alive by the node it observes, so the missing
  // reference does not collect it; and there is no condition under which
  // disconnecting is right. A content script lives exactly as long as the
  // document, X never replaces document.body -- an SPA route change swaps its
  // children, not the body -- and nothing this file accumulates survives a
  // route change anyway: the queue is emptied every frame and the marker
  // travels with the node it is on. So the conditions that would justify
  // disconnecting (the extension being disabled, the user being logged out, a
  // teardown) are all conditions in which this context stops existing, and the
  // observer with it.
})();

/**
 * The only client-side code in the system, and it stays that way.
 *
 * What it replaces was `setTimeout(function () { location.reload(); }, 5000)` —
 * a full navigation every five seconds, which threw away scroll position, text
 * selection, keyboard focus and any open <details>, and made the browser refetch
 * the favicon so the tab itself flickered.
 *
 * The rule that makes this quiet: a region whose version has not changed is
 * never touched. An idle system therefore mutates no DOM at all, and the page
 * can sit open for an hour without moving. That is a server-side property — the
 * versions come from the same renderer as the markup — which is why almost none
 * of the logic worth testing lives in here.
 *
 * It is progressive enhancement, not a requirement (ticket 0008 section 7, WP2):
 * every region is fully rendered in the document, and without JavaScript the
 * page is simply a snapshot that says so.
 */
export const LIVE_SCRIPT = `
<script>
(function () {
  var body = document.body;
  var src = body.getAttribute('data-live');
  if (!src || !window.fetch) return;

  var every = Number(body.getAttribute('data-live-ms')) || 5000;
  var base = body.getAttribute('data-title') || 'mycelium';
  var stamp = document.getElementById('as-of');
  var state = document.getElementById('live-state');
  var timer = null;
  var misses = 0;

  function say(word, stale) {
    if (state) state.textContent = word;
    body.classList.toggle('is-stale', stale === true);
  }

  function patch(data) {
    var nodes = document.querySelectorAll('[data-region]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var next = data.regions[node.getAttribute('data-region')];
      if (!next) continue;

      // Unchanged. Not touching it is the entire point.
      if (node.getAttribute('data-v') === next.v) continue;

      // Something in here has the caret or is mid-click. The next tick is
      // seconds away and the version will still differ, so leave it alone
      // rather than pulling the ground out from under the operator.
      if (node.contains(document.activeElement)) continue;

      var open = {};
      var before = node.querySelectorAll('details[id]');
      for (var j = 0; j < before.length; j++) open[before[j].id] = before[j].open;

      node.innerHTML = next.html;
      node.setAttribute('data-v', next.v);

      var after = node.querySelectorAll('details[id]');
      for (var k = 0; k < after.length; k++) {
        if (open[after[k].id]) after[k].open = true;
      }
    }

    if (stamp) {
      stamp.textContent = data.as_of;
      stamp.setAttribute('datetime', data.as_of);
    }
    document.title = (data.attention > 0 ? '(' + data.attention + ') ' : '') + base;
  }

  function poll() {
    fetch(src, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (response) {
        // 404 means the plan is gone; 401 and 403 mean the Serve session is.
        // None of those start working again on their own, so stop rather than
        // hammer the route once every five seconds until the tab is closed.
        if (response.status === 404 || response.status === 401 || response.status === 403) {
          stop();
          say('stopped', false);
          body.classList.add('is-gone');
          return null;
        }
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (data) {
        if (!data) return;
        misses = 0;
        say('live', false);
        patch(data);
      })
      .catch(function () {
        // One miss is a blip. Two is worth saying out loud, because a page that
        // looks live and is not is worse than one that admits it is stale.
        misses += 1;
        if (misses >= 2) say('stale', true);
      });
  }

  function start() {
    if (timer) return;
    timer = setInterval(poll, every);
    poll();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Browsers throttle timers in background tabs, so a poll left running there
  // reports a time it did not really check at. Stopping, and refetching on the
  // way back, is both cheaper and more honest.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  if (!document.hidden) start();
})();
</script>`;

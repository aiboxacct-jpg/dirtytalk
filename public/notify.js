// Sitewide private-message notifications: an unread badge on the Messages link
// and a slide-in toast when a new message arrives on any page.
(function () {
  var badge = document.getElementById('dm-badge');
  var toasts = document.getElementById('toasts');
  if (!toasts) return;

  var SEEN_KEY = 'dt_dm_seen'; // { threadId: lastReadMessageId } — persists across pages
  function getSeen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (e) { return {}; } }
  function saveSeen(s) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(s)); } catch (e) {} }

  // The thread currently open (if any) counts as read as new messages come in.
  var openThread = (location.pathname.match(/^\/dm\/(\d+)/) || [])[1] || null;

  var toastedAt = {}; // threadId -> latestId already toasted this session (in-memory)
  var primed = false; // skip toasting pre-existing unread on the very first poll

  function showToast(t) {
    var a = document.createElement('a');
    a.className = 'toast';
    a.href = t.link;
    var title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = '💌 New message from ' + t.from;
    var body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = t.preview;
    a.appendChild(title);
    a.appendChild(body);
    toasts.appendChild(a);
    setTimeout(function () { a.classList.add('show'); }, 20);
    setTimeout(function () {
      a.classList.remove('show');
      setTimeout(function () { a.remove(); }, 350);
    }, 7000);
  }

  async function poll() {
    var data;
    try {
      var r = await fetch('/dm/activity', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      data = await r.json();
    } catch (e) { return; }
    if (!data || !data.threads) return;

    var seen = getSeen();
    var unread = 0;
    var toToast = [];

    data.threads.forEach(function (t) {
      if (openThread && String(t.id) === openThread) {
        seen[t.id] = t.latestId;        // reading it now
        toastedAt[t.id] = t.latestId;
        return;
      }
      if (t.incoming && t.latestId > (seen[t.id] || 0)) unread++;
      if (t.incoming && t.latestId > (toastedAt[t.id] || 0)) {
        if (primed) toToast.push(t);     // only alert for genuinely new arrivals
        toastedAt[t.id] = t.latestId;
      }
    });

    saveSeen(seen);

    if (badge) {
      if (unread > 0) { badge.textContent = unread > 9 ? '9+' : unread; badge.hidden = false; }
      else { badge.hidden = true; }
    }
    toToast.slice(-3).forEach(showToast);
    primed = true;
  }

  poll();
  setInterval(poll, 7000);
})();

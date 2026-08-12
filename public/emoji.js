// Lightweight, dependency-free emoji picker.
// Any <button class="emoji-btn" data-target="INPUT_ID"> opens a shared panel;
// clicking an emoji inserts it at the caret of the target input/textarea.
(function () {
  var GROUPS = [
    ['Smileys', '😀 😁 😂 🤣 😊 🙂 😉 😍 🥰 😘 😗 😚 😋 😛 😜 🤪 😝 🤗 😏 😌 😴 🥵 😳 🤭'.split(' ')],
    ['Flirty', '😈 💋 👅 👄 🍑 🍆 💦 🔥 ✨ 🌶️ 🥂 🍷 🫦 👀 🙈'.split(' ')],
    ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💕 💞 💓 💗 💖 💘 💝 💔'.split(' ')],
    ['Hands', '👋 🤙 👌 👍 👏 🙌 🙏 💪 🫶 🤝 💃 🕺'.split(' ')]
  ];

  var panel = null;
  var currentTarget = null;
  var isOpen = false;

  function build() {
    panel = document.createElement('div');
    panel.className = 'emoji-panel';
    GROUPS.forEach(function (g) {
      var label = document.createElement('div');
      label.className = 'emoji-group-label';
      label.textContent = g[0];
      panel.appendChild(label);
      var grid = document.createElement('div');
      grid.className = 'emoji-grid';
      g[1].forEach(function (e) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'emoji-item';
        b.textContent = e;
        // Use mousedown so the target input doesn't lose its caret first.
        b.addEventListener('mousedown', function (ev) {
          ev.preventDefault();
          insert(e);
        });
        grid.appendChild(b);
      });
      panel.appendChild(grid);
    });
    document.body.appendChild(panel);
  }

  function insert(emoji) {
    var el = currentTarget;
    if (!el) return;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    if (typeof start === 'number' && typeof end === 'number') {
      var v = el.value;
      el.value = v.slice(0, start) + emoji + v.slice(end);
      var pos = start + emoji.length;
      el.selectionStart = el.selectionEnd = pos;
    } else {
      el.value += emoji;
    }
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function place(btn) {
    panel.style.visibility = 'hidden';
    panel.style.display = 'block';
    var r = btn.getBoundingClientRect();
    var pw = panel.offsetWidth;
    var ph = panel.offsetHeight;
    var left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8));
    var top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8; // flip below if no room above
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.visibility = 'visible';
  }

  function open(btn) {
    currentTarget = document.getElementById(btn.getAttribute('data-target'));
    if (!panel) build();
    place(btn);
    isOpen = true;
  }
  function close() {
    if (panel) panel.style.display = 'none';
    isOpen = false;
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.emoji-btn');
    if (btn) {
      e.preventDefault();
      var target = document.getElementById(btn.getAttribute('data-target'));
      if (isOpen && currentTarget === target) close();
      else open(btn);
      return;
    }
    if (isOpen && panel && !panel.contains(e.target)) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', close);
})();

// The global room: page, live JSON feed, and posting.
const express = require('express');
const db = require('../db');
const { uploadSingle, uploadImage } = require('../storage');

const router = express.Router();
const BODY_MAX = 500;
const NAME_MAX = 30;
const COOLDOWN_MS = 1200;

function nickFor(req) {
  return 'guest-' + String(req.gid || 'anon').slice(0, 4);
}
function displayName(req, provided) {
  if (req.user) return req.user.name;
  const n = String(provided || '').trim().slice(0, NAME_MAX);
  return n || nickFor(req);
}
function serialize(rows, req) {
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    body: m.body,
    image: m.image_url || null,
    created_at: m.created_at,
    creatorId: m.user_id || null, // set => a signed-up creator you can DM + tip
    mine:
      (!!req.user && m.user_id === req.user.id) ||
      (!req.user && !!m.gid && m.gid === req.gid),
  }));
}
function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json');
}

// Room page
router.get('/', async (req, res) => {
  const rows = await db.all('SELECT * FROM room_messages ORDER BY id DESC LIMIT 100');
  rows.reverse();
  // A few creators to show as "here now" — most recently active.
  const creators = await db.all(
    "SELECT id, name, cashapp, venmo FROM users ORDER BY COALESCE(online_at, created_at) DESC LIMIT 12"
  );
  res.render('room', {
    title: 'Room',
    messages: serialize(rows, req),
    creators,
    suggestedName: req.user ? req.user.name : nickFor(req),
    isGuest: !req.user,
  });
});

// Live feed of messages after a given id
router.get('/feed', async (req, res) => {
  const after = Number(req.query.after) || 0;
  const rows = await db.all('SELECT * FROM room_messages WHERE id > ? ORDER BY id LIMIT 200', after);
  res.json({ messages: serialize(rows, req) });
});

// Post a message
const lastPost = new Map();
router.post('/room', async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, BODY_MAX);
  const name = displayName(req, req.body.name);
  const json = wantsJson(req);
  if (!body) return json ? res.json({ ok: false, error: 'empty' }) : res.redirect('/');

  const key = req.user ? 'u' + req.user.id : 'g' + req.gid;
  const now = Date.now();
  if (lastPost.get(key) && now - lastPost.get(key) < COOLDOWN_MS) {
    return json ? res.json({ ok: false, error: 'Slow down a moment.' }) : res.redirect('/');
  }
  lastPost.set(key, now);

  const info = await db.run(
    'INSERT INTO room_messages (user_id, gid, name, body) VALUES (?, ?, ?, ?)',
    req.user ? req.user.id : null,
    req.user ? null : req.gid,
    name,
    body
  );
  if (json) {
    const m = await db.get('SELECT * FROM room_messages WHERE id = ?', Number(info.lastInsertRowid));
    return res.json({ ok: true, message: serialize([m], req)[0] });
  }
  res.redirect('/');
});

// Post a picture to the room (ajax only)
router.post('/room/upload', uploadSingle('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No image selected.' });
  const name = displayName(req, req.body.name);
  const key = req.user ? 'u' + req.user.id : 'g' + req.gid;
  const now = Date.now();
  if (lastPost.get(key) && now - lastPost.get(key) < COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: 'Slow down a moment.' });
  }
  lastPost.set(key, now);
  let url;
  try {
    url = await uploadImage(req.file.buffer, req.file.originalname);
  } catch (e) {
    console.error('room upload failed:', (e && (e.message || e.error)) || e);
    return res.status(500).json({ ok: false, error: 'Upload failed. Try again.', detail: (e && (e.message || (e.error && e.error.message))) || String(e) });
  }
  const info = await db.run(
    'INSERT INTO room_messages (user_id, gid, name, body, image_url) VALUES (?, ?, ?, ?, ?)',
    req.user ? req.user.id : null,
    req.user ? null : req.gid,
    name,
    '',
    url
  );
  const m = await db.get('SELECT * FROM room_messages WHERE id = ?', Number(info.lastInsertRowid));
  res.json({ ok: true, message: serialize([m], req)[0] });
});

module.exports = router;

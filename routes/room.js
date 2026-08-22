// The global room: page, live JSON feed, and posting.
const express = require('express');
const db = require('../db');
const { uploadSingle, uploadImage, deleteImage } = require('../storage');
const { requireAdmin } = require('../middleware');

const router = express.Router();
const BODY_MAX = 500;
const NAME_MAX = 30;
const COOLDOWN_MS = 1200;

// Ephemeral "who's typing" — key -> { name, until }. In memory, no DB writes.
const TYPING_WINDOW = 6000;
const roomTyping = new Map();
function keyFor(req) {
  return req.user ? 'u' + req.user.id : 'g' + (req.gid || 'anon');
}
function setTyping(req, name) {
  roomTyping.set(keyFor(req), { name, until: Date.now() + TYPING_WINDOW });
}
function clearTyping(req) {
  roomTyping.delete(keyFor(req));
}
// Names currently typing, minus the person asking (you never see yourself).
function typingNames(exceptKey) {
  const now = Date.now();
  const seen = new Set();
  const names = [];
  for (const [k, v] of roomTyping) {
    if (v.until <= now) { roomTyping.delete(k); continue; } // expired — sweep it
    if (k === exceptKey || seen.has(v.name)) continue;
    seen.add(v.name);
    names.push(v.name);
  }
  return names;
}

// Live guest presence (anonymous visitors, keyed by their gid cookie). In
// memory, refreshed as they poll the room; counts those seen very recently.
const GUEST_WINDOW = 45000;
const guestSeen = new Map();
function markGuest(req) {
  if (!req.user && req.gid) guestSeen.set(req.gid, Date.now());
}
function guestCount(exceptGid) {
  const now = Date.now();
  let n = 0;
  for (const [gid, t] of guestSeen) {
    if (now - t > GUEST_WINDOW) { guestSeen.delete(gid); continue; } // sweep stale
    if (gid !== exceptGid) n++;
  }
  return n;
}

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
    // set => a signed-up creator you can DM + tip. Buyers post in the room but
    // aren't creators, so they get no "Chat Privately" CTA.
    creatorId: m.creator_is_buyer ? null : m.user_id || null,
    creatorHandle: m.creator_handle || m.user_id, // pretty URL slug
    avatar: m.creator_is_buyer ? null : m.creator_avatar || null,
    gender: m.creator_gender || null,
    verified: !!m.creator_verified,
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
  const rows = await db.all(
    `SELECT gm.*, u.verified AS creator_verified, u.handle AS creator_handle, u.avatar_url AS creator_avatar, u.gender AS creator_gender, u.is_buyer AS creator_is_buyer
       FROM room_messages gm LEFT JOIN users u ON u.id = gm.user_id
      ORDER BY gm.id DESC LIMIT 100`
  );
  rows.reverse();
  markGuest(req);
  // "Here now" = creators actually active in the last 5 minutes. Their online_at
  // refreshes (~every minute) while they have the site open; it stops when they
  // log out or close the tab, so they drop off the list.
  const creators = await db.all(
    "SELECT id, name, handle, verified, avatar_url, gender FROM users WHERE is_buyer = 0 AND online_at >= datetime('now', '-5 minutes') ORDER BY online_at DESC LIMIT 20"
  );
  res.render('room', {
    title: 'Room',
    messages: serialize(rows, req),
    creators,
    guests: guestCount(req.gid),
    suggestedName: req.user ? req.user.name : nickFor(req),
    isGuest: !req.user,
  });
});

// Live feed of messages after a given id
router.get('/feed', async (req, res) => {
  const after = Number(req.query.after) || 0;
  const rows = await db.all(
    `SELECT gm.*, u.verified AS creator_verified, u.handle AS creator_handle, u.avatar_url AS creator_avatar, u.gender AS creator_gender, u.is_buyer AS creator_is_buyer
       FROM room_messages gm LEFT JOIN users u ON u.id = gm.user_id
      WHERE gm.id > ? ORDER BY gm.id LIMIT 200`,
    after
  );
  markGuest(req);
  res.json({ messages: serialize(rows, req), typing: typingNames(keyFor(req)), guests: guestCount(req.gid) });
});

// Lightweight "I'm typing" ping (in memory, no DB write).
router.post('/typing', (req, res) => {
  setTyping(req, displayName(req, req.body.name));
  res.json({ ok: true });
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
  clearTyping(req); // they just sent — no longer typing

  const info = await db.run(
    'INSERT INTO room_messages (user_id, gid, name, body) VALUES (?, ?, ?, ?)',
    req.user ? req.user.id : null,
    req.user ? null : req.gid,
    name,
    body
  );
  if (json) {
    const m = await db.get('SELECT gm.*, u.verified AS creator_verified, u.handle AS creator_handle, u.avatar_url AS creator_avatar, u.gender AS creator_gender FROM room_messages gm LEFT JOIN users u ON u.id = gm.user_id WHERE gm.id = ?', Number(info.lastInsertRowid));
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
  clearTyping(req); // they just sent — no longer typing
  let url;
  try {
    url = await uploadImage(req.file.buffer, req.file.originalname);
  } catch (e) {
    console.error('room upload failed:', (e && (e.message || e.error)) || e);
    return res.status(500).json({ ok: false, error: 'Upload failed. Try again.' });
  }
  const info = await db.run(
    'INSERT INTO room_messages (user_id, gid, name, body, image_url) VALUES (?, ?, ?, ?, ?)',
    req.user ? req.user.id : null,
    req.user ? null : req.gid,
    name,
    '',
    url
  );
  const m = await db.get('SELECT gm.*, u.verified AS creator_verified, u.handle AS creator_handle, u.avatar_url AS creator_avatar, u.gender AS creator_gender FROM room_messages gm LEFT JOIN users u ON u.id = gm.user_id WHERE gm.id = ?', Number(info.lastInsertRowid));
  res.json({ ok: true, message: serialize([m], req)[0] });
});

// --- Admin moderation ------------------------------------------------------
// Delete one message (and its picture, if any).
router.post('/room/:id/delete', requireAdmin, async (req, res) => {
  const m = await db.get('SELECT image_url FROM room_messages WHERE id = ?', req.params.id);
  await db.run('DELETE FROM room_messages WHERE id = ?', req.params.id);
  if (m && m.image_url) deleteImage(m.image_url); // best-effort, don't block the response
  res.json({ ok: true });
});

// Clear the whole room (removes every message + its pictures).
router.post('/room/clear', requireAdmin, async (req, res) => {
  const imgs = await db.all('SELECT image_url FROM room_messages WHERE image_url IS NOT NULL');
  await db.run('DELETE FROM room_messages');
  imgs.forEach((r) => deleteImage(r.image_url));
  res.json({ ok: true });
});

module.exports = router;

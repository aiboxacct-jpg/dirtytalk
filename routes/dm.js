// Private 1-on-1 chats between a creator and a visitor (guest or creator).
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { tipLinks } = require('../tips');
const { uploadSingle, uploadImage } = require('../storage');

const router = express.Router();
const MAX = 2000;

// Ephemeral "is typing" state (in memory — not worth persisting to the DB).
// threadId -> { creator: epochMs, guest: epochMs } — a party is "typing" until
// that time. Refreshed by typing pings; cleared when they send a message.
const TYPING_WINDOW = 6000;
const typingState = new Map();
function setTyping(threadId, role) {
  let s = typingState.get(threadId);
  if (!s) { s = { creator: 0, guest: 0 }; typingState.set(threadId, s); }
  s[role] = Date.now() + TYPING_WINDOW;
}
function clearTyping(threadId, role) {
  const s = typingState.get(threadId);
  if (s) s[role] = 0;
}
function isTyping(threadId, role) {
  const s = typingState.get(threadId);
  return !!(s && s[role] > Date.now());
}

// --- Helpers (also used by the profile page) -------------------------------
async function findThread(creatorId, req) {
  if (req.user) {
    return db.get('SELECT * FROM threads WHERE creator_id = ? AND guest_user_id = ?', creatorId, req.user.id);
  }
  return db.get('SELECT * FROM threads WHERE creator_id = ? AND guest_id = ?', creatorId, req.gid);
}

async function findOrCreateThread(creatorId, req, guestName) {
  const existing = await findThread(creatorId, req);
  if (existing) return existing;
  const token = crypto.randomBytes(16).toString('hex');
  const name = (guestName && guestName.trim().slice(0, 30)) || (req.user ? req.user.name : 'Guest');
  const info = await db.run(
    `INSERT INTO threads (creator_id, guest_id, guest_user_id, guest_name, token, last_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    creatorId,
    req.user ? null : req.gid,
    req.user ? req.user.id : null,
    name,
    token
  );
  return db.get('SELECT * FROM threads WHERE id = ?', Number(info.lastInsertRowid));
}

function threadMessages(threadId) {
  return db.all('SELECT * FROM dm_messages WHERE thread_id = ? ORDER BY id', threadId);
}

async function addMessage(threadId, sender, body) {
  await db.run('INSERT INTO dm_messages (thread_id, sender, body) VALUES (?, ?, ?)', threadId, sender, body);
  await db.run("UPDATE threads SET last_at = datetime('now') WHERE id = ?", threadId);
}

// Who is the viewer, relative to this thread?
function access(thread, req) {
  const tokenOk = !!(req.query && req.query.t && thread.token && req.query.t === thread.token);
  const isCreator = !!req.user && req.user.id === thread.creator_id;
  const isGuest =
    (!!req.user && req.user.id === thread.guest_user_id) ||
    (!req.user && !!thread.guest_id && thread.guest_id === req.gid) ||
    tokenOk;
  return { isCreator, isGuest, ok: isCreator || isGuest };
}

// The creator/guest display info a thread needs to render room-style messages.
function dmContext(thread, acc) {
  return {
    isCreator: acc.isCreator,
    creatorName: thread.creator_name,
    creatorAvatar: thread.creator_avatar || null,
    creatorGender: thread.creator_gender || null,
    creatorVerified: !!thread.creator_verified,
    creatorHandle: thread.creator_handle || thread.creator_id,
    guestName: thread.guest_name || 'Guest',
  };
}

// Shape messages for the client, room-style: each carries the sender's avatar,
// name, gender and verified badge. `mine` is relative to who's viewing.
function serializeDm(rows, ctx) {
  return rows.map((m) => {
    const fromCreator = m.sender === 'creator';
    const mine = m.sender === (ctx.isCreator ? 'creator' : 'guest');
    return {
      id: m.id,
      body: m.body,
      image: m.image_url || null,
      created_at: m.created_at,
      mine,
      fromCreator,
      name: mine ? 'You' : fromCreator ? ctx.creatorName : ctx.guestName,
      avatar: fromCreator ? ctx.creatorAvatar : null,
      gender: fromCreator ? ctx.creatorGender : null,
      verified: fromCreator ? ctx.creatorVerified : false,
      handle: fromCreator ? ctx.creatorHandle : null,
    };
  });
}

function wantsJson(req) {
  return (req.get('accept') || '').includes('application/json');
}

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

// Load a thread joined with the creator's info + paywall settings.
function threadWithCreator(id) {
  return db.get(
    `SELECT t.*, c.name AS creator_name, c.avatar_url AS creator_avatar, c.bio AS creator_bio,
            c.gender AS creator_gender, c.verified AS creator_verified, c.handle AS creator_handle,
            c.cashapp, c.venmo, c.paypal, c.revolut, c.crypto, c.paywall_enabled, c.free_seconds
       FROM threads t JOIN users c ON c.id = t.creator_id WHERE t.id = ?`,
    id
  );
}

// Paywall status for a thread. Starts the guest's free clock on first contact.
// The creator is never locked; only the guest gets paused when time runs out.
async function paywallState(thread, acc) {
  // Per-chat override wins; otherwise fall back to the creator's account default.
  const on = thread.paywall_on != null ? !!thread.paywall_on : !!thread.paywall_enabled;
  const freeSeconds = Number(thread.free_seconds) || 120;
  if (!on) return { on: false, freeSeconds, freeUntil: null, now: Date.now(), locked: false };
  let freeUntil = thread.free_until ? Number(thread.free_until) : null;
  if (!freeUntil && !acc.isCreator) {
    freeUntil = Date.now() + freeSeconds * 1000;
    await db.run('UPDATE threads SET free_until = ? WHERE id = ?', freeUntil, thread.id);
    thread.free_until = freeUntil;
  }
  const now = Date.now();
  const locked = !acc.isCreator && !!freeUntil && now >= freeUntil;
  return { on: true, freeSeconds, freeUntil, now, locked };
}

// --- Start a private chat from a profile or the room -----------------------
router.post('/start', async (req, res) => {
  const creatorId = Number(req.body.creator_id);
  const body = String(req.body.body || '').trim();
  const name = String(req.body.name || '').trim();
  const creator = await db.get('SELECT id FROM users WHERE id = ?', creatorId);
  if (!creator) return res.status(404).render('error', { title: 'Not found', message: 'That person does not exist.' });
  if (req.user && req.user.id === creatorId) {
    flash(req, 'error', "That's you — open your Messages to reply to people.");
    return res.redirect('/dm');
  }
  const thread = await findOrCreateThread(creatorId, req, name);
  if (body) await addMessage(thread.id, 'guest', body.slice(0, MAX));
  // Guests get a bookmarkable tokened link so they can return to the chat.
  const suffix = req.user ? '' : '?t=' + thread.token;
  res.redirect('/dm/' + thread.id + suffix);
});

// --- Inbox — all of the viewer's private chats -----------------------------
router.get('/', async (req, res) => {
  let threads;
  if (req.user) {
    threads = await db.all(
      `SELECT t.*, c.name AS creator_name
         FROM threads t JOIN users c ON c.id = t.creator_id
        WHERE t.creator_id = ? OR t.guest_user_id = ?
        ORDER BY COALESCE(t.last_at, t.created_at) DESC`,
      req.user.id,
      req.user.id
    );
  } else {
    threads = await db.all(
      `SELECT t.*, c.name AS creator_name
         FROM threads t JOIN users c ON c.id = t.creator_id
        WHERE t.guest_id = ?
        ORDER BY COALESCE(t.last_at, t.created_at) DESC`,
      req.gid
    );
  }
  for (const t of threads) {
    const last = await db.get('SELECT body FROM dm_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1', t.id);
    t.last_body = last ? last.body : '';
    t.iamCreator = !!req.user && req.user.id === t.creator_id;
    t.other = t.iamCreator ? t.guest_name || 'Guest' : t.creator_name;
    t.link = '/dm/' + t.id + (t.iamCreator || req.user ? '' : '?t=' + t.token);
  }
  res.render('inbox', { title: 'Messages', threads });
});

// --- Notification activity: the viewer's threads + their latest message -----
// Powers the unread badge and the slide-in "new message" toasts sitewide.
// NOTE: must be declared before '/:id' so it isn't swallowed as a thread id.
router.get('/activity', async (req, res) => {
  const sql = (whereCol) => `
    SELECT t.id, t.guest_name, t.token, t.creator_id, c.name AS creator_name,
           m.id AS last_id, m.sender AS last_sender, m.body AS last_body, m.image_url AS last_image
      FROM threads t
      JOIN users c ON c.id = t.creator_id
      JOIN dm_messages m ON m.id = (SELECT MAX(id) FROM dm_messages WHERE thread_id = t.id)
     WHERE ${whereCol}
     ORDER BY m.id DESC LIMIT 30`;
  let rows;
  if (req.user) {
    rows = await db.all(sql('t.creator_id = ? OR t.guest_user_id = ?'), req.user.id, req.user.id);
  } else {
    rows = await db.all(sql('t.guest_id = ?'), req.gid);
  }
  const threads = rows.map((t) => {
    const iamCreator = !!req.user && req.user.id === t.creator_id;
    const ownRole = iamCreator ? 'creator' : 'guest';
    return {
      id: t.id,
      latestId: t.last_id,
      incoming: t.last_sender !== ownRole, // a message from the OTHER person
      from: iamCreator ? t.guest_name || 'Guest' : t.creator_name,
      preview: t.last_body ? String(t.last_body).slice(0, 60) : t.last_image ? '📷 Photo' : '',
      link: '/dm/' + t.id + (iamCreator || req.user ? '' : '?t=' + t.token),
    };
  });
  res.json({ threads });
});

// --- A single thread --------------------------------------------------------
router.get('/:id', async (req, res) => {
  const thread = await threadWithCreator(req.params.id);
  if (!thread) return res.status(404).render('error', { title: 'Not found', message: 'Chat not found.' });
  const acc = access(thread, req);
  if (!acc.ok) {
    if (!req.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(403).render('error', { title: 'Not allowed', message: 'You cannot view this chat.' });
  }
  const messages = await threadMessages(thread.id);
  const paywall = await paywallState(thread, acc);
  res.render('dm', {
    title: acc.isCreator ? 'Chat with ' + (thread.guest_name || 'Guest') : 'Chat with ' + thread.creator_name,
    thread,
    messages: serializeDm(messages, dmContext(thread, acc)),
    isCreator: acc.isCreator,
    otherName: acc.isCreator ? thread.guest_name || 'Guest' : thread.creator_name,
    // The other party's profile bits — only the creator has these, so they show
    // on the guest's side (avatar in the header + beside each of her messages).
    otherAvatar: acc.isCreator ? null : thread.creator_avatar || null,
    otherBio: acc.isCreator ? null : thread.creator_bio || null,
    otherGender: acc.isCreator ? null : thread.creator_gender || null,
    otherVerified: acc.isCreator ? false : !!thread.creator_verified,
    otherHandle: acc.isCreator ? null : thread.creator_handle || thread.creator_id,
    // The visitor can tip the creator from inside the private chat.
    tips: acc.isCreator ? [] : tipLinks(thread),
    paywall,
    tokenSuffix: req.query.t ? '?t=' + encodeURIComponent(req.query.t) : '',
  });
});

// --- Live feed: messages after a given id (for polling) --------------------
router.get('/:id/feed', async (req, res) => {
  const thread = await threadWithCreator(req.params.id);
  if (!thread) return res.status(404).json({ ok: false });
  const acc = access(thread, req);
  if (!acc.ok) return res.status(403).json({ ok: false });
  const after = Number(req.query.after) || 0;
  const rows = await db.all(
    'SELECT * FROM dm_messages WHERE thread_id = ? AND id > ? ORDER BY id LIMIT 200',
    thread.id,
    after
  );
  const paywall = await paywallState(thread, acc);
  const typing = isTyping(thread.id, acc.isCreator ? 'guest' : 'creator'); // is the OTHER person typing?
  res.json({ messages: serializeDm(rows, dmContext(thread, acc)), paywall, typing });
});

// A lightweight "I'm typing" ping (kept in memory, no DB write).
router.post('/:id/typing', async (req, res) => {
  const thread = await db.get('SELECT * FROM threads WHERE id = ?', req.params.id);
  if (!thread) return res.status(404).json({ ok: false });
  const acc = access(thread, req);
  if (!acc.ok) return res.status(403).json({ ok: false });
  setTyping(thread.id, acc.isCreator ? 'creator' : 'guest');
  res.json({ ok: true });
});

// --- Reply within a thread --------------------------------------------------
router.post('/:id/reply', async (req, res) => {
  const thread = await threadWithCreator(req.params.id);
  if (!thread) return res.status(404).render('error', { title: 'Not found', message: 'Chat not found.' });
  const acc = access(thread, req);
  if (!acc.ok) {
    if (!req.user) {
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    return res.status(403).render('error', { title: 'Not allowed', message: 'You cannot reply here.' });
  }
  // Paywall: once free time is up, the guest can't send until the host adds time.
  const paywall = await paywallState(thread, acc);
  if (paywall.locked) {
    if (wantsJson(req)) return res.status(402).json({ ok: false, locked: true });
    return res.redirect('/dm/' + thread.id + (req.query.t ? '?t=' + encodeURIComponent(req.query.t) : ''));
  }
  const body = String(req.body.body || '').trim();
  if (body) {
    await addMessage(thread.id, acc.isCreator ? 'creator' : 'guest', body.slice(0, MAX));
    clearTyping(thread.id, acc.isCreator ? 'creator' : 'guest');
  }
  // Ajax callers just get an OK and then poll /feed for the new message(s);
  // no-JS callers fall back to a normal redirect (page reload).
  if (wantsJson(req)) return res.json({ ok: !!body });
  res.redirect('/dm/' + thread.id + (req.query.t ? '?t=' + encodeURIComponent(req.query.t) : ''));
});

// --- Send a picture in a thread (ajax) -------------------------------------
router.post('/:id/upload', uploadSingle('image'), async (req, res) => {
  const thread = await threadWithCreator(req.params.id);
  if (!thread) return res.status(404).json({ ok: false, error: 'Chat not found.' });
  const acc = access(thread, req);
  if (!acc.ok) return res.status(403).json({ ok: false, error: 'Not allowed.' });
  const paywall = await paywallState(thread, acc);
  if (paywall.locked) return res.status(402).json({ ok: false, locked: true });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No image selected.' });
  let url;
  try {
    url = await uploadImage(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Upload failed. Try again.' });
  }
  await db.run(
    'INSERT INTO dm_messages (thread_id, sender, body, image_url) VALUES (?, ?, ?, ?)',
    thread.id,
    acc.isCreator ? 'creator' : 'guest',
    '',
    url
  );
  await db.run("UPDATE threads SET last_at = datetime('now') WHERE id = ?", thread.id);
  clearTyping(thread.id, acc.isCreator ? 'creator' : 'guest');
  res.json({ ok: true });
});

// --- Host controls the paywall live, from inside the chat ------------------
// action: start (turn on + fresh free window) | add (more time) | lock (cut
// the free time off now) | stop (turn the paywall off for this chat)
router.post('/:id/host', async (req, res) => {
  const thread = await threadWithCreator(req.params.id);
  if (!thread) return res.status(404).json({ ok: false });
  const acc = access(thread, req);
  if (!acc.isCreator) return res.status(403).json({ ok: false, error: 'Only the host can do that.' });
  const freeSeconds = Number(thread.free_seconds) || 120;
  const now = Date.now();
  const action = String(req.body.action || '');
  if (action === 'start') {
    await db.run('UPDATE threads SET paywall_on = 1, free_until = ? WHERE id = ?', now + freeSeconds * 1000, thread.id);
  } else if (action === 'add') {
    // Host can add a custom number of minutes (defaults to their free window).
    let minutes = parseInt(req.body.minutes, 10);
    if (!Number.isFinite(minutes)) minutes = Math.round(freeSeconds / 60);
    minutes = Math.max(1, Math.min(240, minutes));
    await db.run('UPDATE threads SET paywall_on = 1, free_until = ? WHERE id = ?', now + minutes * 60000, thread.id);
  } else if (action === 'lock') {
    await db.run('UPDATE threads SET paywall_on = 1, free_until = ? WHERE id = ?', now, thread.id);
  } else if (action === 'stop') {
    await db.run('UPDATE threads SET paywall_on = 0 WHERE id = ?', thread.id);
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  }
  const fresh = await threadWithCreator(thread.id);
  const paywall = await paywallState(fresh, acc);
  res.json({ ok: true, paywall });
});

// --- Creator logs a payment they received (adds the $1 site fee to their tab) -
// Tips happen off-site, so the creator taps this each time one lands. We can't
// see the amount, so it's a flat $1 per confirmed payment, owed to the platform.
const SITE_FEE_CENTS = 100;
router.post('/:id/payment', async (req, res) => {
  const thread = await threadWithCreator(req.params.id);
  if (!thread) return res.status(404).json({ ok: false });
  const acc = access(thread, req);
  if (!acc.isCreator) return res.status(403).json({ ok: false, error: 'Only the host can do that.' });
  await db.run(
    'UPDATE users SET bill_cents = bill_cents + ?, sales_count = sales_count + 1 WHERE id = ?',
    SITE_FEE_CENTS,
    req.user.id
  );
  const u = await db.get('SELECT bill_cents, sales_count FROM users WHERE id = ?', req.user.id);
  res.json({
    ok: true,
    billCents: u.bill_cents,
    bill: '$' + (u.bill_cents / 100).toFixed(2),
    sales: u.sales_count,
  });
});

module.exports = router;
router.findThread = findThread;
router.threadMessages = threadMessages;
module.exports.findThread = findThread;
module.exports.threadMessages = threadMessages;

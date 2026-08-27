// Admin dashboard: see users (with emails), grant/remove the verified badge,
// and add or delete users. Gated to the ADMIN_EMAIL account.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { getFeeCents, setFeeCents } = require('../siteconfig');
const guestblock = require('../guestblock');

const router = express.Router();

router.use((req, res, next) => {
  if (req.isAdmin) return next();
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  return res.status(403).render('error', { title: 'Not allowed', message: 'Admins only.' });
});

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

function listUsers() {
  return db.all('SELECT id, email, name, verified, is_buyer, bill_cents, sales_count, due_date, online_at, created_at FROM users ORDER BY created_at DESC');
}

// Aggregate the whole site's billing picture for the dashboard cards.
function summarize(users) {
  const today = new Date().toISOString().slice(0, 10);
  const creators = users.filter((u) => !u.is_buyer);
  return {
    creators: creators.length,
    buyers: users.length - creators.length,
    totalSales: users.reduce((s, u) => s + (u.sales_count || 0), 0),
    totalOwedCents: users.reduce((s, u) => s + (u.bill_cents || 0), 0),
    lockedNow: users.filter((u) => u.due_date && today >= u.due_date).length,
    dueScheduled: users.filter((u) => u.due_date && today < u.due_date).length,
  };
}

async function renderDashboard(req, res, error) {
  const users = await listUsers();
  res.render('admin', {
    title: 'Admin',
    users,
    stats: summarize(users),
    feeCents: await getFeeCents(),
    blockedGuests: guestblock.list(),
    adminId: req.user.id,
    error: error || null,
    wide: true,
  });
}

// Block a guest by their guest ID ("guest-ad88" or a full gid). Resolves the
// short "guest-XXXX" nick to matching gids from their room messages.
router.post('/block-guest', async (req, res) => {
  let input = String(req.body.guest || '').trim().toLowerCase().replace(/^guest-/, '');
  if (!/^[0-9a-f]{1,32}$/.test(input)) {
    flash(req, 'error', 'Enter a guest ID like "guest-ad88".');
    return res.redirect('/admin');
  }
  let gids = [];
  if (input.length === 32) {
    gids = [input];
  } else {
    const rows = await db.all("SELECT DISTINCT gid FROM room_messages WHERE gid LIKE ? AND gid IS NOT NULL", input + '%');
    gids = rows.map((r) => r.gid);
  }
  if (!gids.length) {
    flash(req, 'error', 'No guest found for that ID (they may not have posted).');
    return res.redirect('/admin');
  }
  for (const g of gids) await guestblock.block(g);
  flash(req, 'success', 'Blocked ' + gids.length + ' guest' + (gids.length === 1 ? '' : 's') + '.');
  res.redirect('/admin');
});

// Unblock a guest.
router.post('/unblock-guest', async (req, res) => {
  const gid = String(req.body.gid || '').trim();
  await guestblock.unblock(gid);
  flash(req, 'success', 'Guest unblocked.');
  res.redirect('/admin');
});

// Change the site-wide per-sale fee (entered in dollars).
router.post('/fee', async (req, res) => {
  const dollars = parseFloat(req.body.fee);
  if (!Number.isFinite(dollars) || dollars < 0) {
    flash(req, 'error', 'Enter a valid fee amount.');
    return res.redirect('/admin');
  }
  const cents = await setFeeCents(Math.round(dollars * 100));
  flash(req, 'success', 'Site fee set to $' + (cents / 100).toFixed(2) + ' per sale.');
  res.redirect('/admin');
});

// Dashboard
router.get('/', async (req, res) => {
  await renderDashboard(req, res, null);
});

// Grant / remove the verified badge
router.post('/verify', async (req, res) => {
  const id = Number(req.body.user_id);
  const on = req.body.on === '1' ? 1 : 0;
  await db.run('UPDATE users SET verified = ? WHERE id = ?', on, id);
  flash(req, 'success', on ? 'Verified badge added.' : 'Verified badge removed.');
  res.redirect('/admin');
});

// Add a user
router.post('/add', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 30);
  const password = String(req.body.password || '');
  const rerender = (error) => renderDashboard(req, res, error);

  if (!email || !name || !password) return rerender('Fill in name, email and password.');
  if (password.length < 6) return rerender('Password must be at least 6 characters.');
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) return rerender('That email is already registered.');
  const hash = bcrypt.hashSync(password, 10);
  await db.run('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', email, hash, name);
  flash(req, 'success', 'User created.');
  res.redirect('/admin');
});

// Start (or open) a private chat with a creator, so the admin can talk to them.
// The admin is the visitor side; paywall is turned off so it never blocks them.
router.post('/message', async (req, res) => {
  const creatorId = Number(req.body.user_id);
  if (creatorId === req.user.id) {
    flash(req, 'error', "That's your own account.");
    return res.redirect('/admin');
  }
  const creator = await db.get('SELECT id FROM users WHERE id = ?', creatorId);
  if (!creator) {
    flash(req, 'error', 'User not found.');
    return res.redirect('/admin');
  }
  let thread = await db.get(
    'SELECT * FROM threads WHERE creator_id = ? AND guest_user_id = ?',
    creatorId,
    req.user.id
  );
  if (!thread) {
    const token = crypto.randomBytes(16).toString('hex');
    const info = await db.run(
      `INSERT INTO threads (creator_id, guest_id, guest_user_id, guest_name, token, paywall_on, admin_dm, last_at)
       VALUES (?, NULL, ?, ?, ?, 0, 1, datetime('now'))`,
      creatorId,
      req.user.id,
      req.user.name,
      token
    );
    thread = { id: Number(info.lastInsertRowid) };
  } else {
    // Existing thread: make sure the admin isn't paywalled and it's flagged.
    await db.run('UPDATE threads SET paywall_on = 0, admin_dm = 1 WHERE id = ?', thread.id);
  }
  res.redirect('/dm/' + thread.id);
});

// Set (or clear) a creator's bill due date. On/after this day their account
// locks until it's cleared or moved to a future date. Empty value clears it.
router.post('/due', async (req, res) => {
  const id = Number(req.body.user_id);
  let due = String(req.body.due_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) due = null; // blank/invalid => no due date
  await db.run('UPDATE users SET due_date = ? WHERE id = ?', due, id);
  flash(req, 'success', due ? 'Due date set — account locks on ' + due + '.' : 'Due date cleared — account unlocked.');
  res.redirect('/admin');
});

// Clear a creator's bill (they paid) — zero the owed amount and sale count.
// all=1 resets everyone's bill to $0 at once.
router.post('/clear-bill', async (req, res) => {
  if (req.body.all === '1') {
    await db.run('UPDATE users SET bill_cents = 0, sales_count = 0');
    flash(req, 'success', 'All bills reset to $0.');
    return res.redirect('/admin');
  }
  const id = Number(req.body.user_id);
  await db.run('UPDATE users SET bill_cents = 0, sales_count = 0 WHERE id = ?', id);
  flash(req, 'success', 'Bill cleared to $0.');
  res.redirect('/admin');
});

// Delete a user (cascades their private chats)
router.post('/delete', async (req, res) => {
  const id = Number(req.body.user_id);
  if (id === req.user.id) {
    flash(req, 'error', "You can't delete your own admin account.");
    return res.redirect('/admin');
  }
  await db.run('DELETE FROM users WHERE id = ?', id);
  flash(req, 'success', 'User deleted.');
  res.redirect('/admin');
});

module.exports = router;

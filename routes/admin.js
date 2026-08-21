// Admin dashboard: see users (with emails), grant/remove the verified badge,
// and add or delete users. Gated to the ADMIN_EMAIL account.
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

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
  return db.all('SELECT id, email, name, verified, bill_cents, sales_count, created_at FROM users ORDER BY created_at DESC');
}

// Dashboard
router.get('/', async (req, res) => {
  res.render('admin', { title: 'Admin', users: await listUsers(), adminId: req.user.id, error: null, wide: true });
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
  const rerender = async (error) =>
    res.render('admin', { title: 'Admin', users: await listUsers(), adminId: req.user.id, error, wide: true });

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
      `INSERT INTO threads (creator_id, guest_id, guest_user_id, guest_name, token, paywall_on, last_at)
       VALUES (?, NULL, ?, ?, ?, 0, datetime('now'))`,
      creatorId,
      req.user.id,
      req.user.name,
      token
    );
    thread = { id: Number(info.lastInsertRowid) };
  } else if (thread.paywall_on !== 0) {
    // Existing thread: make sure the admin isn't paywalled.
    await db.run('UPDATE threads SET paywall_on = 0 WHERE id = ?', thread.id);
  }
  res.redirect('/dm/' + thread.id);
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

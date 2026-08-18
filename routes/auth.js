// Creator sign up / log in / account (name + tip handles). Tippers never sign up.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();

function flash(req, type, msg) {
  req.session.flash = { type, msg };
}

// --- Sign up ----------------------------------------------------------------
router.get('/signup', (req, res) => {
  res.render('signup', { title: 'Create account', error: null });
});

router.post('/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 30);
  const password = String(req.body.password || '');
  const rerender = (error) => res.render('signup', { title: 'Create account', error });

  if (!email || !name || !password) return rerender('Please fill in every field.');
  if (password.length < 6) return rerender('Password must be at least 6 characters.');

  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) return rerender('That email is already registered — try logging in.');

  const hash = bcrypt.hashSync(password, 10);
  const info = await db.run(
    'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
    email,
    hash,
    name
  );
  req.session.userId = Number(info.lastInsertRowid);
  flash(req, 'success', 'Welcome! Add your Cash App / Venmo so people can tip you.');
  res.redirect('/account');
});

// --- Log in -----------------------------------------------------------------
router.get('/login', (req, res) => {
  res.render('login', { title: 'Log in', error: null });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { title: 'Log in', error: 'Wrong email or password.' });
  }
  req.session.userId = user.id;
  const to = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(to);
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// --- Account (name, bio, tip handles) --------------------------------------
router.get('/account', requireLogin, (req, res) => {
  res.render('account', { title: 'My account', error: null });
});

router.post('/account', requireLogin, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  const bio = String(req.body.bio || '').trim().slice(0, 500);
  const cashapp = String(req.body.cashapp || '').trim().slice(0, 60);
  const venmo = String(req.body.venmo || '').trim().slice(0, 60);
  if (!name) {
    return res.render('account', { title: 'My account', error: 'Please keep a display name.' });
  }
  await db.run(
    'UPDATE users SET name = ?, bio = ?, cashapp = ?, venmo = ? WHERE id = ?',
    name,
    bio,
    cashapp,
    venmo,
    req.user.id
  );
  flash(req, 'success', 'Saved.');
  res.redirect('/account');
});

module.exports = router;

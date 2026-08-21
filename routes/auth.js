// Creator sign up / log in / account (name + tip handles). Tippers never sign up.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../middleware');
const { uploadSingle, uploadImage, deleteImage } = require('../storage');
const { uniqueHandle } = require('../slug');

const getFn = (sql, ...a) => db.get(sql, ...a);

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

  const isBuyer = req.body.is_buyer ? 1 : 0;
  const gender = !isBuyer && ['male', 'female'].includes(req.body.gender) ? req.body.gender : '';
  const hash = bcrypt.hashSync(password, 10);
  const info = await db.run(
    'INSERT INTO users (email, password_hash, name, gender, is_buyer) VALUES (?, ?, ?, ?, ?)',
    email,
    hash,
    name,
    gender,
    isBuyer
  );
  const newId = Number(info.lastInsertRowid);
  const handle = await uniqueHandle(getFn, name, newId);
  await db.run('UPDATE users SET handle = ? WHERE id = ?', handle, newId);
  req.session.userId = newId;
  if (isBuyer) {
    flash(req, 'success', "Welcome! You're all set — jump into the chat.");
    return res.redirect('/');
  }
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
  const paypal = String(req.body.paypal || '').trim().slice(0, 120);
  const crypto = String(req.body.crypto || '').trim().slice(0, 120);
  const gender = ['male', 'female'].includes(req.body.gender) ? req.body.gender : '';
  if (!name) {
    return res.render('account', { title: 'My account', error: 'Please keep a display name.' });
  }
  const paywall = req.body.paywall ? 1 : 0;
  let freeMin = parseInt(req.body.free_minutes, 10);
  if (!Number.isFinite(freeMin)) freeMin = 2;
  freeMin = Math.max(1, Math.min(120, freeMin));
  await db.run(
    'UPDATE users SET name = ?, bio = ?, gender = ?, cashapp = ?, venmo = ?, paypal = ?, crypto = ?, paywall_enabled = ?, free_seconds = ? WHERE id = ?',
    name,
    bio,
    gender,
    cashapp,
    venmo,
    paypal,
    crypto,
    paywall,
    freeMin * 60,
    req.user.id
  );
  // Keep the profile URL handle in sync with the display name.
  const handle = await uniqueHandle(getFn, name, req.user.id);
  await db.run('UPDATE users SET handle = ? WHERE id = ?', handle, req.user.id);
  flash(req, 'success', 'Saved.');
  res.redirect('/account');
});

// Upload / change the profile photo (ajax)
router.post('/account/avatar', requireLogin, uploadSingle('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No image selected.' });
  let url;
  try {
    url = await uploadImage(req.file.buffer, req.file.originalname);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Upload failed. Try again.' });
  }
  const old = req.user.avatar_url;
  await db.run('UPDATE users SET avatar_url = ? WHERE id = ?', url, req.user.id);
  if (old) deleteImage(old); // remove the previous photo
  res.json({ ok: true, url });
});

module.exports = router;

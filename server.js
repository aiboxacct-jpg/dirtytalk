// Dead-simple chat: a global room, private 1-on-1 chats, and direct tips.
require('express-async-errors');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const expressLayouts = require('express-ejs-layouts');

const db = require('./db');
const { loadUser, isLocked } = require('./middleware');
const guestblock = require('./guestblock');

// Platform Cash App handle creators send their site-fee bill to.
const SITE_CASHAPP = process.env.SITE_CASHAPP || 'karmaupvotes';

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // behind Render's proxy (https for links)

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // local dev image fallback
app.use(express.urlencoded({ extended: true }));

// Cookie-backed session: state lives in a signed cookie, so it survives
// redeploys/restarts (unlike an in-memory store, which wiped everyone's
// age-gate + login on every deploy).
app.use(
  cookieSession({
    name: 'dtsess',
    keys: [process.env.SESSION_SECRET || 'change-me-in-production'],
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  })
);

// Persistent "device id" cookie so a guest is recognized across visits.
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)gid=([^;]+)/);
  let gid = m ? decodeURIComponent(m[1]) : null;
  if (!gid) {
    gid = crypto.randomBytes(16).toString('hex');
    res.cookie('gid', gid, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true, sameSite: 'lax' });
  }
  req.gid = gid;
  next();
});

// Site name + flash for all views.
app.use((req, res, next) => {
  res.locals.siteName = process.env.SITE_NAME || 'DirtyTalk';
  res.locals.absUrl = (p) => `${req.protocol}://${req.get('host')}${p || ''}`;
  res.locals.flash = req.session.flash || null;
  delete (req.session || {}).flash;
  next();
});

app.use(loadUser);

// Cash App handle available to every view (pay-your-bill buttons).
app.use((req, res, next) => {
  res.locals.siteCashapp = SITE_CASHAPP;
  next();
});

// --- Blocked guests: barred from posting anything (room + private chats) -----
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.user || !guestblock.isBlocked(req.gid)) return next();
  const p = req.path;
  const isContentPost =
    p === '/room' || p === '/room/upload' ||
    (/^\/dm\//.test(p) && /\/(reply|upload|typing|paid-notify)$/.test(p));
  if (!isContentPost) return next();
  if ((req.get('accept') || '').includes('application/json')) {
    return res.status(403).json({ ok: false, error: 'You have been blocked.' });
  }
  return res.status(403).render('error', { title: 'Blocked', message: 'You have been blocked from posting.' });
});

// --- Account lock (site-fee bill past its admin-set due date) ---------------
// Guests and admins are never locked. A locked creator is walled off to the
// pay-to-reactivate page until an admin clears/moves their due date.
app.use((req, res, next) => {
  if (!req.user || req.isAdmin || !isLocked(req.user)) return next();
  const exempt =
    req.path === '/locked' || req.path === '/logout' || req.path === '/age' || req.path.startsWith('/public');
  if (exempt) return next();
  if ((req.get('accept') || '').includes('application/json')) {
    return res.status(423).json({ ok: false, locked: true });
  }
  return res.redirect('/locked');
});

app.get('/locked', (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (!isLocked(req.user)) return res.redirect('/'); // not locked — nothing to see
  res.render('locked', { title: 'Account locked', layout: false, user: req.user, cashapp: SITE_CASHAPP });
});

// --- Age gate (18+) ---------------------------------------------------------
app.use((req, res, next) => {
  const exempt =
    req.path === '/age' || req.path === '/login' || req.path === '/signup' || req.path.startsWith('/public');
  if (req.session.ageConfirmed || exempt) return next();
  return res.render('age', { title: 'Age verification', layout: false, next: req.originalUrl });
});

app.post('/age', (req, res) => {
  req.session.ageConfirmed = true;
  const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/';
  res.redirect(next);
});

// --- Routes -----------------------------------------------------------------
app.use('/', require('./routes/room'));
app.use('/', require('./routes/auth'));
app.use('/u', require('./routes/creators'));
app.use('/dm', require('./routes/dm'));
app.use('/admin', require('./routes/admin'));

// 404
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));

// Errors
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong. Please try again.' });
});

db.init()
  .then(() => guestblock.load())
  .then(() => app.listen(PORT, () => console.log(`\nChat running at  http://localhost:${PORT}\n`)))
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });

// Dead-simple chat: a global room, private 1-on-1 chats, and direct tips.
require('express-async-errors');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');

const db = require('./db');
const { loadUser } = require('./middleware');

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

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 },
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

// 404
app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));

// Errors
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong. Please try again.' });
});

db.init()
  .then(() => app.listen(PORT, () => console.log(`\nChat running at  http://localhost:${PORT}\n`)))
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });

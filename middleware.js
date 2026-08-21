const db = require('./db');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// Load the signed-in creator (if any) onto req.user and res.locals.user.
async function loadUser(req, res, next) {
  res.locals.user = null;
  req.isAdmin = false;
  res.locals.isAdmin = false;
  const id = req.session && req.session.userId;
  if (id) {
    const u = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (u) {
      req.user = u;
      res.locals.user = u;
      req.isAdmin = !!(ADMIN_EMAIL && String(u.email).toLowerCase() === ADMIN_EMAIL);
      res.locals.isAdmin = req.isAdmin;
      // Cheap "online now" heartbeat (throttled to once a minute).
      const last = u.online_at || '';
      if (!last || Date.now() - Date.parse(last + 'Z') > 60000) {
        db.run("UPDATE users SET online_at = datetime('now') WHERE id = ?", u.id).catch(() => {});
      }
    }
  }
  next();
}

// Today as YYYY-MM-DD (UTC) — matches the admin-set due_date format.
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
// A creator is locked once their admin-set due date has arrived/passed.
function isLocked(u) {
  return !!(u && u.due_date && todayStr() >= u.due_date);
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.isAdmin) return next();
  return res.status(403).json({ ok: false, error: 'Admins only.' });
}

module.exports = { loadUser, requireLogin, requireAdmin, isLocked };

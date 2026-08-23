// Database layer with two interchangeable backends (same async interface):
//   - LOCAL dev:  Node's built-in node:sqlite (no deps, a file on disk)
//   - PRODUCTION: Turso via @libsql/client (set DATABASE_URL) — same SQLite SQL
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');

const SCHEMA = `
-- Creators: the people who get tipped. They sign up. (Tippers stay guests.)
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  handle          TEXT,                         -- URL-safe slug of the display name
  gender          TEXT,                         -- 'male' | 'female' | '' (not set)
  cashapp         TEXT,
  venmo           TEXT,
  paypal          TEXT,
  crypto          TEXT,
  bio             TEXT,
  avatar_url      TEXT,
  online_at       TEXT,
  verified        INTEGER NOT NULL DEFAULT 0,   -- 1 = verified badge (admin-granted)
  paywall_enabled INTEGER NOT NULL DEFAULT 0,   -- 1 = ask for a tip to keep chatting
  free_seconds    INTEGER NOT NULL DEFAULT 120, -- free time per interval before the paywall
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The global room. Anyone (guest or creator) can post.
CREATE TABLE IF NOT EXISTS room_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- set = creator
  gid        TEXT,                    -- guest device id
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  image_url  TEXT,                    -- set when the message is a picture
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A private 1-on-1 chat between a creator and a visitor (guest or creator).
CREATE TABLE IF NOT EXISTS threads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_id      TEXT,                 -- device id when the visitor is a guest
  guest_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- set if visitor has an account
  guest_name    TEXT,
  token         TEXT NOT NULL,        -- private link so a guest can return
  free_until    INTEGER,              -- epoch ms the guest's free time runs until (paywall)
  paywall_on    INTEGER,              -- per-chat override: NULL = use account default, else 0/1
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_at       TEXT
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender     TEXT NOT NULL,           -- 'creator' | 'guest'
  body       TEXT NOT NULL,
  image_url  TEXT,                    -- set when the message is a picture
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_room_id       ON room_messages(id);
CREATE INDEX IF NOT EXISTS idx_threads_creator ON threads(creator_id);
CREATE INDEX IF NOT EXISTS idx_threads_guest   ON threads(guest_id);
CREATE INDEX IF NOT EXISTS idx_dm_thread       ON dm_messages(thread_id);
`;

let backend = null;
const usingTurso = !!process.env.DATABASE_URL;

// --- node:sqlite backend (local) -------------------------------------------
function nodeSqliteBackend() {
  const { DatabaseSync } = require('node:sqlite');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const sqlite = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  return {
    exec: async (sql) => sqlite.exec(sql),
    run: async (sql, ...args) => {
      const r = sqlite.prepare(sql).run(...args);
      return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
    },
    get: async (sql, ...args) => sqlite.prepare(sql).get(...args),
    all: async (sql, ...args) => sqlite.prepare(sql).all(...args),
  };
}

// --- Turso / libSQL backend (production) -----------------------------------
async function tursoBackend() {
  const { createClient } = await import('@libsql/client/web');
  const url = (process.env.DATABASE_URL || '').trim();
  const authToken = (process.env.DATABASE_AUTH_TOKEN || '').trim();
  if (/[^\x20-\x7E]/.test(authToken)) {
    throw new Error('DATABASE_AUTH_TOKEN contains invalid characters — re-copy the full token as plain text.');
  }
  const client = createClient({ url, authToken });
  return {
    exec: async (sql) => client.executeMultiple(sql),
    run: async (sql, ...args) => {
      const r = await client.execute({ sql, args });
      return { lastInsertRowid: r.lastInsertRowid, changes: r.rowsAffected };
    },
    get: async (sql, ...args) => (await client.execute({ sql, args })).rows[0],
    all: async (sql, ...args) => (await client.execute({ sql, args })).rows,
  };
}

// Idempotent column additions for databases created before a column existed.
async function migrate() {
  const stmts = [
    'ALTER TABLE room_messages ADD COLUMN image_url TEXT',
    'ALTER TABLE dm_messages ADD COLUMN image_url TEXT',
    'ALTER TABLE users ADD COLUMN paywall_enabled INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN free_seconds INTEGER NOT NULL DEFAULT 120',
    'ALTER TABLE threads ADD COLUMN free_until INTEGER',
    'ALTER TABLE threads ADD COLUMN paywall_on INTEGER',
    'ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN paypal TEXT',
    'ALTER TABLE users ADD COLUMN crypto TEXT',
    'ALTER TABLE users ADD COLUMN avatar_url TEXT',
    'ALTER TABLE users ADD COLUMN handle TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle)',
    'ALTER TABLE users ADD COLUMN gender TEXT',
    'ALTER TABLE users ADD COLUMN is_buyer INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN revolut TEXT',
    // Running site-fee tab: $1 per confirmed payment the creator logs. They owe
    // this to the platform and settle up off-site. bill_cents in whole cents.
    'ALTER TABLE users ADD COLUMN bill_cents INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN sales_count INTEGER NOT NULL DEFAULT 0',
    // Admin-set bill due date (YYYY-MM-DD). On/after this day the creator's
    // account is locked until they pay. Empty/null = no due date, never locked.
    'ALTER TABLE users ADD COLUMN due_date TEXT',
    // Marks a thread the admin started from the dashboard (labeled "admin DM").
    'ALTER TABLE threads ADD COLUMN admin_dm INTEGER NOT NULL DEFAULT 0',
    // Host's one-time offer: pay offer_cents (advertised) for offer_minutes of
    // private chat. Both > 0 = the offer is active.
    'ALTER TABLE users ADD COLUMN offer_cents INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN offer_minutes INTEGER NOT NULL DEFAULT 0',
    // A room message can be a reply to an earlier one (quotes it + notifies).
    'ALTER TABLE room_messages ADD COLUMN reply_to INTEGER',
  ];
  for (const sql of stmts) {
    try {
      await backend.exec(sql);
    } catch (_) {
      /* column already exists — ignore */
    }
  }
}

// Give every user without a handle a unique slug from their display name.
async function backfillHandles() {
  const { uniqueHandle } = require('./slug');
  const rows = await backend.all("SELECT id, name FROM users WHERE handle IS NULL OR handle = ''");
  for (const u of rows) {
    const h = await uniqueHandle((sql, ...a) => backend.get(sql, ...a), u.name, u.id);
    await backend.run('UPDATE users SET handle = ? WHERE id = ?', h, u.id);
  }
}

async function init() {
  backend = usingTurso ? await tursoBackend() : nodeSqliteBackend();
  await backend.exec(SCHEMA);
  await migrate();
  await backfillHandles();
  console.log('Database ready (' + (usingTurso ? 'Turso/libSQL' : 'local node:sqlite') + ').');
}

module.exports = {
  init,
  exec: (...a) => backend.exec(...a),
  run: (...a) => backend.run(...a),
  get: (...a) => backend.get(...a),
  all: (...a) => backend.all(...a),
};

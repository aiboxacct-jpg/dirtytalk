// Guest blocklist: which anonymous (gid) visitors are barred from posting.
// Kept in memory (a Set) for a fast per-request check, mirrored to the DB.
const db = require('./db');

const blocked = new Set();

async function load() {
  const rows = await db.all('SELECT gid FROM blocked_guests');
  rows.forEach((r) => blocked.add(r.gid));
}

function isBlocked(gid) {
  return !!gid && blocked.has(gid);
}

async function block(gid) {
  if (!gid) return;
  blocked.add(gid);
  await db.run('INSERT OR IGNORE INTO blocked_guests (gid) VALUES (?)', gid);
}

async function unblock(gid) {
  blocked.delete(gid);
  await db.run('DELETE FROM blocked_guests WHERE gid = ?', gid);
}

function list() {
  return [...blocked];
}

module.exports = { load, isBlocked, block, unblock, list };

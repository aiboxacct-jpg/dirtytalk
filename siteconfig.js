// Site-wide settings stored in the `settings` key/value table. Currently just
// the per-sale site fee (in cents), which the admin can change.
const db = require('./db');

const DEFAULT_FEE_CENTS = 15;

async function getFeeCents() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'site_fee_cents'");
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FEE_CENTS;
}

async function setFeeCents(cents) {
  const n = Math.max(0, Math.min(100000, Math.round(Number(cents) || 0)));
  await db.run(
    "INSERT INTO settings (key, value) VALUES ('site_fee_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(n)
  );
  return n;
}

// "$0.15" style label for a cents amount.
function money(cents) {
  return '$' + ((Number(cents) || 0) / 100).toFixed(2);
}

module.exports = { getFeeCents, setFeeCents, money, DEFAULT_FEE_CENTS };

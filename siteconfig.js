// Site-wide settings stored in the `settings` key/value table. The per-sale
// site fee is a percentage of the amount the creator received.
const db = require('./db');

const DEFAULT_FEE_PCT = 10;

async function getFeePct() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'site_fee_pct'");
  const n = row ? parseFloat(row.value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FEE_PCT;
}

async function setFeePct(pct) {
  const n = Math.max(0, Math.min(100, Math.round((Number(pct) || 0) * 100) / 100)); // 0–100%, 2 decimals
  await db.run(
    "INSERT INTO settings (key, value) VALUES ('site_fee_pct', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    String(n)
  );
  return n;
}

// "$0.15" style label for a cents amount.
function money(cents) {
  return '$' + ((Number(cents) || 0) / 100).toFixed(2);
}

module.exports = { getFeePct, setFeePct, money, DEFAULT_FEE_PCT };

// Turn a creator's saved handles into safe, tap-to-pay tip links.
function clean(s) {
  return String(s || '').trim();
}

// Returns [{ kind, label, display, href }].
function tipLinks(u) {
  if (!u) return [];
  const out = [];

  const ca = clean(u.cashapp);
  if (ca) {
    const tag = ca.replace(/^\$/, '').replace(/[^\w.-]/g, '');
    if (tag) out.push({ kind: 'cashapp', label: 'Cash App', display: '$' + tag, href: 'https://cash.app/$' + tag });
  }

  const vn = clean(u.venmo);
  if (vn) {
    const name = vn.replace(/^@/, '').replace(/[^\w.-]/g, '');
    if (name) out.push({ kind: 'venmo', label: 'Venmo', display: '@' + name, href: 'https://venmo.com/u/' + name });
  }

  return out;
}

module.exports = { tipLinks };

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

  const pp = clean(u.paypal);
  if (pp) {
    let href = null;
    if (/^https?:\/\//i.test(pp)) href = pp;
    else if (/paypal\.me\//i.test(pp)) href = 'https://' + pp.replace(/^\/+/, '');
    // A bare PayPal email isn't directly linkable — shown as text to copy.
    out.push({ kind: 'paypal', label: 'PayPal', display: pp, href });
  }

  const rv = clean(u.revolut);
  if (rv) {
    let href = null;
    let display = rv;
    if (/^https?:\/\//i.test(rv)) {
      href = rv;
    } else if (/revolut\.me\//i.test(rv)) {
      href = 'https://' + rv.replace(/^\/+/, '');
    } else {
      const tag = rv.replace(/^@/, '').replace(/[^\w.-]/g, '');
      if (tag) {
        href = 'https://revolut.me/' + tag;
        display = '@' + tag;
      }
    }
    out.push({ kind: 'revolut', label: 'Revolut', display, href });
  }

  const cr = clean(u.crypto);
  if (cr) {
    const short = cr.length > 18 ? cr.slice(0, 8) + '…' + cr.slice(-6) : cr;
    out.push({ kind: 'crypto', label: 'Crypto', display: short, copy: cr });
  }

  return out;
}

module.exports = { tipLinks };

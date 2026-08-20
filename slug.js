// Turn a display name into a URL-safe handle (e.g. "Lexxxie 💕" -> "lexxxie").
function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'user'
  );
}

// A handle unique among all OTHER users (re-saving the same name is stable).
async function uniqueHandle(getFn, name, selfId) {
  const base = slugify(name);
  let handle = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = await getFn('SELECT id FROM users WHERE handle = ?', handle);
    if (!row || row.id === selfId) return handle;
    n += 1;
    handle = base + '-' + n;
  }
}

module.exports = { slugify, uniqueHandle };

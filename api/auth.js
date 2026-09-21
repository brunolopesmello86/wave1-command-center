/* POST /api/auth?action=login | register | change-password
 * GET  /api/auth?action=me
 * admin: GET ?action=users · POST ?action=invite | update | remove          */
import { db, fail } from '../lib/db.js';
import { ALLOWED_DOMAINS, normEmail, domainAllowed, issueToken, hashPassword, verifyPassword,
  publicUser, requireUser, requireAdmin } from '../lib/auth.js';
import { randomBytes } from 'node:crypto';

const MIN_PW = 10;
// a small brake on password guessing; per warm instance, which is enough to
// make brute force impractical without a shared store
const fails = new Map();
function throttle(email) {
  const f = fails.get(email);
  if (f && f.n >= 8 && Date.now() - f.t < 15 * 60000) throw fail(429, 'too many attempts — try again in 15 minutes');
}
function noteFail(email) { const f = fails.get(email) || { n: 0 }; fails.set(email, { n: f.n + 1, t: Date.now() }); }

const inviteCode = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query.action || '');
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    const q = await db();

    if (action === 'domains') {
      const [{ n }] = await q`SELECT COUNT(*)::int AS n FROM users`;
      return res.json({ domains: ALLOWED_DOMAINS, fresh: n === 0 });
    }

    if (action === 'login' && req.method === 'POST') {
      const email = normEmail(body.email), password = String(body.password || '');
      throttle(email);
      const [u] = await q`SELECT * FROM users WHERE email = ${email}`;
      if (!u || u.status === 'invited' || !(await verifyPassword(password, u.salt, u.pass_hash))) {
        noteFail(email); throw fail(401, 'email or password not recognised');
      }
      if (u.status !== 'active') throw fail(403, 'this account is disabled');
      fails.delete(email);
      await q`UPDATE users SET last_login = now() WHERE email = ${email}`;
      return res.json({ token: issueToken(email), user: publicUser(u) });
    }

    if (action === 'register' && req.method === 'POST') {
      const email = normEmail(body.email), password = String(body.password || '');
      const name = String(body.name || '').trim().slice(0, 80), invite = String(body.invite || '').trim().toUpperCase();
      if (!domainAllowed(email)) throw fail(400, `use your ${ALLOWED_DOMAINS.map(d => '@' + d).join(' or ')} email`);
      if (password.length < MIN_PW) throw fail(400, `password must be at least ${MIN_PW} characters`);
      if (!name) throw fail(400, 'your name is needed');
      const [{ n }] = await q`SELECT COUNT(*)::int AS n FROM users`;
      const { salt, hash } = await hashPassword(password);
      let role = 'member';
      if (n === 0) {
        // first account on a fresh deployment: the administrator
        role = 'admin';
        await q`INSERT INTO users (email, name, pass_hash, salt, role, status, last_login)
                VALUES (${email}, ${name}, ${hash}, ${salt}, 'admin', 'active', now())`;
      } else {
        throttle(email);
        const [u] = await q`SELECT * FROM users WHERE email = ${email}`;
        if (!u || u.status !== 'invited' || !invite || u.invite !== invite) {
          noteFail(email); throw fail(401, 'no matching invitation — check the email and code');
        }
        await q`UPDATE users SET name = ${name}, pass_hash = ${hash}, salt = ${salt}, status = 'active',
                invite = NULL, last_login = now() WHERE email = ${email}`;
      }
      fails.delete(email);
      const [u] = await q`SELECT * FROM users WHERE email = ${email}`;
      return res.json({ token: issueToken(email), user: publicUser(u), role });
    }

    // everything below needs a signed-in user
    const me = await requireUser(req);

    if (action === 'me') return res.json({ user: publicUser(me) });

    if (action === 'change-password' && req.method === 'POST') {
      const cur = String(body.current || ''), next = String(body.next || '');
      if (!(await verifyPassword(cur, me.salt, me.pass_hash))) throw fail(401, 'current password is wrong');
      if (next.length < MIN_PW) throw fail(400, `password must be at least ${MIN_PW} characters`);
      const { salt, hash } = await hashPassword(next);
      await q`UPDATE users SET pass_hash = ${hash}, salt = ${salt} WHERE email = ${me.email}`;
      return res.json({ ok: true });
    }

    requireAdmin(me);

    if (action === 'users') {
      const rows = await q`SELECT * FROM users ORDER BY status, email`;
      return res.json({ users: rows.map(u => ({ ...publicUser(u), invite: u.status === 'invited' ? u.invite : undefined })) });
    }

    if (action === 'invite' && req.method === 'POST') {
      const email = normEmail(body.email);
      if (!domainAllowed(email)) throw fail(400, `only ${ALLOWED_DOMAINS.map(d => '@' + d).join(' and ')} addresses`);
      const [u] = await q`SELECT status FROM users WHERE email = ${email}`;
      if (u && u.status !== 'invited') throw fail(409, 'that person already has an account');
      const code = inviteCode();
      await q`INSERT INTO users (email, name, status, invite) VALUES (${email}, ${String(body.name || '').trim().slice(0, 80)}, 'invited', ${code})
              ON CONFLICT (email) DO UPDATE SET invite = EXCLUDED.invite, name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name)`;
      return res.json({ email, invite: code });
    }

    if (action === 'update' && req.method === 'POST') {
      const email = normEmail(body.email);
      if (email === me.email) throw fail(400, 'you cannot change your own account here');
      if (body.status && !['active', 'disabled'].includes(body.status)) throw fail(400, 'bad status');
      if (body.role && !['admin', 'member'].includes(body.role)) throw fail(400, 'bad role');
      if (body.status) await q`UPDATE users SET status = ${body.status} WHERE email = ${email} AND status <> 'invited'`;
      if (body.role) await q`UPDATE users SET role = ${body.role} WHERE email = ${email}`;
      return res.json({ ok: true });
    }

    if (action === 'remove' && req.method === 'POST') {
      const email = normEmail(body.email);
      if (email === me.email) throw fail(400, 'you cannot remove yourself');
      await q`DELETE FROM users WHERE email = ${email}`;
      return res.json({ ok: true });
    }

    throw fail(404, 'unknown action');
  } catch (e) {
    if (!e.status) console.error('auth', e);
    return res.status(e.status || 500).json({ error: e.message || 'server error' });
  }
}

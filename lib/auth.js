/* Per-user sign-in. Accounts are created by invitation (an admin adds the
 * email and hands over a one-time code) and restricted to the allowed
 * domains. Sessions are HMAC-signed tokens the page sends as a Bearer
 * header; every request re-checks the user is still active.             */
import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { db, fail } from './db.js';

const scryptAsync = promisify(scrypt);
export const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'nttdata.com,avangrid.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw fail(500, 'SESSION_SECRET is not set');
  return s;
}
export function normEmail(e) { return String(e || '').trim().toLowerCase(); }
export function domainAllowed(email) {
  const at = email.lastIndexOf('@');
  return at > 0 && ALLOWED_DOMAINS.includes(email.slice(at + 1));
}
const b64u = s => Buffer.from(s).toString('base64url');
const sign = body => createHmac('sha256', secret()).update(body).digest('base64url');

export function issueToken(email) {
  const body = b64u(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 }));
  return body + '.' + sign(body);
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return x > Date.now() ? e : null;
  } catch (_) { return null; }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return { salt, hash };
}
export async function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const got = await scryptAsync(password, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
export function publicUser(u) {
  return { email: u.email, name: u.name, role: u.role, status: u.status, lastLogin: u.last_login, createdAt: u.created_at };
}

/** the active user behind a request, or a 401 */
export async function requireUser(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const email = m && readToken(m[1]);
  if (!email) throw fail(401, 'sign in required');
  const q = await db();
  const [u] = await q`SELECT * FROM users WHERE email = ${email}`;
  if (!u) throw fail(401, 'account not found');
  if (u.status !== 'active') throw fail(403, 'this account is disabled');
  return u;
}
export function requireAdmin(u) { if (u.role !== 'admin') throw fail(403, 'admin only'); }

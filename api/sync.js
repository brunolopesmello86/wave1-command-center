/* Wave 1 Command Center — the only API endpoint.
 *
 *   GET  /api/sync?since=0     full state: every live record
 *   GET  /api/sync?since=N     every change (including deletes) after change number N
 *   POST /api/sync             { ops: [ {coll,id,data} | {coll,id,delete:true} ] }
 *
 * Every row carries `seq`, the change number; the client keeps the highest
 * it has seen and asks for what came after. Set APP_PASSWORD in Vercel to
 * require an `x-app-key` header on every call.
 */
import { neon } from '@neondatabase/serverless';
import { timingSafeEqual } from 'node:crypto';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sync_counter (k int PRIMARY KEY, n bigint NOT NULL)`,
  `INSERT INTO sync_counter (k, n) VALUES (1, 0) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS records (
     coll text NOT NULL, id text NOT NULL, data jsonb,
     deleted boolean NOT NULL DEFAULT false,
     seq bigint NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (coll, id))`,
  `CREATE INDEX IF NOT EXISTS records_seq_idx ON records (seq)`,
];

let sql = null, ready = null;
function db() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is not set'), { status: 500 });
    sql = neon(process.env.DATABASE_URL);
  }
  // idempotent, and memoised per warm instance
  if (!ready) ready = (async () => { for (const s of SCHEMA) await sql.query(s); })()
    .catch(e => { ready = null; throw e; });
  return ready.then(() => sql);
}

function authorised(req) {
  const want = process.env.APP_PASSWORD;
  if (!want) return true;
  const a = Buffer.from(String(req.headers['x-app-key'] || '')), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_OPS = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });

  try {
    const q = await db();

    if (req.method === 'GET') {
      const since = Math.max(0, parseInt(req.query.since, 10) || 0);
      const rows = since === 0
        ? await q`SELECT coll, id, data, deleted, seq::int AS seq FROM records WHERE deleted = false ORDER BY seq`
        : await q`SELECT coll, id, data, deleted, seq::int AS seq FROM records WHERE seq > ${since} ORDER BY seq`;
      return res.status(200).json({ rows });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (!ops.length) return res.status(400).json({ error: 'no ops' });
      if (ops.length > MAX_OPS) return res.status(413).json({ error: `max ${MAX_OPS} ops per request` });
      for (const o of ops) {
        if (!o || typeof o.coll !== 'string' || typeof o.id !== 'string' || !o.coll || !o.id)
          return res.status(400).json({ error: 'each op needs coll and id' });
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.coll) || o.id.length > 128)
          return res.status(400).json({ error: 'bad coll or id' });
      }
      // the counter update takes a row lock for the rest of the transaction,
      // so concurrent writers are numbered in the order they commit
      const stmts = [q`UPDATE sync_counter SET n = n + 1 WHERE k = 1`];
      for (const o of ops) stmts.push(o.delete
        ? q`UPDATE records SET deleted = true, data = NULL, updated_at = now(),
               seq = (SELECT n FROM sync_counter WHERE k = 1)
             WHERE coll = ${o.coll} AND id = ${o.id}`
        : q`INSERT INTO records (coll, id, data, seq)
             VALUES (${o.coll}, ${o.id}, ${JSON.stringify(o.data ?? {})}::jsonb, (SELECT n FROM sync_counter WHERE k = 1))
             ON CONFLICT (coll, id) DO UPDATE
             SET data = EXCLUDED.data, deleted = false, seq = EXCLUDED.seq, updated_at = now()`);
      await q.transaction(stmts);
      return res.status(200).json({ ok: true, count: ops.length });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('sync', e);
    return res.status(e.status || 500).json({ error: e.message || 'server error' });
  }
}

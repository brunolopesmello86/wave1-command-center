import { neon } from '@neondatabase/serverless';

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
  `CREATE TABLE IF NOT EXISTS users (
     email text PRIMARY KEY,
     name text NOT NULL DEFAULT '',
     pass_hash text, salt text,
     role text NOT NULL DEFAULT 'member',
     status text NOT NULL DEFAULT 'invited',
     invite text,
     created_at timestamptz NOT NULL DEFAULT now(),
     last_login timestamptz)`,
];

let sql = null, ready = null;
/** the Neon client, with the schema guaranteed to exist (idempotent, memoised per warm instance) */
export function db() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is not set'), { status: 500 });
    sql = neon(process.env.DATABASE_URL);
  }
  if (!ready) ready = (async () => { for (const s of SCHEMA) await sql.query(s); })()
    .catch(e => { ready = null; throw e; });
  return ready.then(() => sql);
}

export function fail(status, message) { return Object.assign(new Error(message), { status }); }

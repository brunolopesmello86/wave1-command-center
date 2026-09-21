-- One table holds every collection. `coll` is the collection name the app
-- uses (pilots, events, risks, ...; 'config' for the meta and
-- activityTemplate singletons) and `data` is the record as the app holds it.
--
-- `seq` is a global change number. Clients poll for rows with seq greater
-- than the last one they saw, so deletes are kept as tombstones
-- (deleted = true, data = null) rather than removed. The number comes from a
-- single locked counter row, not a sequence, so it is assigned in commit
-- order and a poll can never skip a write that was still committing.
CREATE TABLE IF NOT EXISTS sync_counter (
  k int PRIMARY KEY,
  n bigint NOT NULL
);
INSERT INTO sync_counter (k, n) VALUES (1, 0) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS records (
  coll       text        NOT NULL,
  id         text        NOT NULL,
  data       jsonb,
  deleted    boolean     NOT NULL DEFAULT false,
  seq        bigint      NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coll, id)
);

CREATE INDEX IF NOT EXISTS records_seq_idx ON records (seq);

# Wave 1 Command Center

OwnIT! Digital Products — Wave 1 project command center. A single-page app
(`public/index.html`) backed by one Vercel serverless function
(`api/sync.js`) and one Neon Postgres table. Everyone with the link sees the
same data; changes made by others appear within a few seconds.

## How it fits together

```
browser ── GET /api/sync?since=N  (every 4 s)  ──▶  api/sync.js ──▶ Neon: records
        ── POST /api/sync { ops }  (on edit)   ──▶
```

- `public/index.html` — the app. Its `Store` object is the only code that
  knows where data lives; the hosted copy runs in `api` mode.
- `api/sync.js` — full load, incremental changes, batched writes. Creates
  the schema on first use.
- `db/schema.sql` — the schema, for reference or `npm run db:init`.

## Environment variables (Vercel → Settings → Environment Variables)

| Name | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string (set automatically by the Vercel ↔ Neon integration) |
| `SESSION_SECRET` | yes | Random 32+ character string signing session tokens; rotating it signs everyone out |
| `ALLOWED_DOMAINS` | no | Comma-separated email domains that may hold an account (default `nttdata.com,emeal.nttdata.com,avangrid.com`) |

## Accounts

Invitation-only. The first account created on an empty database becomes the
administrator; from *Data & setup → People* an admin invites others by email,
hands over the one-time code, and can disable, promote or remove anyone.

## Local development

```
vercel env pull .env.local     # fetch DATABASE_URL from the linked project
vercel dev                     # http://localhost:3000
```

## Deploy

Pushing to `main` deploys to production through the Vercel GitHub
integration. `vercel --prod` from this folder does the same by hand.

## Data

Everything lives in one table, `records (coll, id, data jsonb, deleted, seq)`.
The JSON export in *Data & setup* is a complete point-in-time backup and can
be re-imported on any copy.

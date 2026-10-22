# Supabase Setup Walkthrough

This guide walks you through configuring a Supabase project for ZentrixPay local development — from project creation to running your first migration. By the end, you will have a working Postgres database for the ZentrixPay gateway.

---

## Prerequisites

- A free [Supabase](https://supabase.com) account
- The ZentrixPay repository cloned and dependencies installed (`pnpm install`)
- Node.js 20+ and pnpm available on your PATH

---

## 1. Create a Supabase Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and click **New project**.
2. Choose your organization (or create one).
3. Fill in the project details:
   - **Name**: e.g. `zentrixpay-dev`
   - **Database password**: choose a strong password — you'll need it for the connection string
   - **Region**: pick the region closest to you for lowest latency
4. Click **Create new project** and wait for provisioning (~30 seconds).

---

## 2. Collect Your Credentials

Once the project is ready, you need three values from the Supabase dashboard. Navigate to **Settings → API** (or **Project Settings → API**):

### Database URL (connection string)

Go to **Settings → Database → Connection string** and select **URI** mode. Copy the connection string. It looks like:

```
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

> [!IMPORTANT]
> Use the **Transaction (port 6543)** pooler URL, not the direct connection (port 5432). The transaction pooler is recommended for serverless and short-lived connections like ZentrixPay's Express server.

Replace `[password]` with the database password you chose during project creation.

### Supabase URL

From the **API** settings page, copy the **Project URL**. It looks like:

```
https://abcdefghijklmnop.supabase.co
```

### Service Role Key

From the same **API** settings page, expand **Project API keys** and copy the **`service_role`** key (not the `anon` key). It starts with `eyJ...`.

> [!CAUTION]
> **The service role key bypasses all Row Level Security (RLS) policies.** It has full read/write access to your entire database and storage. Follow these rules:
>
> - **Never commit it** to version control — it belongs only in `server/.env`
> - **Never expose it** in client-side code, browser bundles, or public logs
> - **Never share it** in Slack, Discord, or GitHub issues
> - **Rotate it** immediately if you suspect it has been leaked (Settings → API → Regenerate)
>
> The gateway itself talks to Postgres through `DATABASE_URL` (Drizzle ORM); the service role key is only read by the legacy vault storage code.

---

## 3. Configure Environment Variables

Copy the example env file and fill in your credentials:

```bash
cp server/.env.example server/.env
```

Open `server/.env` and set these three values:

```env
# Supabase
DATABASE_URL=postgresql://postgres.abcdefg:YOUR_PASSWORD@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://abcdefghijklmnop.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIs...
```

| Variable                 | Where to find it                          | Required |
|--------------------------|-------------------------------------------|:--------:|
| `DATABASE_URL`           | Settings → Database → Connection string   | ✅       |
| `SUPABASE_URL`           | Settings → API → Project URL              | ✅       |
| `SUPABASE_SERVICE_KEY`   | Settings → API → `service_role` key       | ✅       |

> [!NOTE]
> The gateway only uses Supabase as a Postgres database (`DATABASE_URL`). `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are leftovers from the old resource vault's file storage; `server/src/config.ts` still requires them, so fill them in (or keep the placeholders from `server/.env.example`). No Storage bucket is needed.

---

## 4. Run Drizzle Migrations

With your `DATABASE_URL` configured, generate and apply the database schema:

```bash
# From the repo root — generates migration SQL from the Drizzle schema
pnpm db:generate

# Applies pending migrations to your Supabase Postgres database
pnpm db:migrate
```

The gateway uses these tables:

| Table        | Purpose                                                  |
|--------------|----------------------------------------------------------|
| `publishers` | Registered providers, with API key hashes                |
| `apis`       | APIs sold through the gateway (price, upstream, payee)   |
| `api_calls`  | One row per proxied call, charged or not                 |

The schema also still contains the old vault tables (`resources`, `verifications`, `payments`); the gateway does not use them.

### Verify the tables

Open the **Table Editor** in your Supabase dashboard. You should see the tables listed. You can also use Drizzle Studio for a local view:

```bash
pnpm --filter @zentrixpay/server db:studio
```

This opens a browser-based UI at `https://local.drizzle.studio` showing your tables and data.

---

## 5. Verify Everything Works

Start the server and confirm it connects to Supabase successfully:

```bash
pnpm dev:server
```

You should see:

```
ZentrixPay server started { port: 4021, network: "stellar:testnet" }
```

Test the database connection by hitting the health endpoint:

```bash
curl http://localhost:4021/health
```

If Supabase is configured correctly, the server starts without errors. If `DATABASE_URL` is wrong or a required variable is missing, the server will fail fast with a clear validation error listing the problematic variable.

---

## Troubleshooting

### "Connection terminated unexpectedly" or timeout errors

- **Check the connection string port**: use `6543` (transaction pooler), not `5432` (direct).
- **Check the password**: special characters in the password may need URL-encoding (e.g., `@` → `%40`).
- **Check region**: if you're far from the Supabase region, consider a closer one for dev.

### Migrations fail with "relation already exists"

This happens if you ran migrations before and the schema already exists. Drizzle tracks applied migrations in a `__drizzle_migrations` table. If you need a clean slate:

1. Drop all tables in the Supabase SQL editor (or delete and recreate the project)
2. Re-run `pnpm db:migrate`

---

## Security Checklist

Before going beyond local development, verify:

- [ ] `server/.env` is listed in `.gitignore` (it is by default)
- [ ] The service role key is **not** in any committed file, CI log, or browser bundle
- [ ] Row Level Security (RLS) is enabled on all tables if you ever expose the `anon` key (not required for ZentrixPay's server-side architecture)

---

## Further Reading

- [Local Setup Guide](local-setup.md) — full end-to-end local setup
- [Server Environment Variables](server-env.md) — complete reference for all env vars
- [Supabase Docs: Database](https://supabase.com/docs/guides/database) — official Postgres guide
- [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview) — schema and migration reference

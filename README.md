# ROTICH POS

ROTICH POS is a JavaScript/TypeScript Progressive Web App served by a Cloudflare Worker. The Worker owns the REST API and connects to Neon PostgreSQL through Cloudflare Hyperdrive. The browser never receives database credentials. Payments are cash-only; API writes are never queued while offline.

## Current implementation

- First-run creation of one administrator, login/logout, 12-hour server-side sessions, PBKDF2 password hashes, login throttling, and role-checked routes.
- Admin dashboard, product create/edit/deactivation APIs, category lifecycle, stock adjustment/history API, cashier accounts and password resets, register history, expenses, audit history, and sales/profit/inventory/expense reports.
- Searchable/date-filtered sales, administrator-authorized audited sale voids with stock restoration, and gross-profit snapshots using cost recorded at sale time.
- Cashier register open/close, product lookup, cart checkout, server-calculated cash totals/change, atomic sale and stock updates, retry-safe idempotency keys, recent receipts, and printable receipts.
- Installable PWA shell with offline indication. Offline mode does not read or queue database operations.

This is an initial deployable increment, not a claim that every item in the original specification is finished. The product edit endpoint is not yet exposed in the UI; product image upload, expense editing, report date controls/exports, configurable business details and tax/discount policy, customer management, multi-business data isolation, and automated database integration tests remain follow-up work before a production launch.

## Requirements

- Node.js 20 or newer and npm.
- A Neon PostgreSQL database.
- A Cloudflare account with Workers and Hyperdrive enabled.

## Local setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Apply [`migrations/0001_initial.sql`](migrations/0001_initial.sql) to a new Neon database using the Neon SQL Editor or `psql`. The migration creates tables and indexes only; it inserts no demo data and no default account.

3. For local `wrangler dev`, set the direct Neon connection string in the current PowerShell session. Use a dedicated database role and keep the value out of source control:

   ```powershell
   $env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = "postgres://USER:PASSWORD@HOST/DB?sslmode=require"
   npm run dev
   ```

4. Open the local URL printed by Wrangler. The first visitor can create the initial administrator. Use a unique password with at least 12 characters. There is no default password and initial admin creation closes permanently after the first admin row is committed.

5. Check types and Worker bundling:

   ```powershell
   npm run typecheck
   npx wrangler deploy --dry-run
   ```

Local Hyperdrive development connects directly to the configured Neon URL; it does not exercise Hyperdrive's remote pooling. Do not point local development at production data while testing writes.

## Cloudflare and Neon deployment

1. In Neon, create a dedicated database role for Hyperdrive and copy the non-pooled PostgreSQL connection string for the intended branch and database. Do not use an owner role for the application.
2. Create a Hyperdrive configuration in Cloudflare Dashboard using that connection string, or use `wrangler hyperdrive create` as described in [Cloudflare's Neon guide](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/).
3. Replace the all-zero Hyperdrive ID in `wrangler.toml` with the generated configuration ID. The binding name must remain `HYPERDRIVE`.
4. Apply the migration to the production Neon database before exposing the Worker.
5. Deploy the Worker and its static PWA assets:

   ```powershell
   npm run typecheck
   npm run deploy
   ```

Cloudflare stores the database connection on the Hyperdrive configuration, not in frontend code or this repository. This Worker uses opaque random session tokens stored as hashes in PostgreSQL, so it does not require a JWT secret or a `DATABASE_URL` Worker secret. The session cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.

## Important operational notes

- Serve production only over HTTPS. The session cookie requires `Secure`.
- Do not use the initial-admin endpoint after handing the URL to the business owner; after setup it returns `409`.
- Restrict access to Cloudflare and Neon dashboards. Keep database credentials in Cloudflare Hyperdrive and local developer environment variables only.
- The dashboard currency currently displays KES. Business address/contact and tax/discount configuration are not yet configurable.
- Before production use, finish the listed follow-up workflows, add automated database integration tests, configure backups/monitoring, and perform a security review against the actual Cloudflare account and Neon role."# skr-pos1" 

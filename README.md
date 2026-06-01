# Definition Sync Shopify App

This Shopify embedded app syncs only custom data definitions from a source store into the installed target store.

It copies:

- Metafield definitions
- Metaobject definitions
- Missing metaobject fields on existing target definitions

It does not copy:

- Metafield values
- Metaobject entries
- Products
- Collections
- Pages
- Blogs
- Articles
- Customers
- Orders
- Files or images

## File placement

Main route files:

- `app/routes/app.definition-sync.tsx`
- `app/routes/app.definition-sync.source.tsx`
- `app/routes/app.definition-sync.scan.tsx`
- `app/routes/app.definition-sync.sync.tsx`
- `app/routes/app.definition-sync.logs.tsx`

Server helpers:

- `app/lib/definition-sync/source-admin.server.ts`
- `app/lib/definition-sync/target-admin.server.ts`
- `app/lib/definition-sync/metafield-definitions.server.ts`
- `app/lib/definition-sync/metaobject-definitions.server.ts`
- `app/lib/definition-sync/compare.server.ts`
- `app/lib/definition-sync/sync.server.ts`
- `app/lib/definition-sync/logger.server.ts`
- `app/lib/definition-sync/shop-domain.server.ts`
- `app/lib/definition-sync/types.server.ts`

Shared UI:

- `app/components/definition-sync.tsx`

Database:

- `prisma/schema.prisma`
- `prisma/migrations/20260526131500_add_definition_sync_tables/migration.sql`

## Prisma models

The app adds:

- `DefinitionSyncJob`
- `DefinitionSyncLog`

The current app runtime uses the sync job tables for counters and per-item logs.
The older `SourceStoreCredential` table can remain in the database as legacy data,
but source tokens are no longer read from or written to it.

## Environment variables

Required:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES`
- `DATABASE_URL` if you move off the default SQLite setup

## Shopify app scopes

Current app config in `shopify.app.toml` uses:

- `write_products`
- `write_content`
- `write_customers`
- `write_orders`
- `read_metaobject_definitions`
- `write_metaobject_definitions`

Why:

- Shopify requires owner-type resource scopes for metafield definition access.
- Product and variant metafield definitions use `write_products`.
- Page, blog, and article metafield definitions use `write_content`.
- Customer metafield definitions use `write_customers`.
- Order metafield definitions use `write_orders`.
- Metaobject definition read/write uses `read_metaobject_definitions` and `write_metaobject_definitions`.

Important:

- Some owner types still depend on scopes you may not currently request, such as markets, companies, or locations.
- The app handles this safely by scanning what is accessible and showing warnings for owner types it cannot read or write.
- If you want to support more owner types, add the matching Shopify scopes, redeploy, and reinstall or reauthorize the app.

## Source store token requirements

The source store does not install this app.

Instead:

1. In the source store admin, create a custom app.
2. Give that custom app only the scopes needed to read the definitions you want to copy.
3. Install the custom app in the source store.
4. Copy its Admin API access token into this app’s Source Credentials page.

Recommended source custom-app scopes:

- `read_metaobject_definitions`
- The owner-type scopes needed for source metafield definitions you want to read

Examples:

- Product or variant metafield definitions: `write_products` is commonly required by Shopify for definition management APIs
- Page, blog, article definitions: `write_content`
- Customer definitions: `write_customers`
- Order definitions: `write_orders`

Important:

- The token is used only server-side.
- The token is kept only in browser session storage and is submitted with scan, sync, and file migration requests.
- The token is never logged by the app code.

## Target store token usage

The target store installs the app with OAuth.

The app uses the authenticated Shopify admin client returned by:

- `authenticate.admin(request)`

That target session token is used only to:

- Read existing target metafield definitions
- Read existing target metaobject definitions
- Create missing target metafield definitions
- Create missing target metaobject definitions
- Add missing fields to existing target metaobject definitions

The app never writes metafield values or metaobject entries.

## GraphQL behavior

Source store:

- Calls `https://SOURCE_SHOP/admin/api/${apiVersion}/graphql.json`
- Sends `X-Shopify-Access-Token`
- Uses `sourceAdminGraphql(...)`

Target store:

- Uses the embedded app’s authenticated admin client
- Uses `targetAdminGraphql(...)`

Implemented behavior:

- Paginates metafield definitions per owner type
- Paginates metaobject definitions
- Compares by `ownerType + namespace + key` for metafields
- Compares by `type` for metaobjects
- Compares by `metaobject type + field key` for metaobject fields
- Skips conflicts
- Never overwrites conflicting definitions
- Never deletes anything
- Continues after per-item failures

## Install and run

Install dependencies:

```bash
npm install
```

Run Prisma generate:

```bash
npm exec prisma generate
```

Run the migration:

```bash
npm exec prisma migrate deploy
```

For local development with a new SQLite database you can also use:

```bash
npm exec prisma migrate dev
```

Start the app:

```bash
npm run dev
```

## How to test the full flow

1. Start the app with `npm run dev`.
2. Install the app on the target Shopify store.
3. Open `Definition Sync` inside the target store admin.
4. Go to `Source Credentials`.
5. Enter the source `.myshopify.com` domain.
6. Enter the source custom app Admin API token.
7. Save and validate the source connection.
8. Go to `Scan Preview`.
9. Confirm the summary, missing definitions, and conflicts.
10. Click `Sync Missing Definitions`.
11. Review `Logs` for created, exists, skipped, conflict, and failed items.

## Verification commands used during implementation

TypeScript:

```bash
npx tsc --noEmit
```

Build:

```bash
npm run build
```

Prisma client:

```bash
npm exec prisma generate
```

## Notes

- The app currently rescans when you open the scan page instead of storing a long-lived preview snapshot.
- Sync always recalculates the latest comparison before writing.
- Logs are persisted in Prisma and can be viewed after the sync completes.
- If Shopify denies access for some metafield owner types, the app shows warnings and continues with the owner types it can safely process.

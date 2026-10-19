# DealLens

Deal price cross-checks and exact-ASIN live listing checks for Honey Touch on Amazon and Flipkart.
Next.js 16 on Vercel, sharing DispatchLens's Supabase project (all DealLens tables are prefixed `deallens_`).
Catalogue syncs read-only from the Honey Touch Master Database sheet.

- First-time setup: [SETUP.md](SETUP.md)
- Database: `supabase/migrations/001_deallens_shared.sql` (run in the DispatchLens project)
- Shared logic (browser and server): `lib/logic.ts`

## Local development

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev                  # http://localhost:3000 (add http://localhost:3000/auth/callback to Supabase Redirect URLs)
```

## Checks before shipping

```bash
npm run typecheck
FIXTURES=/path/to/sample/files npm test   # attachment.txt (catalogue TSV), GIF_Deal__1___1_.xlsx, Flipkart_Big_Billion_Days_Sale__2_.xlsx
npm run build
```

Sample business files are not committed. Keep them outside the repo.

## How access works

DealLens uses DispatchLens's people and devices. You need an approved row in `dispatch_user_access`, and your
device must be approved in `approved_devices`; the owner account skips the device check, as in DispatchLens.
The browser sends its device id in an `x-device-id` header on every database and API request. API routes check it
on the server, and the `deallens_*` row level security policies check it again in the database, so an approved
person on an unapproved device gets no data. Live updates come through `deallens_changes`, which holds only table
names and times.

The old single-page DealLens (`index.html`) stays in the repo root so GitHub Pages keeps working during
the switch-over. Turn GitHub Pages off once everyone is on the Vercel version.

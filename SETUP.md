# DealLens setup (one time, about 20 minutes)

DealLens is its own app at its own web address, but it shares DispatchLens's Supabase database and
Google sign-in. Nothing in DispatchLens changes and there's no new Supabase project, so no extra Supabase charge.

- **Who can use it:** anyone approved in DispatchLens (DispatchLens > Users).
- **Which devices:** only devices approved in DispatchLens's device list. A new device shows a code and a
  request labelled "DealLens · Mac Chrome" (or similar) appears in DispatchLens > Users, under devices. Approve it there.
  Your own account skips the device check, as in DispatchLens.

Screen and menu names on these sites change from time to time; if one doesn't match exactly, look for the nearest equivalent.

---

## 1. Supabase (the existing DispatchLens project)

1. Open the DispatchLens project (`hjjovblqvzpcpijtrmer`) > **SQL Editor > New query**.
2. Paste all of `supabase/migrations/001_deallens_shared.sql` and press **Run**. It only adds tables and functions
   whose names start with `deallens_`. It doesn't touch any DispatchLens table or rule.
3. **Authentication > URL Configuration > Redirect URLs**: add `https://<your-deallens-address>/auth/callback`
   (you'll know the address after step 4; come back and add it). Leave the Site URL as DispatchLens.

## 2. Google Cloud: the robot account that reads the sheet

Google sign-in is already set up for DispatchLens and DealLens reuses it. Only the sheet reader is new.
Use the same Google Cloud project that holds DispatchLens's sign-in.

1. **APIs & Services > Library**, search **Google Sheets API**, press **Enable**.
2. **IAM & Admin > Service accounts > Create service account**. Name `deallens-sync`. Skip the optional steps.
3. Open it > **Keys > Add key > Create new key > JSON**. From the downloaded file copy:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (all of it, including the BEGIN/END lines and the `\n`s)
4. Open the **Honey Touch Master Database** sheet > **Share**, paste the `client_email`, choose **Viewer**,
   untick "Notify people", **Share**. Viewer means DealLens can read the sheet but never change it.
5. Delete the downloaded JSON file once the key is in Vercel.

## 3. Scrapingdog: a new key

The current key is visible in ListingLens's public code. Create or regenerate a key → `SCRAPINGDOG_API_KEY`.
If you regenerate, update ListingLens's GitHub Action secret too.

Make up a long random password for the scheduled jobs → `CRON_SECRET` (for example `openssl rand -hex 24` in Terminal).

## 4. Vercel: a separate project for DealLens

1. Push the code (APPLY.txt has the commands).
2. vercel.com > **Add New > Project** > import `SharpFarrier/DealLens`. Framework: Next.js.
3. **Environment Variables**:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`: copy the exact values from
     DispatchLens's Vercel project (Settings > Environment Variables).
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` from step 2.
   - `SHEET_ID` = `11UPpzvWyFdMYOasRFevpS4-rP6e8a0pOWKdW1g5vTwU`, `SHEET_RANGE` = `Sheet1`
   - `SCRAPINGDOG_API_KEY`, `CRON_SECRET` from step 3.
4. **Deploy**. Note the address (for example `https://deallens.vercel.app`), then finish step 1.3.

The two daily jobs in `vercel.json` (sheet sync 8:00 am, Live status 9:00 am IST) are picked up automatically.
DealLens also syncs the sheet whenever someone opens it more than an hour after the last sync, and **Sync now** works any time.

## 5. First run

1. Open the DealLens address > **Sign in with Google** with adityaramnani91581@gmail.com.
2. Press **Sync now**. The header should show 160 products.
3. Optional, to carry over the old plan: in the old page (sharpfarrier.github.io/DealLens) go to Settings > Export plan,
   then in DealLens **Settings > Import plan file**.
4. Upload the Amazon and Flipkart deal files once. Everyone sees them from then on.
5. For each colleague: they open the DealLens address and sign in. If they aren't approved in DispatchLens yet, approve them
   in DispatchLens > Users. Then their device shows a code; approve that device in DispatchLens > Users.

## Something not working?

| What you see | What to check |
| --- | --- |
| "isn't approved in DispatchLens yet" | Approve that Google account in DispatchLens > Users. |
| Signed in but bounced back to the login page | Step 1.3: the DealLens callback address must be in Supabase's Redirect URLs. |
| "This device isn't approved yet" | Approve the "DealLens · …" device in DispatchLens > Users. |
| "Sheet sync failed: …isn't shared with…" | Step 2.4: share the sheet with the robot account's email. |
| "Sheet sync failed: Google sign-in for the sheet failed" | `GOOGLE_PRIVATE_KEY` was pasted incompletely. Paste it again, then redeploy. |
| "Missing environment variable …" | Add it in Vercel, then **Deployments > … > Redeploy**. |
| Live status rows all say "Couldn't check: HTTP 401/403" | `SCRAPINGDOG_API_KEY` is wrong or out of credits. |

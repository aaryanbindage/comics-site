# Comic At The Door

Static site + Supabase (auth, Postgres, private Storage). Deployed on Render.

## 1. Supabase
1. Create a project at supabase.com.
2. SQL Editor → paste and run `supabase.sql`.
3. Authentication → Sign In / Providers (or Settings) → turn OFF "Allow new users to sign up". Invite-only from now on.
4. Authentication → URL Configuration: set Site URL to your Render URL and add it under Redirect URLs (invite links land there).
5. **Invite people with `invite.ps1`, not the dashboard's "Invite user" button.** Without custom SMTP, Supabase's built-in email only reaches your own team's addresses, so dashboard invites never arrive for readers. `invite.ps1` makes the link and you send it yourself. Run `test-invite.ps1` to check everything works.
   Invite your own email first. Open the link it gives you, set a password on the site, then run in the SQL editor:
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
   ```
   Log out/in: an upload form appears for you only. Invite everyone else the same way.
6. Settings → API: copy the Project URL and the `anon` public key.

## 2. Render
1. Push this folder to a GitHub repo.
2. Render → New → Static Site (or Blueprint using `render.yaml`).
3. Build command: `node build.js`, publish directory: `.`
4. Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

## Inviting people
- `invite.ps1` makes one link per person and copies a ready-to-send message. Send each person only the newest link: making another link for the same email cancels the earlier one. Links last 24 hours and work once.
- Someone who already has an account automatically gets a password-reset link instead.

## Testing
- `node tests/ui/run.js`: every screen and edge case in headless Chrome with a fake Supabase (no network).
- `node tests/e2e/run-mock.js`: the full reader journey (invite → password → gallery → reset → deleted account) with the real page and real supabase-js library, against a local stand-in for Supabase. No network or token needed.
- `node tests/e2e/live.js`: the live site against the real Supabase project; public checks only, touches no accounts.
- `test-invite.ps1`: Supabase settings, the invite/reset backend, and a full reader journey in a real browser on the live site with a throwaway account (deleted afterwards). Run this after any change.

## Security
- Only logged-in users can read the `comics` table and the private `comics` bucket (images load via 6-hour signed URLs, cached in the browser and wiped on log out).
- Only users listed in `admins` can insert/delete comics or files; enforced by Row Level Security, not the UI.
- Never put the `service_role` key in this site. Only the anon key.
- Signups and anonymous sign-ins are disabled in Supabase, so only invited emails have accounts. To revoke access, delete the user under Authentication → Users.
- The Supabase library is served from `vendor/` (verified against npm's published hash), not a CDN. A Content-Security-Policy only allows scripts from this site and connections to Supabase.

## Keeping it running
- Supabase pauses free projects after about 7 days with no activity. If the site stops logging people in, open the Supabase dashboard and click **Restore**.

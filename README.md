# Comic at the Door

Static site + Supabase (auth, Postgres, private Storage). Deployed on Render.

## 1. Supabase
1. Create a project at supabase.com.
2. SQL Editor → paste and run `supabase.sql`.
3. Authentication → Sign In / Providers (or Settings) → turn OFF "Allow new users to sign up". Invite-only from now on.
4. Authentication → URL Configuration: set Site URL to your Render URL and add it under Redirect URLs (invite links land there).
5. Authentication → Users → **Invite user**, enter your own email first. Click the link in the email, set a password on the site, then run in the SQL editor:
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

## Local test
Edit `config.js`, then `npx serve .`

## Security
- Only logged-in users can read the `comics` table and the private `comics` bucket (images load via 1-hour signed URLs).
- Only users listed in `admins` can insert/delete comics or files; enforced by Row Level Security, not the UI.
- Never put the `service_role` key in this site. Only the anon key.
- Signups are disabled in Supabase, so only invited emails have accounts. To revoke access, delete the user under Authentication → Users.

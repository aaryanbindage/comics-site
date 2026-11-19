<#
  Self-test for the invite flow. Uses a throwaway @example.com address (no email is sent)
  and deletes it afterwards. Does not touch real users.
  Run:  powershell -ExecutionPolicy Bypass -File .\test-invite.ps1
  Token needs: API keys read, Auth config read.
#>
param(
  [string]$ProjectRef = 'ehihfurhujnayovoxpjw',
  [string]$SiteUrl = 'https://comics-site.onrender.com'
)
$ErrorActionPreference = 'Stop'
function Ask($label) {
  $s = Read-Host $label -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
function Pass($m) { Write-Host "PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $script:failed = $true }
function Info($m) { Write-Host "INFO  $m" -ForegroundColor Cyan }
function ErrText($err) { if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $err.ErrorDetails.Message } else { $err.Exception.Message } }

$token = if ($env:SUPABASE_ACCESS_TOKEN) { $env:SUPABASE_ACCESS_TOKEN } else { Ask 'Supabase access token' }
$base = "https://$ProjectRef.supabase.co"
$mh = @{ Authorization = "Bearer $token" }

# --- Settings ---
$cfg = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ProjectRef/config/auth" -Headers $mh
$hours = [math]::Round($cfg.mailer_otp_exp / 3600, 2)
if ($cfg.mailer_otp_exp -ge 86400) { Pass "link lifetime is $hours hours" } else { Fail "link lifetime is only $hours hours (need 24). Set Email OTP Expiration to 86400." }
if ($cfg.disable_signup) { Pass 'public signups are disabled' } else { Fail 'public signups are ENABLED (anyone can register)' }
# Anonymous sign-ins would give a stranger a logged-in session, which can read the comics.
if ($cfg.external_anonymous_users_enabled -eq $true) { Fail 'anonymous sign-ins are ENABLED (turn off in Authentication > Sign In / Providers)' } else { Pass 'anonymous sign-ins are disabled' }

# --- Live site is the latest version ---
try {
  $html = (Invoke-WebRequest -UseBasicParsing "$SiteUrl/").Content
  $js = (Invoke-WebRequest -UseBasicParsing "$SiteUrl/app.js").Content
  if ($html -match 'vendor/supabase' -and $js -match 'renderSeq') { Pass 'live site is running the latest code' } else { Fail 'live site is still on an older version (wait for Render to deploy)' }
} catch { Fail "could not load $SiteUrl ($($_.Exception.Message))" }

$keys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ProjectRef/api-keys" -Headers $mh
$anon = ($keys | Where-Object { $_.name -eq 'anon' }).api_key
$service = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
$sh = @{ apikey = $service; Authorization = "Bearer $service"; 'Content-Type' = 'application/json' }
$ah = @{ apikey = $anon; 'Content-Type' = 'application/json' }

function Gen($type, $email) {
  $req = @{ type = $type; email = $email; redirect_to = $SiteUrl }
  if ($type -eq 'invite') { $req.data = @{ needs_password = $true } }
  Invoke-RestMethod -Method Post -Uri "$base/auth/v1/admin/generate_link" -Headers $sh -Body ($req | ConvertTo-Json)
}
# Same logic as invite.ps1: invite, or a reset link only if the account already exists.
function GenLikeScript($email) {
  try { $r = Gen 'invite' $email; return @{ r = $r; type = 'invite' } }
  catch {
    $why = ErrText $_
    if ($why -match 'already|exists|registered') { return @{ r = (Gen 'recovery' $email); type = 'recovery' } }
    throw "generate_link failed: $why"
  }
}
function Verify($type, $email, $code) {
  try { Invoke-RestMethod -Method Post -Uri "$base/auth/v1/verify" -Headers $ah -Body (@{ type = $type; email = $email; token = $code } | ConvertTo-Json) }
  catch { $null }
}

$email = "comic-test-$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"
$userId = $null
try {
  # 1. First invite
  $first = Gen 'invite' $email
  $userId = $first.id
  if ($first.email_otp) { Pass 'invite link generated' } else { Fail 'generate_link returned no code'; throw 'stop' }

  # 2. Re-invite before they accept (what happens when you run invite.ps1 twice for someone)
  $second = GenLikeScript $email
  Pass "re-inviting someone who hasn't accepted works (script makes a '$($second.type)' link)"

  # 3. Wrong email is rejected and doesn't burn the link
  if (Verify $second.type 'someone-else@example.com' $second.r.email_otp) { Fail 'wrong email was ACCEPTED' } else { Pass 'wrong email is rejected' }

  # 4. Correct email + newest link works
  $v = Verify $second.type $email $second.r.email_otp
  if ($v.access_token) { Pass 'newest link + correct email signs the invitee in' } else { Fail 'newest link did NOT work' }
  $meta = if ($v.user) { $v.user.user_metadata.needs_password } else { $null }
  if ($meta -eq $true) { Pass 'account is marked as needing a password' } else { Fail 'needs_password flag missing after accepting' }

  # 5. The older link no longer works
  if (Verify 'invite' $email $first.email_otp) { Info 'older link still worked (both links were valid)' } else { Pass 'older link is cancelled once a newer one is made' }

  # 6. Single use
  if (Verify $second.type $email $second.r.email_otp) { Fail 'link worked a second time' } else { Pass 'link is single-use' }

  # 7. Password-reset link for someone who already has an account
  $again = GenLikeScript $email
  if ($again.type -eq 'recovery') { Pass 'existing account gets a password-reset link' } else { Fail "existing account got a '$($again.type)' link instead of a reset link" }
  if ((Verify $again.type $email $again.r.email_otp).access_token) { Pass 'password-reset link works' } else { Fail 'password-reset link did NOT work' }

  # 8. A logged-in user can set a password and clear the flag (what the "Choose your password" page does)
  $u = Invoke-RestMethod -Method Put -Uri "$base/auth/v1/user" -Headers @{ apikey = $anon; Authorization = "Bearer $($v.access_token)"; 'Content-Type' = 'application/json' } `
    -Body (@{ password = "Test-$([guid]::NewGuid().ToString('N').Substring(0,12))"; data = @{ needs_password = $false } } | ConvertTo-Json)
  if ($u.user_metadata.needs_password -eq $false) { Pass 'setting a password works and clears the flag' } else { Fail 'setting a password did not clear the flag' }
} catch {
  if ($_.Exception.Message -ne 'stop') { Fail "unexpected error: $(ErrText $_)" }
} finally {
  if ($userId) {
    try { Invoke-RestMethod -Method Delete -Uri "$base/auth/v1/admin/users/$userId" -Headers $sh | Out-Null; Write-Host "(test user $email deleted)" }
    catch { Write-Host "Could not delete test user $email - remove it in Authentication > Users." -ForegroundColor Yellow }
  }
}

# --- Full reader journey in a real (headless) browser on the live site ---
Write-Host "`nRunning the full reader journey in a real browser against $SiteUrl (takes about a minute)..." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not installed, so the browser journey could not run (install from nodejs.org)'
} else {
  $env:SUPABASE_SERVICE_KEY = $service   # only for this child process; never written anywhere
  $env:SITE_URL = $SiteUrl
  try {
    & node (Join-Path $PSScriptRoot 'tests\e2e\live.js')
    if ($LASTEXITCODE -ne 0) { $script:failed = $true }
  } finally {
    Remove-Item Env:SUPABASE_SERVICE_KEY -ErrorAction SilentlyContinue
  }
}

if ($script:failed) { Write-Host "`nSome checks FAILED. Paste this output to Claude." -ForegroundColor Red; exit 1 } else { Write-Host "`nAll checks passed." -ForegroundColor Green }

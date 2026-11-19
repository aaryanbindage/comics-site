<#
  Self-test for the invite flow. Uses a throwaway @example.com address (no email is sent)
  and deletes it afterwards. Does not touch real users.
  Run:  powershell -ExecutionPolicy Bypass -File .\test-invite.ps1
  Token needs: API keys read, Auth config read.
#>
$ErrorActionPreference = 'Stop'
function Ask($label, $secret = $false) {
  if ($secret) {
    $s = Read-Host $label -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  }
  return (Read-Host $label).Trim()
}
function Pass($m) { Write-Host "PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $script:failed = $true }

$token = if ($env:SUPABASE_ACCESS_TOKEN) { $env:SUPABASE_ACCESS_TOKEN } else { Ask 'Supabase access token' $true }
$ref   = Ask 'Supabase project ref (default ehihfurhujnayovoxpjw)'
if (-not $ref) { $ref = 'ehihfurhujnayovoxpjw' }
$base = "https://$ref.supabase.co"
$mh = @{ Authorization = "Bearer $token" }

# 1. Link lifetime
$cfg = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/config/auth" -Headers $mh
$hours = [math]::Round($cfg.mailer_otp_exp / 3600, 2)
if ($cfg.mailer_otp_exp -ge 86400) { Pass "link lifetime is $hours hours" } else { Fail "link lifetime is only $hours hours (need 24). Set Email OTP Expiration to 86400." }
if ($cfg.disable_signup) { Pass 'public signups are disabled' } else { Fail 'public signups are ENABLED (anyone can register)' }

# 2. Keys
$keys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/api-keys" -Headers $mh
$anon = ($keys | Where-Object { $_.name -eq 'anon' }).api_key
$service = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
$sh = @{ apikey = $service; Authorization = "Bearer $service"; 'Content-Type' = 'application/json' }
$email = "comic-test-$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"
$userId = $null
try {
  # 3. Generate invite link (same call invite.ps1 makes)
  $body = @{ type = 'invite'; email = $email; redirect_to = 'https://comics-site.onrender.com'; data = @{ needs_password = $true } } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/admin/generate_link" -Headers $sh -Body $body
  $userId = $r.id
  if ($r.email_otp) { Pass 'invite link generated (email_otp present)' } else { Fail 'generate_link returned no email_otp'; throw 'stop' }

  # 4. Wrong email must be rejected, and must NOT burn the link
  try {
    Invoke-RestMethod -Method Post -Uri "$base/auth/v1/verify" -Headers @{ apikey = $anon; 'Content-Type' = 'application/json' } `
      -Body (@{ type = 'invite'; email = 'someone-else@example.com'; token = $r.email_otp } | ConvertTo-Json) | Out-Null
    Fail 'wrong email was ACCEPTED'
  } catch { Pass 'wrong email is rejected' }

  # 5. Correct email must work
  $v = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/verify" -Headers @{ apikey = $anon; 'Content-Type' = 'application/json' } `
    -Body (@{ type = 'invite'; email = $email; token = $r.email_otp } | ConvertTo-Json)
  if ($v.access_token) { Pass 'correct email + link signs the invitee in' } else { Fail 'verify returned no session' }
  if ($v.user.user_metadata.needs_password -eq $true) { Pass 'needs_password flag is set on the new account' } else { Fail 'needs_password flag missing' }

  # 6. Link must be single-use
  try {
    Invoke-RestMethod -Method Post -Uri "$base/auth/v1/verify" -Headers @{ apikey = $anon; 'Content-Type' = 'application/json' } `
      -Body (@{ type = 'invite'; email = $email; token = $r.email_otp } | ConvertTo-Json) | Out-Null
    Fail 'link worked a second time'
  } catch { Pass 'link is single-use' }
} catch {
  if ($_.Exception.Message -ne 'stop') { Fail "unexpected error: $($_.Exception.Message)" }
} finally {
  if ($userId) {
    try { Invoke-RestMethod -Method Delete -Uri "$base/auth/v1/admin/users/$userId" -Headers $sh | Out-Null; Write-Host "(test user $email deleted)" }
    catch { Write-Host "Could not delete test user $email - remove it in Authentication > Users." -ForegroundColor Yellow }
  }
}
if ($script:failed) { Write-Host "`nSome checks FAILED." -ForegroundColor Red; exit 1 } else { Write-Host "`nAll checks passed." -ForegroundColor Green }

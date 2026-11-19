<#
  Creates an invite link for each email WITHOUT sending any email, so you can
  send it yourself with your own wording. The message is copied to your clipboard.
  Run:  powershell -ExecutionPolicy Bypass -File .\invite.ps1

  Generate ONE link per person and send that one. Making another link for the same
  person cancels the earlier one.
#>
param(
  [string]$SiteUrl = 'https://comics-site.onrender.com',
  [string]$ProjectRef = 'ehihfurhujnayovoxpjw'
)
$ErrorActionPreference = 'Stop'
function Ask($label, $secret = $false) {
  if ($secret) {
    $s = Read-Host $label -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  }
  return (Read-Host $label).Trim()
}
function ErrText($err) { if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $err.ErrorDetails.Message } else { $err.Exception.Message } }

$token = if ($env:SUPABASE_ACCESS_TOKEN) { $env:SUPABASE_ACCESS_TOKEN } else { Ask 'Supabase access token' $true }

# service_role key is read from the API for this run only; never saved.
$keys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ProjectRef/api-keys" -Headers @{ Authorization = "Bearer $token" }
$service = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
if (-not $service) { throw 'Could not read the service_role key (token needs API keys read access).' }
$h = @{ apikey = $service; Authorization = "Bearer $service"; 'Content-Type' = 'application/json' }
$gen = "https://$ProjectRef.supabase.co/auth/v1/admin/generate_link"

function New-Link($email, $type) {
  $req = @{ type = $type; email = $email; redirect_to = $SiteUrl }
  # Flag new accounts so the site keeps asking for a password until one is saved.
  if ($type -eq 'invite') { $req.data = @{ needs_password = $true } }
  $r = Invoke-RestMethod -Method Post -Uri $gen -Headers $h -Body ($req | ConvertTo-Json)
  if (-not $r.email_otp) { throw 'Supabase returned no code.' }
  # Link to our site with a form (invitee must type their email), so link scanners can't burn the
  # one-time code and a stray link can't be used by someone who doesn't know the invited address.
  "$SiteUrl/?otp=$($r.email_otp)&type=$type"
}

while ($true) {
  $email = (Ask "`nEmail to invite (blank to finish)").ToLower()
  if (-not $email) { break }
  if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Write-Host "That doesn't look like an email address." -ForegroundColor Red; continue }
  $name = Ask 'First name (optional, for the greeting)'
  $type = 'invite'
  try {
    $link = New-Link $email 'invite'
  } catch {
    $why = ErrText $_
    if ($why -match 'already|exists|registered') {
      # They already have an account -> give them a link to choose a new password instead.
      Write-Host 'This person already has an account, so this is a password-reset link.' -ForegroundColor Yellow
      $type = 'recovery'
      try { $link = New-Link $email 'recovery' } catch { Write-Host "Failed: $(ErrText $_)" -ForegroundColor Red; continue }
    } else {
      Write-Host "Failed: $why" -ForegroundColor Red
      continue
    }
  }

  $hi = if ($name) { "Hi $name,`n`n" } else { "Hi,`n`n" }
  if ($type -eq 'invite') {
    $msg = $hi +
      "Welcome to Comic At The Door! You've been invited to our private comic archive.`n`n" +
      "Use the link below to accept your invitation and choose a password. When it asks, type in this email address ($email).`n`n" +
      "$link`n`n" +
      "Once you're set up, you can log in any time at $SiteUrl`n`n" +
      "Please note: the invitation link expires in 24 hours and can only be used once. " +
      "If it runs out, just let us know and we'll send you a fresh one."
  } else {
    $msg = $hi +
      "Here is your link to choose a new password for Comic At The Door. When it asks, type in this email address ($email).`n`n" +
      "$link`n`n" +
      "After that, you can log in any time at $SiteUrl`n`n" +
      "Please note: this link expires in 24 hours and can only be used once."
  }
  Set-Clipboard -Value $msg
  Write-Host "`n$msg" -ForegroundColor Green
  Write-Host "`n(copied to clipboard - paste it into your message to $email)"
}
Remove-Variable token, service, h, keys -ErrorAction SilentlyContinue

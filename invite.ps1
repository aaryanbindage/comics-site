<#
  Creates an invite link for each email WITHOUT sending any email, so you can
  send it yourself with your own wording.
  Run:  powershell -ExecutionPolicy Bypass -File .\invite.ps1
#>
param(
  [string]$SiteUrl = 'https://comics-site.onrender.com'
)
$ErrorActionPreference = 'Stop'
function Ask($label, $secret = $false) {
  if ($secret) {
    $s = Read-Host $label -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  }
  return (Read-Host $label).Trim()
}

$token = if ($env:SUPABASE_ACCESS_TOKEN) { $env:SUPABASE_ACCESS_TOKEN } else { Ask 'Supabase access token' $true }
$ref   = Ask 'Supabase project ref'

# service_role key is read from the API for this run only; never saved.
$keys = Invoke-RestMethod -Uri "https://api.supabase.com/v1/projects/$ref/api-keys" -Headers @{ Authorization = "Bearer $token" }
$service = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
if (-not $service) { throw 'Could not read the service_role key (token needs secrets/API keys read access).' }
$h = @{ apikey = $service; Authorization = "Bearer $service"; 'Content-Type' = 'application/json' }
$gen = "https://$ref.supabase.co/auth/v1/admin/generate_link"

function New-Link($email, $type) {
  $body = @{ type = $type; email = $email; redirect_to = $SiteUrl } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri $gen -Headers $h -Body $body
  # Link to our site with a button, so email/chat link scanners can't burn the one-time token.
  "$SiteUrl/?token_hash=$($r.hashed_token)&type=$type"
}

while ($true) {
  $email = Ask "`nEmail to invite (blank to finish)"
  if (-not $email) { break }
  try {
    $link = New-Link $email 'invite'
  } catch {
    # Already has an account -> give them a password-set link instead.
    Write-Host "Invite failed (account may already exist); making a password-reset link instead." -ForegroundColor Yellow
    try { $link = New-Link $email 'recovery' } catch { Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red; continue }
  }
  $msg = "Welcome to Comic At The Door! Please accept this invitation to access our comic archive:`n$link"
  Set-Clipboard -Value $msg
  Write-Host "`n$msg" -ForegroundColor Green
  Write-Host '(copied to clipboard - paste it into your message)'
}
Remove-Variable token, service, h, keys -ErrorAction SilentlyContinue

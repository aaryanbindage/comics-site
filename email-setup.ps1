<#
  Brands the Supabase auth emails as "Comic At The Door" and lengthens link expiry.
  Run:  powershell -ExecutionPolicy Bypass -File .\email-setup.ps1

  Sender name: Supabase's built-in mailer always sends as "Supabase Auth".
  To send as "Comic At The Door" you must supply your own SMTP (e.g. Gmail app
  password, Resend, Brevo). Leave the SMTP prompts blank to skip that part.
#>
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
$h = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$api = "https://api.supabase.com/v1/projects/$ref/config/auth"
function Patch($obj) { Invoke-RestMethod -Method Patch -Uri $api -Headers $h -Body ($obj | ConvertTo-Json -Depth 5) | Out-Null }

$invite = @'
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1d1f">
  <h1 style="font-size:22px;margin:0 0 16px">Welcome to Comic At The Door</h1>
  <p style="font-size:16px;line-height:1.5">Please accept this invitation to access our comic archive.</p>
  <p style="margin:28px 0">
    <a href="{{ .ConfirmationURL }}" style="background:#3b5bdb;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:16px">Accept invitation</a>
  </p>
  <p style="font-size:13px;color:#6b6b70;line-height:1.5">This invitation was sent by Comic At The Door. The link expires in 24 hours. If it runs out, just ask for a fresh one. If you weren't expecting this email, you can ignore it.</p>
</div>
'@

$recovery = @'
<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d1d1f">
  <h1 style="font-size:22px;margin:0 0 16px">Comic At The Door</h1>
  <p style="font-size:16px;line-height:1.5">Use the button below to reset your password.</p>
  <p style="margin:28px 0">
    <a href="{{ .ConfirmationURL }}" style="background:#3b5bdb;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:16px">Reset password</a>
  </p>
  <p style="font-size:13px;color:#6b6b70">If you didn't ask for this, you can ignore this email.</p>
</div>
'@

Write-Host "Supabase's free tier needs custom SMTP before email templates / sender name can change."
Write-Host 'Leave the SMTP host blank to skip (only the link expiry will be applied).'
$smtpHost = Ask 'SMTP host (e.g. smtp.gmail.com)'
if ($smtpHost) {
  $port  = Ask 'SMTP port (465 for Gmail)'
  $user  = Ask 'SMTP username'
  $pass  = Ask 'SMTP password / app password' $true
  $from  = Ask 'From address (e.g. comicatthedoor@gmail.com)'
  Write-Host '==> Setting SMTP'
  Patch @{
    external_email_enabled = $true
    smtp_host = $smtpHost; smtp_port = $port; smtp_user = $user; smtp_pass = $pass
    smtp_admin_email = $from; smtp_sender_name = 'Comic At The Door'
  }
  Write-Host '==> Updating email templates'
  Patch @{
    mailer_subjects_invite            = 'Welcome to Comic At The Door'
    mailer_templates_invite_content   = [string]$invite
    mailer_subjects_recovery          = 'Reset your Comic At The Door password'
    mailer_templates_recovery_content = [string]$recovery
  }
} else {
  Write-Host 'Skipping SMTP and templates.' -ForegroundColor Yellow
}

Write-Host '==> Setting link expiry'
try {
  Patch @{ mailer_otp_exp = 172800 }   # 48 hours
  Write-Host 'Links now last 48 hours.' -ForegroundColor Green
} catch {
  Write-Host 'Supabase rejected 48h (its max is 24h). Setting 24h instead.' -ForegroundColor Yellow
  Patch @{ mailer_otp_exp = 86400 }
}
Write-Host 'Done.'

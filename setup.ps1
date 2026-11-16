<#
  One-shot go-live script for the comics site.
  Does: run supabase.sql -> push to GitHub -> create Render static site ->
        disable signups + set redirect URLs -> invite you and make you admin.

  Needs:  git, gh (GitHub CLI, already `gh auth login`ed), internet.
  Tokens are read from prompts/env and never written to disk.

  Run:    powershell -ExecutionPolicy Bypass -File .\setup.ps1
#>
param(
  [string]$RepoName = 'comics-site',
  [switch]$PrivateRepo   # Render must have GitHub access to private repos
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Ask($label, $secret = $false) {
  if ($secret) {
    $s = Read-Host $label -AsSecureString
    return [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  }
  return (Read-Host $label).Trim()
}
function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

foreach ($cmd in 'git', 'gh.exe') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not installed / not on PATH." }
}
gh.exe auth status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Run `gh auth login` first.' }

Write-Host @'
You need:
  1. Supabase access token  -> https://supabase.com/dashboard/account/tokens
  2. Supabase project ref   -> the xxxx in https://xxxx.supabase.co
  3. Render API key         -> Render dashboard > Account Settings > API Keys
  4. Your admin email
'@
$sbToken  = if ($env:SUPABASE_ACCESS_TOKEN) { $env:SUPABASE_ACCESS_TOKEN } else { Ask 'Supabase access token' $true }
$ref      = Ask 'Supabase project ref'
$renderKey = if ($env:RENDER_API_KEY) { $env:RENDER_API_KEY } else { Ask 'Render API key' $true }
$adminEmail = Ask 'Admin email (you)'

$sbHeaders = @{ Authorization = "Bearer $sbToken"; 'Content-Type' = 'application/json' }
$rHeaders  = @{ Authorization = "Bearer $renderKey"; 'Content-Type' = 'application/json'; Accept = 'application/json' }
$sbApi = "https://api.supabase.com/v1/projects/$ref"
$sbUrl = "https://$ref.supabase.co"

function Run-Sql($sql) {
  $body = @{ query = $sql } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$sbApi/database/query" -Headers $sbHeaders -Body $body | Out-Null
}

# 1. Database ------------------------------------------------------------
Step 'Running supabase.sql (tables, policies, private bucket)'
Run-Sql (Get-Content .\supabase.sql -Raw)

Step 'Fetching API keys'
$keys = Invoke-RestMethod -Uri "$sbApi/api-keys" -Headers $sbHeaders
$anon = ($keys | Where-Object { $_.name -eq 'anon' }).api_key
$service = ($keys | Where-Object { $_.name -eq 'service_role' }).api_key
if (-not $anon -or -not $service) { throw 'Could not read anon/service_role keys.' }

# 2. GitHub --------------------------------------------------------------
Step 'Pushing to GitHub'
if (-not (Test-Path .git)) { git init -b main | Out-Null }
git add -A
git commit -m 'Comics site' 2>$null | Out-Null
$vis = if ($PrivateRepo) { '--private' } else { '--public' }
git remote get-url origin 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  git push -u origin main    # repo already created, just push
} else {
  gh.exe repo create $RepoName $vis --source . --push
}
$repoUrl = (gh.exe repo view --json url -q .url)

# 3. Render --------------------------------------------------------------
Step 'Creating Render static site'
$owner = (Invoke-RestMethod -Uri 'https://api.render.com/v1/owners?limit=1' -Headers $rHeaders)[0].owner.id
$svcBody = @{
  type = 'static_site'; name = $RepoName; ownerId = $owner
  repo = $repoUrl; branch = 'main'; autoDeploy = 'yes'
  envVars = @(
    @{ key = 'SUPABASE_URL';      value = $sbUrl },
    @{ key = 'SUPABASE_ANON_KEY'; value = $anon }
  )
  serviceDetails = @{ buildCommand = 'node build.js'; publishPath = '.' }
} | ConvertTo-Json -Depth 6
$svc = Invoke-RestMethod -Method Post -Uri 'https://api.render.com/v1/services' -Headers $rHeaders -Body $svcBody
$siteUrl = $svc.service.serviceDetails.url
if (-not $siteUrl) { $siteUrl = "https://$RepoName.onrender.com" }
Write-Host "Render site: $siteUrl"

# 4. Supabase auth config ------------------------------------------------
Step 'Disabling signups + setting redirect URLs'
$authBody = @{
  disable_signup = $true
  site_url       = $siteUrl
  uri_allow_list = "$siteUrl,$siteUrl/**"
} | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "$sbApi/config/auth" -Headers $sbHeaders -Body $authBody | Out-Null

# 5. Invite admin --------------------------------------------------------
Step "Inviting $adminEmail and granting admin"
$inv = @{ apikey = $service; Authorization = "Bearer $service"; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Method Post -Uri "$sbUrl/auth/v1/invite?redirect_to=$([uri]::EscapeDataString($siteUrl))" `
  -Headers $inv -Body (@{ email = $adminEmail } | ConvertTo-Json) | Out-Null
$safeEmail = $adminEmail.Replace("'", "''")
Run-Sql "insert into public.admins (user_id) select id from auth.users where email = '$safeEmail' on conflict do nothing;"

Write-Host "`nDone." -ForegroundColor Green
Write-Host "1. Wait for the first Render deploy to finish (~1-2 min): $siteUrl"
Write-Host "2. Open the invite email sent to $adminEmail, set your password."
Write-Host "3. Invite others: Supabase dashboard > Authentication > Users > Invite user."
Remove-Variable sbToken, renderKey, anon, service, inv, keys -ErrorAction SilentlyContinue

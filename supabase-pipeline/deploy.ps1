# deploy.ps1 - Universal Parser v4 -> Supabase
# Run: .\deploy.ps1 after setting env vars
$ErrorActionPreference = "Stop"

$SUPABASE_URL          = $env:SUPABASE_URL
$SUPABASE_SERVICE_ROLE = $env:SUPABASE_SERVICE_ROLE_KEY
$PAGESPEED_API_KEY     = $env:PAGESPEED_API_KEY
$DAYS_THRESHOLD        = if ($env:DAYS_THRESHOLD) { $env:DAYS_THRESHOLD } else { "30" }

if (-not $SUPABASE_URL -or -not $SUPABASE_SERVICE_ROLE) {
  Write-Host "ERROR: Set env vars first:" -ForegroundColor Red
  Write-Host '  $env:SUPABASE_URL = "https://xxxx.supabase.co"'
  Write-Host '  $env:SUPABASE_SERVICE_ROLE_KEY = "eyJh..."'
  exit 1
}

function Invoke-SupabaseRest {
  param([string]$Method = "GET", [string]$Path, $Body, [string]$Prefer = "", [hashtable]$Extra = @{})
  $uri = "$SUPABASE_URL$Path"
  $h = @{ "apikey" = $SUPABASE_SERVICE_ROLE; "Authorization" = "Bearer $SUPABASE_SERVICE_ROLE"; "Content-Type" = "application/json" }
  if ($Prefer) { $h["Prefer"] = $Prefer }
  foreach ($k in $Extra.Keys) { $h[$k] = $Extra[$k] }
  $p = @{ Uri = $uri; Method = $Method; Headers = $h; ContentType = "application/json" }
  if ($Body) { $p["Body"] = ($Body | ConvertTo-Json -Depth 10 -Compress) }
  try {
    $r = Invoke-WebRequest @p -UseBasicParsing -TimeoutSec 30
    return @{ ok = $true; status = $r.StatusCode; body = $r.Content }
  } catch {
    $c = $_.Exception.Response.StatusCode.value__
    return @{ ok = ($c -eq 200 -or $c -eq 201 -or $c -eq 204 -or $c -eq 409); status = $c; error = $_.Exception.Message }
  }
}

function Write-Step { param([string]$T, [int]$S)
  Write-Host ""; Write-Host ("=" * 55) -ForegroundColor Cyan
  Write-Host "  Step $S : $T" -ForegroundColor White
  Write-Host ("=" * 55) -ForegroundColor Cyan
}
function OK  { Write-Host "  [OK]    $args" -ForegroundColor Green }
function WARN { Write-Host "  [WARN]  $args" -ForegroundColor Yellow }
function ERR  { Write-Host "  [ERROR] $args" -ForegroundColor Red }

$s = 0

# STEP 1: Check connection
Write-Step "Check connection" (++$s)
$t = Invoke-SupabaseRest -Method GET -Path "/rest/v1/"
if ($t.ok) { OK "Connected ($($t.status))" } else { ERR "Failed: $($t.error)"; exit 1 }

# STEP 2: Apply DB migration
Write-Step "Database migration" (++$s)
$mf = Join-Path $PSScriptRoot "supabase\migrations\00001_schema.sql"
if (-not (Test-Path $mf)) { ERR "Migration file not found: $mf"; exit 1 }

$sql = Get-Content -Path $mf -Raw -Encoding UTF8

Write-Host "  -----------------------------------------------------------" -ForegroundColor Yellow
Write-Host "  DDL must be run in SQL Editor:"
Write-Host "    1. Open https://supabase.com/dashboard"
Write-Host "    2. SQL Editor -> New Query"
Write-Host "    3. Paste content of: supabase/migrations/00001_schema.sql"
Write-Host "    4. Click Run"
Write-Host "  -----------------------------------------------------------" -ForegroundColor Yellow

# Copy SQL to clipboard for convenience
Set-Clipboard -Value $sql
Write-Host "  SQL copied to clipboard (just paste in SQL Editor)"
Read-Host "  Press Enter after running the SQL"

# Verify tables exist
$t = Invoke-SupabaseRest -Method GET -Path "/rest/v1/entries?limit=1"
if ($t.ok) { OK "Tables created" } else { WARN "Cannot verify: $($t.error)" }

# STEP 3: Storage bucket
Write-Step "Storage bucket" (++$s)
$b = Invoke-SupabaseRest -Method POST -Path "/storage/v1/bucket" -Body @{
  name = "screenshots"; public = $false
  file_size_limit = 20971520
  allowed_mime_types = @("image/png", "image/jpeg", "image/webp")
}
if ($b.ok -or $b.status -eq 409) {
  OK "Bucket 'screenshots' ready"
} else {
  ERR "Bucket error: $($b.error)"
}

# STEP 4: CrUX ranks (optional, needs Python)
Write-Step "CrUX ranks" (++$s)
$cp = Join-Path $PSScriptRoot "scripts\crux_update.py"
try { $hasPy = python --version 2>$null } catch { $hasPy = $null }
if ($hasPy) {
  Write-Host "  Running: python crux_update.py ..."
  python $cp --supabase-url $SUPABASE_URL --supabase-key $SUPABASE_SERVICE_ROLE
  if ($LASTEXITCODE -eq 0) { OK "CrUX ranks loaded" } else { WARN "CrUX script failed" }
} else {
  WARN "Python not found - skipping CrUX ranks"
  Write-Host "  Run later: python scripts/crux_update.py --supabase-url ... --supabase-key ..."
}

# STEP 5: Edge Functions
Write-Step "Edge Functions" (++$s)

function Deploy-Func {
  param([string]$Name, [string]$Dir)
  $ix = Join-Path $Dir "index.ts"
  if (-not (Test-Path $ix)) { WARN "Not found: $ix"; return }
  $code = Get-Content -Path $ix -Raw -Encoding UTF8

  $mgmtToken = $env:SUPABASE_ACCESS_TOKEN
  if (-not $mgmtToken) {
    WARN "SUPABASE_ACCESS_TOKEN not set - skipping $Name"
    Write-Host "  Get token: https://supabase.com/dashboard/account/tokens"
    Write-Host "  Or deploy manually: Dashboard -> Edge Functions -> New Function"
    return
  }

  $ref = ($SUPABASE_URL -replace "https://", "" -replace "\.supabase\.co.*", "")
  $uri = "https://api.supabase.com/v1/projects/$ref/functions"
  $body = @{ slug = $Name; name = $Name; body = $code; verify_jwt = $false }
  $hdr = @{ "Authorization" = "Bearer $mgmtToken"; "Content-Type" = "application/json" }

  try {
    $r = Invoke-RestMethod -Uri "$uri" -Method POST -Headers $hdr -Body ($body | ConvertTo-Json -Depth 5) -TimeoutSec 30
    OK "Deployed: $Name"
  } catch {
    try {
      $r = Invoke-RestMethod -Uri "$uri/$Name" -Method PATCH -Headers $hdr -Body ($body | ConvertTo-Json -Depth 5) -TimeoutSec 30
      OK "Updated: $Name"
    } catch {
      ERR "Function $Name : $_"
    }
  }
}

$fd = Join-Path $PSScriptRoot "supabase\functions"
Deploy-Func -Name "screenshot"      -Dir "$fd\screenshot"
Deploy-Func -Name "crux-rank"       -Dir "$fd\crux-rank"
Deploy-Func -Name "process-entries" -Dir "$fd\process-entries"

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host ""
  Write-Host "  -----------------------------------------------------------" -ForegroundColor Yellow
  Write-Host "  Manual deploy (without CLI):"
  Write-Host "    1. Dashboard -> Edge Functions -> New Function"
  Write-Host "    2. Name: screenshot / crux-rank / process-entries"
  Write-Host "    3. Paste content from supabase/functions/NAME/index.ts"
  Write-Host "  -----------------------------------------------------------" -ForegroundColor Yellow
}

# STEP 6: Secrets
Write-Step "Secrets" (++$s)
if ($PAGESPEED_API_KEY) {
  OK "PAGESPEED_API_KEY set (len: $($PAGESPEED_API_KEY.Length))"
  Write-Host "  Set in Dashboard -> Edge Functions -> Secrets:"
  Write-Host "    PAGESPEED_API_KEY = $PAGESPEED_API_KEY"
  Write-Host "    DAYS_THRESHOLD = $DAYS_THRESHOLD"
} else {
  WARN "PAGESPEED_API_KEY not set"
}

# SUMMARY
Write-Host ""
Write-Host ("=" * 55) -ForegroundColor Cyan
Write-Host "  DEPLOY COMPLETE" -ForegroundColor Green
Write-Host ("=" * 55) -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Add domains via frontend or SQL:"
Write-Host "     INSERT INTO domain_list (domain) VALUES ('yandex.ru');"
Write-Host "  2. Run processing:"
Write-Host "     curl -X POST $SUPABASE_URL/functions/v1/process-entries"
Write-Host "     -H 'Authorization: Bearer ANON_KEY'"
Write-Host "     -H 'Content-Type: application/json'"
Write-Host "     -d '{\`"limit\`": 50}'"
Write-Host "  3. Open dashboard: public/index.html"

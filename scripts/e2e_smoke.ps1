$ErrorActionPreference = "Stop"

# Optional dotenv loader for .env.e2e (KEY=VAL)
if (Test-Path ".env.e2e") {
  Get-Content ".env.e2e" | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    if ($_ -match '^\s*([^=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }
}

$required = @("E2E_API_KEY","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","API_KEY_SALT")
$missing = @()
foreach ($v in $required) {
  if (-not $env:$v) { $missing += $v }
}
if ($missing.Count -gt 0) {
  Write-Error "Missing required env vars: $($missing -join ', ')"
  exit 1
}

# Choose random free port
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback,0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

$env:PORT = $port
if (-not $env:EMBEDDINGS_MODE) { $env:EMBEDDINGS_MODE = "stub" }

$root = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent $root
Set-Location $root
if (-not (Test-Path ".tmp")) { New-Item -ItemType Directory ".tmp" | Out-Null }
$log = ".tmp\e2e_smoke.log"

$wranglerToml = Join-Path $root "apps/api/wrangler.toml"
if (-not (Test-Path $wranglerToml)) {
  Write-Error "ERROR: wrangler.toml not found at $wranglerToml"
  exit 1
}
$doSection = Select-String -Path $wranglerToml -Pattern "durable_objects"
if (-not $doSection) {
  Write-Error "ERROR: wrangler.toml is missing durable_objects section (expected RATE_LIMIT_DO)"
  exit 1
}
$doBinding = Select-String -Path $wranglerToml -Pattern 'binding\s*=\s*"RATE_LIMIT_DO"'
if (-not $doBinding) {
  Write-Error "ERROR: wrangler.toml is missing durable_objects binding RATE_LIMIT_DO"
  Select-String -Path $wranglerToml -Pattern "durable_objects" -Context 0,12
  exit 1
}

function Cleanup {
  if ($script:wrangler) {
    try { Stop-Process -Id $script:wrangler.Id -ErrorAction SilentlyContinue } catch {}
  }
}

try {
  Write-Host "Starting wrangler dev on port $port..."
  $script:wrangler = Start-Process -FilePath pnpm `
    -ArgumentList "--filter","@memorynode/api","wrangler","dev","--port",$port,"--log-level","error" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log `
    -RedirectStandardError $log `
    -WindowStyle Hidden `
    -PassThru
  Start-Sleep -Milliseconds 200

  function Tail-Logs {
    if (Test-Path $log) { Get-Content $log -Tail 200 }
  }

  Write-Host "Base URL: http://127.0.0.1:$port"
  Write-Host -NoNewline "Waiting for /healthz"
  $healthy = $false
  for ($i=0; $i -lt 60; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2 | Out-Null
      $healthy = $true
      break
    } catch {
      Write-Host -NoNewline "."
      Start-Sleep -Seconds 1
    }
  }
  if (-not $healthy) {
    Write-Host " failed"
    Write-Host "Health check failed. Recent logs:"
    Tail-Logs
    throw "healthz not ready"
  } else {
    Write-Host " ok"
  }

  function Redact-Headers([string]$text) {
    return ($text -replace '(?i)Authorization: Bearer\s+\S+', 'Authorization: Bearer ***redacted***')
  }

  function Call-Api($method, $path, $expectedStatus, $body = $null, $assertProp = $null) {
    Write-Host "-> $method $path"
    $uri = "http://127.0.0.1:$port$path"
    $headers = @{ Authorization = "Bearer $env:E2E_API_KEY" }
    if ($body) { $headers["Content-Type"] = "application/json" }
    try {
      $resp = Invoke-WebRequest -Method $method -Uri $uri -Headers $headers -Body $body -TimeoutSec 30 -ErrorAction Stop
    } catch {
      $resp = $_.Exception.Response
      if (-not $resp) { throw }
    }
    $status = $resp.StatusCode.value__
    if ($status -ne $expectedStatus) {
      Write-Host "Expected $expectedStatus got $status"
      if ($resp.Headers) { Redact-Headers ($resp.Headers | Out-String) | Write-Host }
      if ($resp.Content) { $resp.Content | Write-Host }
      throw "Unexpected status for $method $path"
    }
    if ($assertProp) {
      $json = $resp.Content | ConvertFrom-Json
      if (-not ($json.$assertProp)) {
        throw "Validation failed: missing $assertProp"
      }
    }
  }

  Call-Api -method Post -path "/v1/memories" -expectedStatus 200 -body '{"user_id":"e2e-user","text":"hello e2e memory","namespace":"e2e"}' -assertProp "memory_id"
  Call-Api -method Post -path "/v1/search" -expectedStatus 200 -body '{"user_id":"e2e-user","namespace":"e2e","query":"hello","top_k":3}' -assertProp "results"
  Call-Api -method Post -path "/v1/context" -expectedStatus 200 -body '{"user_id":"e2e-user","namespace":"e2e","query":"hello"}' -assertProp "context_text"
  Call-Api -method Get -path "/v1/usage/today" -expectedStatus 200 -assertProp "day"

  Write-Host "E2E smoke passed."
} finally {
  Cleanup
}

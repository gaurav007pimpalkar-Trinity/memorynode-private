#requires -Version 7
$ErrorActionPreference = "Stop"

$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$apiDir = Join-Path $root "apps/api"
$tmpDir = Join-Path $root ".tmp"
$logFile = Join-Path $tmpDir "wrangler.log"
$errLogFile = Join-Path $tmpDir "wrangler.err.log"
$pidFile = Join-Path $tmpDir "wrangler.pid"
$devVars = Join-Path $apiDir ".dev.vars"
$devVarsBackup = Join-Path $apiDir ".dev.vars.smoke.bak"
$baseUrl = $env:BASE_URL
$smokeMode = $env:SMOKE_MODE
if (-not $smokeMode) { $smokeMode = "local" } # local | ci
$healthRetries = if ($smokeMode -eq "ci") { 90 } else { 60 }
$healthSleep = 1

if ($smokeMode -eq "ci") {
  # Use stubbed Supabase for portability; avoids schema drift when running local smoke.
  $env:SUPABASE_URL = "stub"
  $env:SUPABASE_SERVICE_ROLE_KEY = "stub"
  if (Test-Path $devVarsBackup) {
    throw "Backup already exists: $devVarsBackup. Clean it up before running smoke."
  }
  if (Test-Path $devVars) { Copy-Item $devVars $devVarsBackup -Force }
  @"
SUPABASE_URL=stub
SUPABASE_SERVICE_ROLE_KEY=stub
SUPABASE_MODE=stub
API_KEY_SALT=$($env:API_KEY_SALT ?? "dev_salt_stub")
MASTER_ADMIN_TOKEN=$($env:MASTER_ADMIN_TOKEN ?? "mn_dev_admin_12345")
EMBEDDINGS_MODE=stub
OPENAI_API_KEY=dummy
RATE_LIMIT_DO=stub
"@ | Set-Content $devVars
}

if (-not (Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir | Out-Null }
if (-not (Test-Path $devVars)) {
  Copy-Item (Join-Path $apiDir ".dev.vars.template") $devVars
  Write-Host "info: created .dev.vars from template; fill values as needed."
}

if ($smokeMode -eq "ci") {
  if (Test-Path $devVarsBackup) { Remove-Item $devVarsBackup -ErrorAction SilentlyContinue }
  if (Test-Path $devVars) { Copy-Item $devVars $devVarsBackup -Force }
  @"
SUPABASE_URL=stub
SUPABASE_SERVICE_ROLE_KEY=stub
SUPABASE_MODE=stub
API_KEY_SALT=$($env:API_KEY_SALT ?? "dev_salt_stub")
MASTER_ADMIN_TOKEN=$($env:MASTER_ADMIN_TOKEN ?? "mn_dev_admin_12345")
EMBEDDINGS_MODE=stub
OPENAI_API_KEY=dummy
RATE_LIMIT_DO=stub
"@ | Set-Content $devVars
}

# Preflight checks
function Require-Cmd($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "error: '$cmd' not found. $hint"
    exit 1
  }
}
Write-Host "Preflight: checking required tools..."
Require-Cmd "corepack" "Install Node 20+ then run: npm install -g corepack"
if (-not (Get-Command "pnpm" -ErrorAction SilentlyContinue)) {
  try {
    corepack pnpm --version > $null
  } catch {
    Write-Host "error: pnpm not available. Run: corepack prepare pnpm@9 --activate"
    exit 1
  }
}
$localWranglerJs = Join-Path $root "node_modules/wrangler/bin/wrangler.js"
$hasLocalWrangler = Test-Path $localWranglerJs
if (-not $hasLocalWrangler) {
  Write-Host "info: local wrangler JS not found; will fallback to npx wrangler"
}

# Load .dev.vars (key=value per line) without prompting
Get-Content (Join-Path $apiDir ".dev.vars") | ForEach-Object {
  if ($_ -match "^\s*#") { return }
  if ($_ -match "^\s*$") { return }
  $pair = $_ -split "=", 2
  if ($pair.Length -eq 2) {
    $key = $pair[0].Trim()
    $val = $pair[1].Trim()
    Set-Item -Path "Env:$key" -Value $val
  }
}

$effectiveAdminToken = $null
$adminEnvName = $null
if ($env:MASTER_ADMIN_TOKEN) { $effectiveAdminToken = $env:MASTER_ADMIN_TOKEN; $adminEnvName = "MASTER_ADMIN_TOKEN" }
elseif ($env:ADMIN_TOKEN) { $effectiveAdminToken = $env:ADMIN_TOKEN; $adminEnvName = "ADMIN_TOKEN" }
if (-not $effectiveAdminToken) { throw "ADMIN token missing: set MASTER_ADMIN_TOKEN (preferred) or ADMIN_TOKEN in apps/api/.dev.vars" }
$required = @("SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","API_KEY_SALT","MASTER_ADMIN_TOKEN")
$optional = @("SUPABASE_ANON_KEY","SUPABASE_DB_URL","SUPABASE_PROJECT_REF")
$missing = @()
foreach ($v in $required) { if (-not (Get-Item -Path "Env:$v" -ErrorAction SilentlyContinue)) { $missing += $v } }
if ($missing.Count -gt 0) {
  Write-Host "Missing required env vars in apps/api/.dev.vars:"
  $missing | ForEach-Object { Write-Host " - $_" }
  Write-Host "Get these from Supabase project settings (Project URL, Service Role key) and set API_KEY_SALT/MASTER_ADMIN_TOKEN locally."
  exit 1
}
$_missingOpt = @()
foreach ($v in $optional) { if (-not (Get-Item -Path "Env:$v" -ErrorAction SilentlyContinue)) { $_missingOpt += $v } }
if ($_missingOpt.Count -gt 0) {
  Write-Host ("Note: optional env vars not set (set if your setup requires them): {0}" -f ($_missingOpt -join ", "))
}

if (-not $env:EMBEDDINGS_MODE) { $env:EMBEDDINGS_MODE = "stub" } else { $env:EMBEDDINGS_MODE = "stub" }
if (-not $env:PORT) { $env:PORT = "8787" }
$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { "http://127.0.0.1:{0}" -f $env:PORT }

function Redact-HeaderValue($value) {
  if (-not $value) { return "" }
  if ($value.Length -le 6) { return "<redacted>" }
  return ($value.Substring(0,6) + "***REDACTED***")
}

function Show-Headers($headers) {
  foreach ($kvp in $headers.GetEnumerator()) {
    $name = $kvp.Key
    $val = $kvp.Value
    if ($name -match "authorization|x-api-key|x-admin-token") {
      Write-Host ("  header: {0}: {1}" -f $name, (Redact-HeaderValue $val))
    } else {
      Write-Host ("  header: {0}: {1}" -f $name, $val)
    }
  }
}

function Invoke-CurlJson {
  param(
    [string]$Method,
    [string]$Url,
    [hashtable]$Headers,
    [string]$JsonBody
  )

  $headersArgs = @()
  foreach ($kvp in $Headers.GetEnumerator()) {
    $headersArgs += @("-H", ("{0}: {1}" -f $kvp.Key, $kvp.Value))
  }

  $payloadBytes = if ($JsonBody) { [Text.Encoding]::UTF8.GetByteCount($JsonBody) } else { 0 }
  Write-Host ("==> {0} {1}" -f $Method, $Url)
  Show-Headers $Headers
  Write-Host ("  payload bytes: {0}" -f $payloadBytes)

  $marker = "|HTTPSTATUS:"
  $args = @("--silent","--show-error","--fail-with-body","--connect-timeout","5","--max-time","20","-w",("$marker%{http_code}"),"-X",$Method)
  foreach ($h in $Headers.GetEnumerator()) {
    $args += "-H"
    $args += ("{0}: {1}" -f $h.Key, $h.Value)
  }
  if ($JsonBody) { $args += @("-d", $JsonBody) }
  $args += $Url

  # Print redacted command
  $redactedHeaders = @()
  foreach ($kvp in $Headers.GetEnumerator()) {
    $rv = if ($kvp.Key -match "authorization|x-api-key|x-admin-token") { "<redacted>" } else { $kvp.Value }
    $redactedHeaders += ("-H ""{0}: {1}""" -f $kvp.Key, $rv)
  }
  Write-Host ("  curl: curl.exe --silent --show-error --fail-with-body --connect-timeout 5 --max-time 20 -X {0} {1} {2}" -f $Method, ($redactedHeaders -join " "), $Url)

  $raw = (& curl.exe @args 2>&1)
  $curlExit = $LASTEXITCODE
  $rawText = [string]($raw -join "`n")
  if (-not $rawText) {
    Write-Host ("error: empty curl output (exit {0})" -f $curlExit)
    throw "empty curl output"
  }

  $idx = $rawText.LastIndexOf($marker)
  if ($idx -lt 0) { Write-Host "error: unable to parse curl output"; throw "bad curl output" }
  $resp = $rawText.Substring(0, $idx).TrimEnd()
  $status = $rawText.Substring($idx + $marker.Length).Trim()

  if ($curlExit -ne 0) {
    Write-Host "error: curl failed:"
    Write-Host ($rawText | Out-String)
    throw "curl exited $curlExit"
  }

  Write-Host ("<== status: {0} | resp bytes: {1} | preview: {2}" -f $status, ($resp.Length), ($resp.Substring(0,[Math]::Min(200,$resp.Length))))

  $parsed = $null
  try { $parsed = $resp | ConvertFrom-Json } catch { $parsed = $null }

  return @{
    status = [int]$status
    raw    = $resp
    json   = $parsed
  }
}

function Stop-OldWrangler {
  try {
    $procList = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      ($_.CommandLine -match "wrangler") -or ($_.CommandLine -match "8787")
    }
    foreach ($p in $procList) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {}
  try {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:PORT) -ErrorAction SilentlyContinue
    foreach ($l in $listeners) {
      Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  } catch {}
  if (Test-Path $pidFile) {
    try {
      $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
      if ($oldPid) {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        $kids = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentId -eq [int]$oldPid }
        if ($kids) { $kids | Stop-Process -Force -ErrorAction SilentlyContinue }
      }
    } catch {}
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
}

function Invoke-HealthCheck {
  param(
    [string]$Url
  )
  $marker = "|HTTPSTATUS:"
  $args = @("--silent","--show-error","--fail-with-body","--connect-timeout","2","--max-time","5","-w",("$marker%{http_code}"),$Url)
  $raw = (& curl.exe @args 2>&1)
  $status = 0
  $idx = $raw.LastIndexOf($marker)
  if ($idx -lt 0) {
    Write-Host "Health: bad curl output"
    return $false
  }
  $body = $raw.Substring(0, $idx)
  $status = $raw.Substring($idx + $marker.Length).Trim()

  if ($status -eq "200" -and $body -match '"status"\s*:\s*"ok"') {
    Write-Host "Health: ok"
    return $true
  }
  Write-Host ("Health: status={0}, body={1}" -f $status, $body.Substring(0,[Math]::Min(200,$body.Length)))
  return $false
}
Write-Host "Starting wrangler..."
Stop-OldWrangler
if (Test-Path $logFile) { Remove-Item $logFile -ErrorAction SilentlyContinue }
if (Test-Path $errLogFile) { Remove-Item $errLogFile -ErrorAction SilentlyContinue }
try {
  New-Item -ItemType File -Path $logFile -Force | Out-Null
} catch {
  Write-Host "log file locked, retrying after cleanup..."
  Stop-OldWrangler
  Start-Sleep -Seconds 1
  New-Item -ItemType File -Path $logFile -Force | Out-Null
}

# Build command to run wrangler directly (avoid pnpm process tree)
if ($hasLocalWrangler) {
  $wranglerCmd = "node `"$localWranglerJs`" dev --port $($env:PORT)"
} else {
  $wranglerCmd = "npx wrangler dev --port $($env:PORT)"
}

if ($smokeMode -eq "ci") {
  $wranglerCmd = "$wranglerCmd --var SUPABASE_URL=stub --var SUPABASE_SERVICE_ROLE_KEY=stub"
}

$cmdLine = "cmd /c `"$wranglerCmd >> `"$logFile`" 2>&1`""
  Write-Host ("wrangler command: {0}" -f $wranglerCmd)
  $wrangler = Start-Process -FilePath "cmd.exe" -ArgumentList "/c",$cmdLine -PassThru -WindowStyle Hidden -WorkingDirectory $apiDir
  Write-Host ("Wrangler PID: {0}" -f $wrangler.Id)
Set-Content -Path $pidFile -Value $wrangler.Id

Write-Host "Waiting for port $($env:PORT)..."
$portReady = $false
for ($i=0; $i -lt 30; $i++) {
  $portTest = Test-NetConnection -ComputerName "127.0.0.1" -Port ([int]$env:PORT) -WarningAction SilentlyContinue
  if ($portTest.TcpTestSucceeded) { $portReady = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $portReady) {
  Write-Host "error: port $($env:PORT) did not open in time"
  throw "wrangler did not start"
}
Write-Host "Port $($env:PORT) is listening."

try {
  Write-Host "Calling /healthz..."
  $healthOk = $false
  for ($i = 1; $i -le 120; $i++) {
    if (Invoke-HealthCheck -Url "$baseUrl/healthz") { $healthOk = $true; break }
    if ($i % 10 -eq 0) { Write-Host ("Waiting for /healthz... ({0}/120)" -f $i) }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthOk) { throw "healthz did not return status=ok within timeout" }

  Write-Host ("Admin auth check using header x-admin-token from env {0}" -f $adminEnvName)
  $adminProbe = Invoke-CurlJson -Method "POST" -Url "$baseUrl/v1/workspaces" `
    -Headers @{ "content-type" = "application/json"; "x-admin-token" = $effectiveAdminToken } `
    -JsonBody (@{ name = "Smoke Workspace (probe)" } | ConvertTo-Json -Compress)
  if ($adminProbe.status -eq 401) {
    Write-Host ("Admin auth failed (401). Header sent: x-admin-token; env used: {0}" -f $adminEnvName)
    Write-Host ("Response: {0}" -f $adminProbe.raw.Substring(0,[Math]::Min(200,$adminProbe.raw.Length)))
    throw ("Set {0} in .dev.vars to match the server expectation" -f $adminEnvName)
  }

  Write-Host "Creating workspace..."
  $workspace = Invoke-CurlJson -Method "POST" -Url "$baseUrl/v1/workspaces" `
    -Headers @{ "content-type" = "application/json"; "x-admin-token" = $effectiveAdminToken } `
    -JsonBody (@{ name = "Smoke Workspace" } | ConvertTo-Json -Compress)
  if (-not $workspace.json) { throw "workspace response not JSON: $($workspace.raw.Substring(0,[Math]::Min(400,$workspace.raw.Length)))" }
  $wsId = $workspace.json.workspace_id
  $wsRe = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  if (-not $wsId -or ($wsId -notmatch $wsRe)) { throw "workspace_id missing/invalid: $($workspace | ConvertTo-Json -Depth 5)" }
  $workspaceId = $wsId

  Write-Host "Creating API key..."
  $apiKeyResp = Invoke-CurlJson -Method "POST" -Url "$baseUrl/v1/api-keys" `
    -Headers @{ "content-type" = "application/json"; "x-admin-token" = $effectiveAdminToken } `
    -JsonBody (@{ workspace_id = $workspaceId; name = "Smoke Key" } | ConvertTo-Json -Compress)
  if (-not $apiKeyResp.json) { throw "api-key response not JSON: $($apiKeyResp.raw.Substring(0,[Math]::Min(400,$apiKeyResp.raw.Length)))" }
  if (-not $apiKeyResp.json.api_key -or -not ($apiKeyResp.json.api_key -as [string]).Trim().Length) { throw "api_key missing/empty: $($apiKeyResp.raw.Substring(0,[Math]::Min(400,$apiKeyResp.raw.Length)))" }
  if (-not $apiKeyResp.json.api_key_id) { throw "api_key_id missing: $($apiKeyResp.raw.Substring(0,[Math]::Min(400,$apiKeyResp.raw.Length)))" }
  $apiKey = $apiKeyResp.json.api_key

  Write-Host "Ingesting memory..."
  $memoryResp = Invoke-CurlJson -Method "POST" -Url "$baseUrl/v1/memories" `
    -Headers @{ "content-type" = "application/json"; "x-api-key" = $apiKey } `
    -JsonBody '{"user_id":"smoke-user","text":"hello from smoke test memory"}'
  if (-not $memoryResp.json) { throw "memory response not JSON: $($memoryResp.raw.Substring(0,[Math]::Min(400,$memoryResp.raw.Length)))" }
  if (-not $memoryResp.json.memory_id) { throw "memory_id missing: $($memoryResp.raw.Substring(0,[Math]::Min(400,$memoryResp.raw.Length)))" }
  Write-Host ("memory response: {0}" -f ($memoryResp.json | ConvertTo-Json -Depth 5))

  Write-Host "Searching..."
  $searchResp = Invoke-CurlJson -Method "POST" -Url "$baseUrl/v1/search" `
    -Headers @{ "content-type" = "application/json"; "x-api-key" = $apiKey } `
    -JsonBody '{"user_id":"smoke-user","query":"hello"}'
  if (-not $searchResp.json) { throw "search response not JSON: $($searchResp.raw.Substring(0,[Math]::Min(400,$searchResp.raw.Length)))" }
  if (-not $searchResp.json.results) { throw "search results missing: $($searchResp.raw.Substring(0,[Math]::Min(400,$searchResp.raw.Length)))" }
  Write-Host ("results count: {0}" -f $searchResp.json.results.Count)
  if ($searchResp.json.results.Count -gt 0) {
    $top = $searchResp.json.results[0]
    Write-Host ("top result chunk_id={0} score={1}" -f ($top.chunk_id ?? "n/a"), ($top.score ?? "n/a"))
  }
  Write-Host ("search response: {0}" -f ($searchResp.json | ConvertTo-Json -Depth 5))

  Write-Host "Context..."
  $contextResp = Invoke-CurlJson -Method "POST" -Url "$baseUrl/v1/context" `
    -Headers @{ "content-type" = "application/json"; "x-api-key" = $apiKey } `
    -JsonBody '{"user_id":"smoke-user","query":"hello"}'
  if (-not $contextResp.json) { throw "context response not JSON: $($contextResp.raw.Substring(0,[Math]::Min(400,$contextResp.raw.Length)))" }
  if (-not $contextResp.json.context_text -or ($contextResp.json.context_text -as [string]).Trim().Length -eq 0) { throw "context_text empty: $($contextResp.raw.Substring(0,[Math]::Min(400,$contextResp.raw.Length)))" }
  Write-Host ("context length: {0}" -f (($contextResp.json.context_text -as [string]).Length))
  if ($contextResp.json.citations -and -not ($contextResp.json.citations -is [System.Collections.IEnumerable])) { throw "citations not array: $($contextResp.raw.Substring(0,[Math]::Min(400,$contextResp.raw.Length)))" }
  Write-Host ("context response: {0}" -f ($contextResp.json | ConvertTo-Json -Depth 5))

  Write-Host ("Summary: healthz ok, workspace created ({0}), api key created, memories ok, search ok, context ok." -f $workspaceId)
  Write-Host ("wrangler log: {0}" -f $logFile)
}
catch {
  Write-Host "error: smoke test failed. Wrangler log tail:"
  if (Test-Path $logFile) { Get-Content $logFile -Tail 80 }
  if (Test-Path $errLogFile) { Write-Host "stderr tail:"; Get-Content $errLogFile -Tail 40 }
  Write-Host ("wrangler logs: {0} (stdout), {1} (stderr)" -f $logFile, $errLogFile)
  Write-Host "exception detail:"
  $_ | Format-List * -Force
  throw
}
finally {
  if ($wrangler -and -not $wrangler.HasExited) {
    Stop-Process -Id $wrangler.Id -Force -ErrorAction SilentlyContinue
    # best-effort kill children
    try {
      $children = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentId -eq $wrangler.Id }
      if ($children) { $children | Stop-Process -Force -ErrorAction SilentlyContinue }
    } catch {}
    $wrangler.WaitForExit()
  }
  if (Test-Path $pidFile) { Remove-Item $pidFile -ErrorAction SilentlyContinue }
  if ($smokeMode -eq "ci" -and (Test-Path $devVarsBackup)) {
    Move-Item -Force $devVarsBackup $devVars -ErrorAction SilentlyContinue
  }
}

#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:Wrangler = $null
$script:Root = Split-Path -Parent $PSScriptRoot
$script:RunId = [Guid]::NewGuid().ToString("N")
$script:Log = Join-Path $script:Root ".tmp\e2e_smoke_$($script:RunId).log"
$script:ErrLog = Join-Path $script:Root ".tmp\e2e_smoke_$($script:RunId).err.log"
$script:BaseUrl = ""
$script:CurlExe = ""

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )
  return [Environment]::GetEnvironmentVariable($Name)
}

function Import-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return
  }

  foreach ($rawLine in Get-Content $Path) {
    $line = $rawLine.Trim()
    if ($line -and -not $line.StartsWith("#")) {
      $eq = $line.IndexOf("=")
      if ($eq -gt 0) {
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1)
        $existing = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($existing)) {
          [Environment]::SetEnvironmentVariable($name, $value)
        }
      }
    }
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter()]
    [string[]]$Arguments = @()
  )

  $display = Format-CommandForLog -FilePath $FilePath -Arguments $Arguments
  Write-Host ">> $display"
  & $FilePath @Arguments
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -ne 0) {
    throw "Command failed ($exitCode): $display"
  }
}

function Cleanup {
  if ($null -ne $script:Wrangler) {
    try {
      & taskkill /PID $script:Wrangler.Id /T /F *> $null
    } catch {
      # best-effort cleanup
    }
  }
}

function Tail-Logs {
  if (Test-Path $script:Log) {
    try {
      Get-Content $script:Log -Tail 200
    } catch {
      Write-Host "(unable to read log file: $script:Log)"
    }
  }
  if (Test-Path $script:ErrLog) {
    try {
      Get-Content $script:ErrLog -Tail 200
    } catch {
      Write-Host "(unable to read log file: $script:ErrLog)"
    }
  }
}

function Redact-Headers {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text
  )
  $lines = $Text -split "\r?\n"
  $masked = foreach ($line in $lines) { Mask-HeaderValue -Header $line }
  return ($masked -join [Environment]::NewLine)
}

function Mask-SecretValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )
  return "***redacted***"
}

function Get-SensitiveValues {
  $values = New-Object System.Collections.Generic.List[string]
  foreach ($item in Get-ChildItem Env:) {
    if ($item.Name -match '(?i)(token|key|cookie|authorization)' -and -not [string]::IsNullOrWhiteSpace($item.Value)) {
      if ($item.Value.Length -ge 4) {
        [void]$values.Add($item.Value)
      }
    }
  }
  return $values | Sort-Object Length -Descending -Unique
}

function Mask-ArgumentValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )
  $masked = $Value
  foreach ($secret in Get-SensitiveValues) {
    if (-not [string]::IsNullOrEmpty($secret)) {
      $masked = $masked.Replace($secret, (Mask-SecretValue -Value $secret))
    }
  }
  return $masked
}

function Is-SensitiveHeaderName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )
  $n = $Name.Trim().ToLowerInvariant()
  if ($n -eq "authorization" -or $n -eq "cookie") { return $true }
  return ($n -like "*token*" -or $n -like "*key*")
}

function Mask-HeaderValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Header
  )
  $line = $Header.TrimEnd()
  $pair = [System.Text.RegularExpressions.Regex]::Match($line, '^\s*([^:]+)\s*:\s*(.*)$')
  if (-not $pair.Success) {
    return Mask-ArgumentValue -Value $line
  }

  $name = $pair.Groups[1].Value.Trim()
  $value = $pair.Groups[2].Value
  if (Is-SensitiveHeaderName -Name $name) {
    if ($name -match '(?i)^authorization$' -and $value -match '^(?i)\s*bearer\s+') {
      return "$($name): Bearer $(Mask-SecretValue -Value $value)"
    }
    return "$($name): $(Mask-SecretValue -Value $value)"
  }

  return "$($name): $(Mask-ArgumentValue -Value $value)"
}

function Format-CommandForLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter()]
    [string[]]$Arguments = @()
  )
  if ($Arguments.Count -eq 0) {
    return $FilePath
  }

  $safeArgs = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $arg = $Arguments[$i]
    if (($arg -eq "-H" -or $arg -eq "--header") -and ($i + 1) -lt $Arguments.Count) {
      $safeArgs.Add($arg)
      $safeArgs.Add((Mask-HeaderValue -Header $Arguments[$i + 1]))
      $i++
      continue
    }
    $safeArgs.Add((Mask-ArgumentValue -Value $arg))
  }
  return "$FilePath $($safeArgs -join ' ')"
}

function Get-StatusCodeFromHeaders {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HeaderFile
  )

  $statusLine = Get-Content $HeaderFile | Where-Object { $_ -match "^HTTP/" } | Select-Object -Last 1
  if (-not $statusLine) {
    throw "Unable to parse HTTP status from headers file"
  }
  $parts = $statusLine -split "\s+"
  if ($parts.Length -lt 2) {
    throw "Malformed HTTP status line: $statusLine"
  }
  return [int]$parts[1]
}

function Invoke-MaskSelfTest {
  $sampleBearer = "mn_live_SAMPLE_TOKEN_NOT_REAL"
  $sampleApiKey = "mn_live_TEST_TOKEN_DO_NOT_USE"
  $sampleCookie = "session=mn_live_COOKIE_DO_NOT_USE"
  $sampleToken = "x-session-token: mn_live_HEADER_TOKEN_DO_NOT_USE"
  $env:E2E_PREVIEW_SELFTEST_KEY = $sampleApiKey
  $preview = Format-CommandForLog -FilePath "curl.exe" -Arguments @(
    "-sS",
    "-H", "Authorization: Bearer $sampleBearer",
    "-H", "x-api-key: $sampleApiKey",
    "-H", "cookie: $sampleCookie",
    "-H", $sampleToken,
    "https://example.test/healthz?access_key=$sampleApiKey"
  )
  Write-Host $preview

  $headerDump = @(
    "HTTP/1.1 401 Unauthorized",
    "Authorization: Bearer $sampleBearer",
    "x-api-key: $sampleApiKey",
    "cookie: $sampleCookie",
    $sampleToken
  ) -join "`n"
  $maskedDump = Redact-Headers -Text $headerDump
  Write-Host $maskedDump

  if ($preview -match 'mn_live_[A-Za-z0-9_-]{10,}') {
    throw "Mask self-test failed: secret leaked in command preview"
  }
  if ($maskedDump -match 'mn_live_[A-Za-z0-9_-]{10,}') {
    throw "Mask self-test failed: secret leaked in header redaction"
  }
  Remove-Item Env:E2E_PREVIEW_SELFTEST_KEY -ErrorAction SilentlyContinue
}

function Call-Health {
  $headerFile = [System.IO.Path]::GetTempFileName()
  $bodyFile = [System.IO.Path]::GetTempFileName()

  try {
    Write-Host "-> GET /healthz"
    $args = @("-sS", "-D", $headerFile, "-o", $bodyFile, "$script:BaseUrl/healthz")
    Invoke-Checked -FilePath $script:CurlExe -Arguments $args
    $status = Get-StatusCodeFromHeaders -HeaderFile $headerFile
    if ($status -ne 200) {
      Write-Host "Expected 200 got $status for /healthz"
      Write-Host "Headers:"
      Write-Host (Redact-Headers -Text (Get-Content $headerFile -Raw))
      Write-Host "Body:"
      Write-Host (Get-Content $bodyFile -Raw)
      throw "GET /healthz failed"
    }
  } finally {
    Remove-Item $headerFile, $bodyFile -ErrorAction SilentlyContinue
  }
}

function Call-Api {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [int]$ExpectedStatus,
    [Parameter()]
    [string]$Body = "",
    [Parameter()]
    [string]$AssertProp = ""
  )

  $headerFile = [System.IO.Path]::GetTempFileName()
  $bodyFile = [System.IO.Path]::GetTempFileName()

  try {
    Write-Host "-> $Method $Path"
    $args = @(
      "-sS",
      "-D", $headerFile,
      "-o", $bodyFile,
      "-X", $Method,
      "$script:BaseUrl$Path",
      "-H", "Authorization: Bearer $($env:E2E_API_KEY)"
    )
    if (-not [string]::IsNullOrEmpty($Body)) {
      $args += @("-H", "Content-Type: application/json", "--data", $Body)
    }
    Invoke-Checked -FilePath $script:CurlExe -Arguments $args

    $status = Get-StatusCodeFromHeaders -HeaderFile $headerFile
    if ($status -ne $ExpectedStatus) {
      Write-Host "Expected $ExpectedStatus got $status"
      Write-Host "Headers:"
      Write-Host (Redact-Headers -Text (Get-Content $headerFile -Raw))
      Write-Host "Body:"
      Write-Host (Get-Content $bodyFile -Raw)
      throw "Unexpected status for $Method $Path"
    }

    if (-not [string]::IsNullOrEmpty($AssertProp)) {
      $json = Get-Content $bodyFile -Raw | ConvertFrom-Json
      if (-not ($json.PSObject.Properties.Name -contains $AssertProp)) {
        throw "Validation failed: missing property $AssertProp"
      }
      if ($null -eq $json.$AssertProp) {
        throw "Validation failed: property $AssertProp is null"
      }
    }
  } finally {
    Remove-Item $headerFile, $bodyFile -ErrorAction SilentlyContinue
  }
}

function Bootstrap-LocalApiKey {
  $headerFile = [System.IO.Path]::GetTempFileName()
  $bodyFile = [System.IO.Path]::GetTempFileName()

  try {
    Write-Host "Bootstrapping local E2E API key via admin endpoints..."
    $workspaceArgs = @(
      "-sS",
      "-D", $headerFile,
      "-o", $bodyFile,
      "-X", "POST",
      "$script:BaseUrl/v1/workspaces",
      "-H", "x-admin-token: $($env:MASTER_ADMIN_TOKEN)",
      "-H", "Content-Type: application/json",
      "--data", '{"name":"E2E Smoke Workspace"}'
    )
    Invoke-Checked -FilePath $script:CurlExe -Arguments $workspaceArgs
    $workspaceStatus = Get-StatusCodeFromHeaders -HeaderFile $headerFile
    if ($workspaceStatus -ne 200) {
      Write-Host "Workspace bootstrap expected 200 got $workspaceStatus"
      Write-Host "Headers:"
      Write-Host (Redact-Headers -Text (Get-Content $headerFile -Raw))
      Write-Host "Body:"
      Write-Host (Get-Content $bodyFile -Raw)
      throw "Workspace bootstrap failed"
    }
    $workspaceJson = Get-Content $bodyFile -Raw | ConvertFrom-Json
    $workspaceId = "$($workspaceJson.workspace_id)"
    if ([string]::IsNullOrWhiteSpace($workspaceId)) {
      throw "Workspace bootstrap did not return workspace_id"
    }

    Set-Content -Path $headerFile -Value ""
    Set-Content -Path $bodyFile -Value ""
    $apiKeyBody = @{ workspace_id = $workspaceId; name = "e2e-smoke" } | ConvertTo-Json -Compress
    $keyArgs = @(
      "-sS",
      "-D", $headerFile,
      "-o", $bodyFile,
      "-X", "POST",
      "$script:BaseUrl/v1/api-keys",
      "-H", "x-admin-token: $($env:MASTER_ADMIN_TOKEN)",
      "-H", "Content-Type: application/json",
      "--data", $apiKeyBody
    )
    Invoke-Checked -FilePath $script:CurlExe -Arguments $keyArgs
    $keyStatus = Get-StatusCodeFromHeaders -HeaderFile $headerFile
    if ($keyStatus -ne 200) {
      Write-Host "API key bootstrap expected 200 got $keyStatus"
      Write-Host "Headers:"
      Write-Host (Redact-Headers -Text (Get-Content $headerFile -Raw))
      Write-Host "Body:"
      Write-Host (Get-Content $bodyFile -Raw)
      throw "API key bootstrap failed"
    }
    $keyJson = Get-Content $bodyFile -Raw | ConvertFrom-Json
    $apiKey = "$($keyJson.api_key)"
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
      throw "API key bootstrap did not return api_key"
    }
    $env:E2E_API_KEY = $apiKey
  } finally {
    Remove-Item $headerFile, $bodyFile -ErrorAction SilentlyContinue
  }
}

try {
  if ((Get-EnvValue -Name "E2E_MASK_SELF_TEST") -eq "1") {
    Invoke-MaskSelfTest
    exit 0
  }

  Set-Location $script:Root
  if (-not (Test-Path ".tmp")) {
    New-Item -ItemType Directory ".tmp" | Out-Null
  }
  Set-Content -Path $script:Log -Value ""
  Set-Content -Path $script:ErrLog -Value ""

  Import-DotEnv -Path (Join-Path $script:Root ".env.e2e")

  if ([string]::IsNullOrWhiteSpace($env:E2E_API_KEY) -and -not [string]::IsNullOrWhiteSpace($env:MEMORYNODE_API_KEY)) {
    $env:E2E_API_KEY = $env:MEMORYNODE_API_KEY
  }

  if ([string]::IsNullOrWhiteSpace($env:BASE_URL)) {
    $script:BaseUrl = "http://127.0.0.1:8787"
  } else {
    $script:BaseUrl = $env:BASE_URL
  }

  $isLocal = $script:BaseUrl -match "^http://(127\.0\.0\.1|localhost):"
  if (-not $isLocal -and [string]::IsNullOrWhiteSpace($env:E2E_API_KEY)) {
    throw "Missing required env vars for remote mode: BASE_URL + E2E_API_KEY (or MEMORYNODE_API_KEY)"
  }

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    $script:CurlExe = "curl.exe"
  } elseif (Get-Command curl -CommandType Application -ErrorAction SilentlyContinue) {
    $script:CurlExe = "curl"
  } else {
    throw "curl executable not found in PATH"
  }

  if ($isLocal) {
    $localVarsPath = Get-EnvValue -Name "E2E_LOCAL_VARS_FILE"
    if ([string]::IsNullOrWhiteSpace($localVarsPath)) {
      $localVarsPath = Join-Path $script:Root "apps/api/.dev.vars"
    }
    if (Test-Path $localVarsPath) {
      Import-DotEnv -Path $localVarsPath
    } else {
      Write-Host "Local vars file not found at $localVarsPath. Load vars and rerun: Get-Content apps/api/.dev.vars | % { if (`$_ -and -not `$_.StartsWith('#') -and `$_.Contains('=')) { `$n,`$v = `$_.Split('=',2); Set-Item Env:`$n `$v } }; pnpm e2e:verify"
    }

    $requiredLocal = @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "API_KEY_SALT")
    if ([string]::IsNullOrWhiteSpace($env:E2E_API_KEY)) {
      $requiredLocal += "MASTER_ADMIN_TOKEN"
    }
    $missing = @()
    foreach ($name in $requiredLocal) {
      if ([string]::IsNullOrWhiteSpace((Get-EnvValue -Name $name))) {
        $missing += $name
      }
    }
    if ($missing.Count -gt 0) {
      throw "Missing required env vars for local dev smoke: $($missing -join ', ')"
    }

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ($listener.LocalEndpoint).Port
    $listener.Stop()

    $env:PORT = "$port"
    if ([string]::IsNullOrWhiteSpace($env:EMBEDDINGS_MODE)) {
      $env:EMBEDDINGS_MODE = "stub"
    }

    $wranglerToml = Join-Path $script:Root "apps/api/wrangler.toml"
    if (-not (Test-Path $wranglerToml)) {
      throw "ERROR: wrangler.toml not found at $wranglerToml"
    }
    if (-not (Select-String -Path $wranglerToml -Pattern "durable_objects" -Quiet)) {
      throw "ERROR: wrangler.toml is missing durable_objects section (expected RATE_LIMIT_DO)"
    }
    if (-not (Select-String -Path $wranglerToml -Pattern '(binding|name)\s*=\s*"RATE_LIMIT_DO"' -Quiet)) {
      throw "ERROR: wrangler.toml is missing durable_objects binding/name RATE_LIMIT_DO"
    }

    Write-Host "Starting API dev server on port $port..."
    $script:Wrangler = Start-Process -FilePath "pnpm.cmd" `
      -ArgumentList @("--filter", "@memorynode/api", "exec", "wrangler", "dev", "--port", "$port", "--log-level", "error") `
      -WorkingDirectory $script:Root `
      -RedirectStandardOutput $script:Log `
      -RedirectStandardError $script:ErrLog `
      -PassThru
    Start-Sleep -Milliseconds 500

    if ($script:Wrangler.HasExited -and $script:Wrangler.ExitCode -ne 0) {
      Tail-Logs
      throw "wrangler dev exited early with code $($script:Wrangler.ExitCode)"
    }

    Write-Host -NoNewline "Waiting for /healthz"
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
      if ($script:Wrangler.HasExited) {
        Write-Host " failed"
        Tail-Logs
        throw "wrangler dev exited before healthz was ready"
      }
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -Method Get -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
          $healthy = $true
          break
        }
      } catch {
        # retry
      }
      Write-Host -NoNewline "."
      Start-Sleep -Seconds 1
    }

    if (-not $healthy) {
      Write-Host " failed"
      Tail-Logs
      throw "healthz not ready"
    }
    Write-Host " ok"

    $script:BaseUrl = "http://127.0.0.1:$port"
    Write-Host "Base URL (local dev): $script:BaseUrl"
    if ([string]::IsNullOrWhiteSpace($env:E2E_API_KEY)) {
      Bootstrap-LocalApiKey
    }
  } else {
    Write-Host "Base URL (remote): $script:BaseUrl"
  }

  Call-Health
  Call-Api -Method "POST" -Path "/v1/memories" -ExpectedStatus 200 -Body '{"user_id":"e2e-user","text":"hello e2e memory","namespace":"e2e"}' -AssertProp "memory_id"
  Call-Api -Method "POST" -Path "/v1/search" -ExpectedStatus 200 -Body '{"user_id":"e2e-user","namespace":"e2e","query":"hello","top_k":3}' -AssertProp "results"
  Call-Api -Method "POST" -Path "/v1/context" -ExpectedStatus 200 -Body '{"user_id":"e2e-user","namespace":"e2e","query":"hello"}' -AssertProp "context_text"
  Call-Api -Method "GET" -Path "/v1/usage/today" -ExpectedStatus 200 -AssertProp "day"

  Write-Host "E2E smoke passed."
  exit 0
} catch {
  $msg = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { $_ | Out-String }
  [Console]::Error.WriteLine("E2E smoke failed: $msg")
  Cleanup
  Tail-Logs
  exit 1
} finally {
  Cleanup
}

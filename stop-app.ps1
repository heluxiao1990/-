$ErrorActionPreference = "SilentlyContinue"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $Root ".env"

function Get-LocalConfigValue($Name, $DefaultValue) {
  if (-not (Test-Path $EnvPath)) {
    return $DefaultValue
  }

  foreach ($line in Get-Content -Path $EnvPath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $parts = $trimmed.Split("=", 2)
    if ($parts.Count -ne 2 -or $parts[0].Trim() -ne $Name) {
      continue
    }

    return $parts[1].Trim().Trim('"').Trim("'")
  }

  return $DefaultValue
}

function Test-AssistantServer($Port) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1
    $serverRoot = [System.IO.Path]::GetFullPath([string]$health.root).TrimEnd("\", "/")
    $localRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\", "/")
    return $health.app -eq "english-reading-assistant" -and $serverRoot -eq $localRoot
  } catch {
    return $false
  }
}

$PreferredPort = [int](Get-LocalConfigValue "PORT" "5173")
$connections = for ($port = $PreferredPort; $port -lt $PreferredPort + 20; $port += 1) {
  if (Test-AssistantServer $port) {
    Get-NetTCPConnection -LocalPort $port -State Listen
  }
}

foreach ($connection in $connections) {
  $process = Get-Process -Id $connection.OwningProcess
  if ($process.ProcessName -eq "node") {
    Stop-Process -Id $process.Id
  }
}

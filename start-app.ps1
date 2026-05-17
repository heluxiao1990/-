$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $Root ".env"
$LogDir = Join-Path $Root "logs"

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

function Show-Message($Text, $Title = "English Reading Assistant", $Icon = 64) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $null = $shell.Popup($Text, 0, $Title, $Icon)
  } catch {
    Write-Host $Text
  }
}

function Test-LocalPort($Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", [int]$Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(300)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
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

function Stop-AssistantServers($PreferredPort) {
  for ($port = [int]$PreferredPort; $port -lt [int]$PreferredPort + 20; $port += 1) {
    if (-not (Test-AssistantServer $port)) {
      continue
    }

    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
      if ($process -and $process.ProcessName -eq "node") {
        Stop-Process -Id $process.Id -Force
      }
    }
  }
}

function Get-AssistantPort($PreferredPort) {
  $candidate = [int]$PreferredPort
  for ($i = 0; $i -lt 20; $i += 1) {
    if (-not (Test-LocalPort $candidate)) {
      return $candidate
    }

    if (Test-AssistantServer $candidate) {
      return $candidate
    }

    $candidate += 1
  }

  throw "Could not find an available local port near $PreferredPort."
}

$PreferredPort = [int](Get-LocalConfigValue "PORT" "5173")
Stop-AssistantServers $PreferredPort
Start-Sleep -Milliseconds 300

$Port = Get-AssistantPort $PreferredPort
$Url = "http://127.0.0.1:$Port"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Show-Message "Node.js was not found. Please install Node.js 20 or newer first." "English Reading Assistant" 48
  exit 1
}

if (-not (Test-AssistantServer $Port)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $outLog = Join-Path $LogDir "server.out.log"
  $errLog = Join-Path $LogDir "server.err.log"
  $node = (Get-Command node).Source

  $env:PORT = $Port
  Start-Process -FilePath $node `
    -ArgumentList @("server.js") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog | Out-Null

  for ($i = 0; $i -lt 40; $i += 1) {
    if (Test-AssistantServer $Port) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
}

if (Test-AssistantServer $Port) {
  Start-Process $Url
} else {
  Show-Message "The local server did not start. Check logs/server.err.log for details." "English Reading Assistant" 48
}

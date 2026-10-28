# Shared helpers for the Tula Windows scripts. Dot-source it:  . "$PSScriptRoot\common.ps1"
# Written for Windows PowerShell 5.1 (built into Windows 10/11): no PowerShell 7-only syntax.
# Keep this file ASCII.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:TaskName    = 'Tula'
$script:RuleName    = 'Tula-Billing-TCP'
$script:ShortcutName = 'Tula Billing'
if (-not (Get-Variable -Name DryRun -Scope Script -ErrorAction SilentlyContinue)) { $script:DryRun = $false }

function Say([string]$msg)  { Write-Host $msg }
function Ok([string]$msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Step([string]$msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Fail([string]$msg) { Write-Host ""; Write-Host "STOPPED: $msg" -ForegroundColor Red; exit 1 }

# Every change to the computer goes through here, so -DryRun shows the plan without doing it.
function Invoke-Step([string]$what, [scriptblock]$action) {
    if ($script:DryRun) { Write-Host "  [dry-run] $what" -ForegroundColor DarkGray; return $null }
    return & $action
}

function Test-Admin {
    if ($script:DryRun) { return $true }
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
    if (-not (Test-Admin)) {
        Fail 'Please run this as Administrator: right-click PowerShell, choose "Run as administrator", then run the command again.'
    }
}

# Reload PATH from the registry (after installing Node.js in this same window).
function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# Full path of node.exe, or $null.
function Find-Node {
    $candidates = @()
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }  # lets -DryRun work off Windows
    if ($cmd) { $candidates += $cmd.Source }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Get-NodeMajor([string]$node) {
    $v = & $node --version 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

function Find-Npm([string]$node) {
    $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
    if (Test-Path $npm) { return $npm }
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# Run one of Tula's Node command-line tools (apps\server\src\cli\<name>.ts) from the app folder.
function Invoke-TulaCli([string]$appDir, [string]$node, [string]$envFile, [string]$name, [string[]]$cliArgs) {
    $script = Join-Path $appDir "apps\server\src\cli\$name.ts"
    Push-Location $appDir
    try {
        & $node --import tsx $script --env-file $envFile @cliArgs | Out-Host
        return $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

# Read KEY=VALUE pairs from tula.env (never print the values of *TOKEN* keys).
function Read-TulaEnv([string]$envFile) {
    $h = @{}
    if (-not (Test-Path $envFile)) { return $h }
    foreach ($line in Get-Content $envFile) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -gt 0) { $h[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"') }
    }
    return $h
}

function Get-TulaPort([string]$envFile) {
    $e = Read-TulaEnv $envFile
    if ($e.ContainsKey('TULA_PORT') -and $e['TULA_PORT']) { return [int]$e['TULA_PORT'] }
    return 5000
}

function Test-TulaHealth([int]$port) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/api/health"
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Wait-TulaHealth([int]$port, [int]$seconds) {
    $until = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $until) {
        if (Test-TulaHealth $port) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

# Stop the scheduled task and make sure the supervisor and server are gone.
function Stop-Tula([string]$dataDir) {
    Invoke-Step "Stop scheduled task '$script:TaskName'" {
        $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        if ($t) { Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue }
    } | Out-Null
    $lock = Join-Path $dataDir 'tula-supervisor.lock'
    Invoke-Step 'Wait for Tula to stop (up to 20 s)' {
        for ($i = 0; $i -lt 20; $i++) {
            if (-not (Test-Path $lock)) { break }
            Start-Sleep -Seconds 1
        }
        if (Test-Path $lock) {
            # The task was ended but a process is left over (or the lock is stale): stop it by its PID.
            try {
                $info = Get-Content $lock -Raw | ConvertFrom-Json
                $p = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
                if ($p -and $p.ProcessName -eq 'node') {
                    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($info.pid)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                    Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue
                }
            } catch { }
            Remove-Item $lock -Force -ErrorAction SilentlyContinue
        }
    } | Out-Null
}

function Start-Tula {
    Invoke-Step "Start scheduled task '$script:TaskName'" { Start-ScheduledTask -TaskName $script:TaskName } | Out-Null
}

# Gives a folder exactly these grants and makes everything inside inherit them.
# The grants carry (OI)(CI) flags, which icacls refuses on files, so they are set on the folder only;
# applying them with /T after /inheritance:r would leave every file with an empty ACL (no access at all).
function Set-FolderAcl([string]$path, [string[]]$grants) {
    & icacls $path /inheritance:r /grant:r @grants /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "Setting permissions on $path failed (icacls code $LASTEXITCODE)." }
    if (Get-ChildItem -LiteralPath $path -Force | Select-Object -First 1) {
        & icacls (Join-Path $path '*') /reset /T /C /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "Resetting permissions inside $path failed (icacls code $LASTEXITCODE)." }
    }
}

# Version of the Tula app in a folder, or 'unknown'.
function Get-AppVersion([string]$appDir) {
    try {
        $j = Get-Content (Join-Path $appDir 'apps\server\package.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($j.PSObject.Properties['version']) { return [string]$j.version }
    } catch { }
    return 'unknown'
}

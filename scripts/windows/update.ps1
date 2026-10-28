<#
.SYNOPSIS
  Updates Tula to a new version, with a backup first and an automatic roll-back if the new version does not start.

.DESCRIPTION
  From a new Tula folder or zip:
      powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\update.ps1 -From D:\Downloads\tula-1.2.zip
  Or, when C:\Tula\app is a git clone:
      powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\update.ps1 -GitPull

  Steps: stop Tula -> safety backup of the data -> keep the current app as C:\Tula\app.previous ->
  put the new files in place -> npm ci -> build the web app -> start -> wait up to 3 minutes for it to answer.
  If anything fails, the previous app files are put back and started again.
  The data folder is never touched (the new version may upgrade the database when it starts;
  the safety backup taken here is the way back if ever needed).

  Tip: copy this script somewhere else first (e.g. C:\Tula\update.ps1) is NOT needed: PowerShell reads the
  whole script before it runs, so replacing the app folder underneath it is safe.
#>
param(
    [string]$From = '',
    [switch]$GitPull,
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData',
    [switch]$DryRun
)
. "$PSScriptRoot\common.ps1"
$script:DryRun = [bool]$DryRun
Assert-Admin

if (-not $From -and -not $GitPull) { Fail 'Say where the new version is: -From <folder or .zip>, or -GitPull.' }
$envFile = Join-Path $DataDir 'tula.env'
$port = Get-TulaPort $envFile
$previous = "$AppDir.previous"
$node = Find-Node
if (-not $node) { Fail 'Node.js not found.' }
$npm = Find-Npm $node
if (-not $npm -and -not $script:DryRun) { Fail 'npm not found.' }

# ----- where the new files come from
$newSource = $null
$tempUnzip = $null
if ($From) {
    if (-not (Test-Path $From)) { Fail "Not found: $From" }
    if ($From -match '\.zip$') {
        $tempUnzip = Join-Path $env:TEMP ("tula-update-" + [Guid]::NewGuid().ToString('N'))
        Invoke-Step "Unpack $From" { Expand-Archive -Path $From -DestinationPath $tempUnzip -Force } | Out-Null
        # The zip may contain the files directly or inside one top folder.
        $newSource = $tempUnzip
        if (-not $script:DryRun) {
            $inner = Get-ChildItem $tempUnzip -Directory
            if (-not (Test-Path (Join-Path $tempUnzip 'apps')) -and $inner.Count -eq 1) { $newSource = $inner[0].FullName }
        }
    } else {
        $newSource = (Resolve-Path $From).Path
    }
    if (-not $script:DryRun -and -not (Test-Path (Join-Path $newSource 'apps\server\src\supervisor.ts'))) { Fail "$From does not contain Tula." }
}

$oldVersion = Get-AppVersion $AppDir
Say "Current version: $oldVersion"

Step '1. Stop Tula'
Stop-Tula $DataDir

Step '2. Safety backup of the data'
Invoke-Step 'Backup (kind: safety) into C:\TulaData\backups' {
    $c = Invoke-TulaCli $AppDir $node $envFile 'backup' @('--kind', 'safety')
    if ($c -ne 0) { Start-Tula; Fail 'The backup failed, so nothing was updated. Tula was started again.' }
} | Out-Null

function Restore-Previous([string]$why) {
    Warn "$why Putting the previous version back."
    Stop-Tula $DataDir
    if ($GitPull) {
        Invoke-Step "git reset to $script:oldCommit, npm ci, build" {
            Push-Location $AppDir
            try {
                & git reset --hard $script:oldCommit
                & $npm ci --no-audit --no-fund
                & $npm run build -w apps/web
            } finally { Pop-Location }
        } | Out-Null
    } else {
        Invoke-Step "Move $previous back to $AppDir" {
            Set-Location $env:SystemRoot
            if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
            Move-Item $previous $AppDir
        } | Out-Null
    }
    Start-Tula
    if (-not $script:DryRun -and (Wait-TulaHealth $port 180)) { Ok 'The previous version is running again.' }
    else { Warn 'The previous version did not answer either. Run status.ps1 and look at the logs.' }
    exit 1
}

Step '3. New files'
$script:oldCommit = ''
if ($GitPull) {
    Push-Location $AppDir
    try {
        $script:oldCommit = (& git rev-parse HEAD).Trim()
        Invoke-Step 'git pull --ff-only' {
            & git pull --ff-only
            if ($LASTEXITCODE -ne 0) { Start-Tula; Fail 'git pull failed; nothing changed. Tula was started again.' }
        } | Out-Null
    } finally { Pop-Location }
} else {
    Invoke-Step "Keep current app as $previous, copy the new files to $AppDir" {
        Set-Location $env:SystemRoot
        if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
        Move-Item $AppDir $previous
        New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        & robocopy $newSource $AppDir /MIR /XD node_modules .git data dist android profiles /XF *.db *.db-wal *.db-shm tula.env *.profile.json /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Restore-Previous "Copying the new files failed (robocopy code $LASTEXITCODE)." }
    } | Out-Null
}

Step '4. Packages and web app'
$script:buildError = ''
Invoke-Step 'npm ci; npm run build -w apps/web' {
    Push-Location $AppDir
    try {
        & $npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { $script:buildError = 'Installing packages failed.' }
        else {
            & $npm run build -w apps/web
            if ($LASTEXITCODE -ne 0) { $script:buildError = 'Building the web app failed.' }
        }
    } finally { Pop-Location }
} | Out-Null
if ($script:buildError) { Restore-Previous $script:buildError }

Step '5. Start and check'
Start-Tula
if ($script:DryRun) { Ok 'Dry run finished.'; exit 0 }
if (-not (Wait-TulaHealth $port 180)) { Restore-Previous 'The new version did not answer within 3 minutes.' }
$newVersion = Get-AppVersion $AppDir
Ok "Tula $newVersion is running (was $oldVersion)."
if ($tempUnzip) { Remove-Item $tempUnzip -Recurse -Force -ErrorAction SilentlyContinue }
Say "The previous version is kept in $previous until the next update."

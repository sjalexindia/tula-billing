<#
.SYNOPSIS
  Restores a backup file: stops Tula, checks the backup, saves a safety copy of the current data,
  swaps the backup in, and starts Tula again. (Owners can also restore from the Backup screen.)
  powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\restore.ps1 -File "E:\Tula backups\tula-2026-10-25-2100.db"
#>
param(
    [Parameter(Mandatory = $true)][string]$File,
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData',
    [switch]$Yes,
    [switch]$DryRun
)
. "$PSScriptRoot\common.ps1"
$script:DryRun = [bool]$DryRun
Assert-Admin
$envFile = Join-Path $DataDir 'tula.env'
$node = Find-Node
if (-not $node) { Fail 'Node.js not found.' }
if (-not (Test-Path $File)) { Fail "Backup file not found: $File" }

if (-not $Yes) {
    Say "This replaces ALL current Tula data with the backup $File."
    Say 'Bills made after that backup will be gone (a safety copy of today''s data is kept in C:\TulaData\backups).'
    $ans = Read-Host 'Type RESTORE to continue'
    if ($ans -ne 'RESTORE') { Say 'Nothing changed.'; exit 0 }
}

Step 'Stopping Tula'
Stop-Tula $DataDir
Step 'Restoring'
$code = 0
Invoke-Step "Restore $File" {
    $script:code = Invoke-TulaCli $AppDir $node $envFile 'restore' @($File, '--yes')
} | Out-Null
Step 'Starting Tula'
Start-Tula
if ($script:DryRun) { exit 0 }
if ($script:code -ne 0) { Warn 'The restore did not happen (see above); Tula was started again with the data it had.' ; exit 1 }
if (Wait-TulaHealth (Get-TulaPort $envFile) 120) { Ok 'Restored, and Tula is running.' } else { Warn 'Restored, but Tula did not answer within 2 minutes. Run status.ps1.' }

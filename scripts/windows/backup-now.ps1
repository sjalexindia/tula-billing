<#
.SYNOPSIS
  Makes a backup now (safe while Tula is running), into the backup folder chosen in the app.
  powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\backup-now.ps1
#>
param(
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData'
)
. "$PSScriptRoot\common.ps1"
Assert-Admin
$node = Find-Node
if (-not $node) { Fail 'Node.js not found.' }
$code = Invoke-TulaCli $AppDir $node (Join-Path $DataDir 'tula.env') 'backup' @('--kind', 'manual')
exit $code

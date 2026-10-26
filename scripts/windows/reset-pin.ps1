<#
.SYNOPSIS
  Forgotten PIN: lists people, or gives one person the temporary PIN 1234 (they choose a new one at sign-in).
  powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\reset-pin.ps1 [-Name "Owner"]
#>
param(
    [string]$Name = '',
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData'
)
. "$PSScriptRoot\common.ps1"
Assert-Admin
$node = Find-Node
if (-not $node) { Fail 'Node.js not found.' }
$extra = @()
if ($Name) { $extra = @($Name) }
$code = Invoke-TulaCli $AppDir $node (Join-Path $DataDir 'tula.env') 'reset-pin' $extra
exit $code

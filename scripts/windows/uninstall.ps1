<#
.SYNOPSIS
  Removes Tula from this PC: scheduled task, firewall rule, shortcuts and app files.
  Your data (C:\TulaData: database, backups, logs) is KEPT unless you add -RemoveData.
  powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\uninstall.ps1 [-RemoveData]
#>
param(
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData',
    [switch]$RemoveData,
    [switch]$DryRun
)
. "$PSScriptRoot\common.ps1"
$script:DryRun = [bool]$DryRun
Assert-Admin

Step 'Stopping Tula'
Stop-Tula $DataDir
Invoke-Step "Remove scheduled task '$script:TaskName'" { Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue } | Out-Null
Invoke-Step 'Remove firewall rule' { Get-NetFirewallRule -Name $script:RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule } | Out-Null
foreach ($dir in @((Join-Path $env:PUBLIC 'Desktop'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))) {
    Invoke-Step "Remove shortcuts in $dir" {
        Remove-Item (Join-Path $dir "$($script:ShortcutName).lnk"), (Join-Path $dir "$($script:ShortcutName).url") -ErrorAction SilentlyContinue
    } | Out-Null
}
# This script lives inside the app folder; PowerShell has already read it, so removing the folder is fine.
Invoke-Step "Remove app files $AppDir" {
    Set-Location $env:SystemRoot
    Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "$AppDir.previous" -Recurse -Force -ErrorAction SilentlyContinue
} | Out-Null
Ok 'Tula removed'

if ($RemoveData) {
    Warn "This deletes ${DataDir}: the database, the backups kept on this PC, and the logs."
    Say 'Copies in Google Drive or on a USB drive are not touched.'
    $ans = if ($script:DryRun) { 'DELETE' } else { Read-Host 'Type DELETE to remove the data' }
    if ($ans -eq 'DELETE') {
        Invoke-Step "Remove $DataDir" { Remove-Item $DataDir -Recurse -Force } | Out-Null
        Ok 'Data removed'
    } else { Say 'Data kept.' }
} else {
    Say "Your data is still in $DataDir. Installing Tula again will use it."
}

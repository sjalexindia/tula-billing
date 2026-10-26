<#
.SYNOPSIS
  Shows whether Tula is running, its addresses, and the last backup. -Restart restarts it.
  powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\status.ps1 [-Restart]
#>
param(
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData',
    [switch]$Restart
)
. "$PSScriptRoot\common.ps1"
$envFile = Join-Path $DataDir 'tula.env'
$port = Get-TulaPort $envFile

if ($Restart) {
    Assert-Admin
    Step 'Restarting Tula'
    Stop-Tula $DataDir
    Start-Tula
    if (Wait-TulaHealth $port 120) { Ok 'Tula is running again' } else { Warn 'Tula did not answer within 2 minutes; see the logs below.' }
}

Step 'Scheduled task'
$task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $script:TaskName
    Say "  State:        $($task.State)"
    Say "  Last started: $($info.LastRunTime)   (result code $($info.LastTaskResult); 267009 means still running)"
    Say "  Runs as:      $($task.Principal.UserId)"
} else {
    Warn 'The scheduled task "Tula" is not installed. Run install.ps1.'
}

Step 'Firewall and network'
$rule = Get-NetFirewallRule -Name $script:RuleName -ErrorAction SilentlyContinue
if ($rule) { Ok "Firewall rule present (port $port, $($rule.Profile) networks)" } else { Warn 'Firewall rule missing: phones cannot connect. Run install.ps1 again.' }
foreach ($p in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue)) {
    if ($p.NetworkCategory -eq 'Public') { Warn "Network '$($p.Name)' is Public: phones cannot connect. Make it Private (install.ps1 -SetNetworkPrivate)." }
    else { Ok "Network '$($p.Name)' is $($p.NetworkCategory)" }
}

Step 'Tula'
$node = Find-Node
if (-not $node) { Fail 'Node.js not found.' }
$null = Invoke-TulaCli $AppDir $node $envFile 'status' @()
$logs = Join-Path $DataDir 'logs'
$latest = Get-ChildItem $logs -Filter 'tula-*.log' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($latest) {
    Step "Last lines of $($latest.FullName)"
    Get-Content $latest.FullName -Tail 15 | ForEach-Object { Say "  $_" }
}

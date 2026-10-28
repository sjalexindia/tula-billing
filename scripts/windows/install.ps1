<#
.SYNOPSIS
  Installs Tula on this Windows PC so it starts by itself whenever the PC is switched on.

.DESCRIPTION
  Run as Administrator from the unpacked Tula folder:
      powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1

  Safe to run again (it updates what is already there). It:
    1. checks for Node.js 20+ and installs Node.js LTS with winget if missing
    2. copies the app to C:\Tula\app, installs packages and builds the web app (needs internet once)
    3. creates C:\TulaData (database, backups, logs) readable only by Administrators and SYSTEM
    4. writes C:\TulaData\tula.env (port, database path; sync token placeholders)
    5. registers the scheduled task "Tula": runs at system start as SYSTEM, before anyone signs in,
       restarts on failure; it runs scripts\windows\run-tula.cmd -> the Tula supervisor
    6. opens the port in Windows Firewall for Private networks only
    7. adds "Tula Billing" to the desktop and Start menu
    8. optionally keeps the PC awake while plugged in
    9. starts Tula and prints the address for phones

  Why SYSTEM: the task must run at power-on before anyone signs in, without a stored password
  (shop PCs often have no password, and Task Scheduler cannot run "whether user is logged on or not"
  for a passwordless account), and it must keep working after someone changes their password.
  The trade-off: SYSTEM cannot see the Google Drive G: drive (it is mounted per user), so the
  backup folder should be the Google Drive "Mirror files" folder (C:\Users\<name>\My Drive\...)
  or a USB drive. See docs\06-install-and-run.md.

.PARAMETER Port            Port for Tula (default 5000).
.PARAMETER AppDir          Where the app goes (default C:\Tula\app).
.PARAMETER DataDir         Where the data goes (default C:\TulaData).
.PARAMETER Preset          Starter catalogue on the very first start (default building-materials).
.PARAMETER ProfilePath     Optional business profile JSON applied on the very first start (copied into DataDir).
.PARAMETER KeepAwake       Keep the PC from sleeping while plugged in (asks when not given).
.PARAMETER NoKeepAwake     Do not change power settings and do not ask.
.PARAMETER SetNetworkPrivate  Mark the current network(s) as Private so phones can connect.
.PARAMETER DryRun          Show what would be done, change nothing.
#>
param(
    [int]$Port = 5000,
    [string]$AppDir = 'C:\Tula\app',
    [string]$DataDir = 'C:\TulaData',
    [string]$Preset = 'building-materials',
    [string]$ProfilePath = '',
    [switch]$KeepAwake,
    [switch]$NoKeepAwake,
    [switch]$SetNetworkPrivate,
    [switch]$DryRun
)

. "$PSScriptRoot\common.ps1"
$script:DryRun = [bool]$DryRun

$source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envFile = Join-Path $DataDir 'tula.env'
$runCmd = Join-Path $AppDir 'scripts\windows\run-tula.cmd'

Say ''
Say 'Tula installer'
Say "  from:     $source"
Say "  app:      $AppDir"
Say "  data:     $DataDir"
Say "  port:     $Port"
if ($script:DryRun) { Warn 'Dry run: nothing will be changed.' }

Assert-Admin
if (-not (Test-Path (Join-Path $source 'apps\server\src\supervisor.ts'))) {
    Fail "This does not look like the Tula folder ($source). Run the script from inside the unpacked Tula folder."
}

# ---------------------------------------------------------------- 1. Node.js
Step 'Node.js'
$node = Find-Node
if ($node -and (Get-NodeMajor $node) -ge 20) {
    Ok "Node.js $(& $node --version) at $node"
} else {
    if ($node) { Warn "Node.js $(& $node --version) is too old; Tula needs version 20 or later." }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        Fail 'Node.js is not installed and winget is not available. Download the "LTS" Windows installer from https://nodejs.org/en/download , install it with the default options, then run this script again.'
    }
    Invoke-Step 'Install Node.js LTS with winget (machine-wide)' {
        & winget install --id OpenJS.NodeJS.LTS -e --scope machine --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { Fail 'winget could not install Node.js. Install the LTS version from https://nodejs.org/en/download , then run this script again.' }
    } | Out-Null
    Update-PathFromRegistry
    $node = Find-Node
    if (-not $script:DryRun) {
        if (-not $node -or (Get-NodeMajor $node) -lt 20) { Fail 'Node.js was installed but cannot be found. Close this window, open a new Administrator PowerShell and run the script again.' }
        Ok "Node.js $(& $node --version) installed"
    }
}
if ($script:DryRun -and -not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$npm = if ($script:DryRun) { 'npm.cmd' } else { Find-Npm $node }
if (-not $npm) { Fail 'npm was not found next to node.exe. Reinstall Node.js LTS.' }

# ---------------------------------------------------------------- 2. App files
Step 'App files'
$sameFolder = ($source.TrimEnd('\') -ieq ([IO.Path]::GetFullPath($AppDir)).TrimEnd('\'))
if ($sameFolder) {
    Ok 'Already running from the app folder; nothing to copy.'
} else {
    Invoke-Step "Copy $source -> $AppDir (keeps node_modules; never copies databases or tula.env)" {
        New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
        & robocopy $source $AppDir /MIR /XD node_modules .git data dist android profiles /XF *.db *.db-wal *.db-shm tula.env *.profile.json /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { Fail "Copying the app files failed (robocopy code $LASTEXITCODE)." }
    } | Out-Null
    Ok "App files in $AppDir"
}
Invoke-Step 'Let ordinary users read but not change the app folder' {
    Set-FolderAcl (Split-Path $AppDir -Parent) @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX')
} | Out-Null

Step 'Packages and web app (a few minutes, needs internet)'
Invoke-Step "npm ci in $AppDir" {
    Push-Location $AppDir
    try {
        & $npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail 'Installing packages failed. Check the internet connection and run the script again.' }
        & $npm run build -w apps/web
        if ($LASTEXITCODE -ne 0) { Fail 'Building the web app failed. See the messages above.' }
    } finally { Pop-Location }
} | Out-Null
Ok 'Packages installed and web app built'

# ---------------------------------------------------------------- 3. Data folder
Step 'Data folder'
Invoke-Step "Create $DataDir (backups, logs) for Administrators and SYSTEM only" {
    foreach ($d in @($DataDir, (Join-Path $DataDir 'backups'), (Join-Path $DataDir 'logs'))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    Set-FolderAcl $DataDir @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
} | Out-Null
Ok "$DataDir ready"

$profileLine = '# TULA_PROFILE=C:\TulaData\business.profile.json'
if ($ProfilePath) {
    if (-not (Test-Path $ProfilePath)) { Fail "Business profile not found: $ProfilePath" }
    $profileDest = Join-Path $DataDir 'business.profile.json'
    Invoke-Step "Copy business profile to $profileDest" { Copy-Item $ProfilePath $profileDest -Force } | Out-Null
    $profileLine = "TULA_PROFILE=$profileDest"
}

# ---------------------------------------------------------------- 4. tula.env
Step 'Settings file'
if (Test-Path $envFile) {
    $current = Read-TulaEnv $envFile
    if ($current.ContainsKey('TULA_PORT') -and [int]$current['TULA_PORT'] -ne $Port) {
        Warn "$envFile already exists with TULA_PORT=$($current['TULA_PORT']); keeping it. Edit the file to change the port."
        $Port = [int]$current['TULA_PORT']
    } else {
        Ok "$envFile already exists; keeping it"
    }
} else {
    $lines = @(
        '# Tula settings for this computer. After changing anything here, restart Tula:',
        '#   powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\status.ps1 -Restart',
        "TULA_DB=$(Join-Path $DataDir 'tula.db')",
        "TULA_PORT=$Port",
        'TULA_HOST=0.0.0.0',
        '# Used only the very first time Tula starts:',
        "TULA_PRESET=$Preset",
        $profileLine,
        '# Cloud sync (later). Put the values from your Turso account here; never share this file.',
        '# TULA_SYNC_URL=',
        '# TULA_SYNC_TOKEN='
    )
    Invoke-Step "Write $envFile" { Set-Content -Path $envFile -Value $lines -Encoding ASCII } | Out-Null
    Ok "$envFile written"
}

# ---------------------------------------------------------------- 5. Scheduled task
Step 'Auto-start (scheduled task "Tula")'
Invoke-Step "Register task '$script:TaskName': at startup + every 5 minutes if not running, as SYSTEM" {
    # cmd /c strips the first and last quote of the command line, so the whole command gets an extra pair.
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/d /s /c `"`"$runCmd`" `"$envFile`"`"" -WorkingDirectory $AppDir
    $atStart = New-ScheduledTaskTrigger -AtStartup
    # Belt and braces: if the supervisor ever stops, this starts it again within 5 minutes.
    # (MultipleInstances IgnoreNew: nothing happens while it is running.)
    $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -MultipleInstances IgnoreNew -Priority 4
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger @($atStart, $every5) -Principal $principal -Settings $settings `
        -Description 'Tula billing: starts the Tula supervisor, which keeps the Tula server running.' -Force | Out-Null
} | Out-Null
Ok 'Tula will start whenever this PC is switched on, even before anyone signs in'

# ---------------------------------------------------------------- 6. Firewall
Step 'Windows Firewall'
Invoke-Step "Allow TCP $Port in on Private networks only" {
    Get-NetFirewallRule -Name $script:RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $script:RuleName -DisplayName 'Tula Billing' -Description 'Lets phones on the shop Wi-Fi open Tula.' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
} | Out-Null
Ok "Port $Port open for Private networks"
if (-not $script:DryRun) {
    $public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
    foreach ($p in $public) {
        if ($SetNetworkPrivate) {
            Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private
            Ok "Network '$($p.Name)' is now Private"
        } else {
            Warn "Network '$($p.Name)' is set to Public, so phones cannot reach Tula. If this is the shop's own Wi-Fi, run this script again with -SetNetworkPrivate (or Settings > Network > Wi-Fi > the network > Private)."
        }
    }
}

# ---------------------------------------------------------------- 7. Shortcuts
Step 'Shortcuts'
$url = "http://localhost:$Port"
$edgeCandidates = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
$edge = $edgeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$places = @((Join-Path $env:PUBLIC 'Desktop'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'))
foreach ($dir in $places) {
    Invoke-Step "Shortcut '$script:ShortcutName' in $dir" {
        if ($edge) {
            $ws = New-Object -ComObject WScript.Shell
            $lnk = $ws.CreateShortcut((Join-Path $dir "$($script:ShortcutName).lnk"))
            $lnk.TargetPath = $edge
            $lnk.Arguments = "--app=$url"
            $lnk.IconLocation = "$edge,0"
            $lnk.Description = 'Open Tula'
            $lnk.Save()
            Remove-Item (Join-Path $dir "$($script:ShortcutName).url") -ErrorAction SilentlyContinue
        } else {
            # No Edge: an internet shortcut opens the default browser.
            Set-Content -Path (Join-Path $dir "$($script:ShortcutName).url") -Value @('[InternetShortcut]', "URL=$url") -Encoding ASCII
        }
    } | Out-Null
}
Ok "'$script:ShortcutName' on the desktop and in the Start menu ($url)"

# ---------------------------------------------------------------- 8. Power
Step 'Power'
$doAwake = $false
if ($KeepAwake) { $doAwake = $true }
elseif (-not $NoKeepAwake -and -not $script:DryRun -and [Environment]::UserInteractive) {
    $ans = Read-Host 'Keep this PC from sleeping while it is plugged in, so phones can always reach Tula? (Y/N)'
    $doAwake = ($ans -match '^[Yy]')
}
if ($doAwake) {
    Invoke-Step 'Never sleep or hibernate on mains power' {
        & powercfg /change standby-timeout-ac 0
        & powercfg /change hibernate-timeout-ac 0
    } | Out-Null
    Ok 'The PC will not go to sleep while plugged in (the screen may still turn off)'
} else {
    Say '  Power settings not changed.'
}

# ---------------------------------------------------------------- 9. Start
Step 'Starting Tula'
Stop-Tula $DataDir
Start-Tula
if ($script:DryRun) {
    Ok 'Dry run finished.'
    exit 0
}
if (Wait-TulaHealth $Port 180) {
    Ok "Tula is running: $url"
} else {
    Warn "Tula did not answer within 3 minutes. Look at the newest file in $(Join-Path $DataDir 'logs'), or run status.ps1."
}
Say ''
$null = Invoke-TulaCli $AppDir $node $envFile 'status' @()
Say ''
Say 'Done. Open "Tula Billing" on the desktop. First sign-in: Owner, PIN 1234; you will be asked to choose your own PIN.'
Say 'On phones (same Wi-Fi), open one of the "Phones:" addresses above.'

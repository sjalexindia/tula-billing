# Install and run Tula at the shop

This guide is for whoever sets Tula up on the shop computer. Follow the steps in order. Commands are typed into **PowerShell opened as Administrator** (Start menu → type `PowerShell` → right-click **Windows PowerShell** → **Run as administrator**).

Once installed, Tula looks after itself:
- it **starts by itself** when the computer is switched on, even before anyone signs in to Windows;
- it **restarts by itself** if it crashes or stops answering;
- it **backs itself up every day**, and catches up when the computer is switched on if a backup was missed;
- phones on the shop Wi-Fi open it in their browser.

## 1. What you need

| | |
|---|---|
| Computer | Windows 10 or 11, 4 GB RAM or more, 2 GB free disk. Wired to the router or on the shop Wi-Fi. |
| Power | A **UPS** (inverter alone is not enough: the switch-over can still reset the PC). Tula survives power cuts, but every cut is a risk to the disk. |
| Internet | Only during installation and updates (to download Node.js and packages). Billing works without internet. |
| Google Drive (recommended) | **Google Drive for desktop**, signed in with the shop's Google account, so backups are copied to the cloud. |
| Printer | Installed in Windows as usual. Tula prints through the browser's print dialog. |

## 2. Install

1. Copy the Tula folder to the computer (e.g. unzip `tula.zip` to `C:\Users\<you>\Downloads\tula`).
2. In Administrator PowerShell:
   ```powershell
   cd C:\Users\<you>\Downloads\tula
   powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -SetNetworkPrivate -KeepAwake
   ```
   - `-SetNetworkPrivate` marks the shop network as *Private* so phones can connect. Leave it out on a network you do not trust.
   - `-KeepAwake` stops the PC from sleeping while plugged in (otherwise phones lose Tula when it sleeps). Leave it out to be asked.
   - Other options: `-Port 5000`, `-Preset building-materials` (starter catalogue for the first start), `-ProfilePath D:\shop.profile.json` (the business's details, see [03-configuration.md](03-configuration.md)).
3. It takes a few minutes (Node.js, packages, building the app). At the end it prints something like:
   ```
   On this PC:   http://localhost:5000
   Phones:       http://192.168.1.20:5000
   ```
   Note the **Phones** address.

Running it again is safe: it repairs or updates the installation and keeps the data.

What it set up:

| What | Where |
|---|---|
| App | `C:\Tula\app` (Administrators can change it, others can only read) |
| Data: database, backups, logs | `C:\TulaData` (only Administrators and Windows itself can open it) |
| Settings for this computer | `C:\TulaData\tula.env` (port, database path, later the sync token: never share it) |
| Auto-start | Task Scheduler → task **Tula** (runs at start-up as SYSTEM, restarts on failure, checked every 5 minutes) |
| Firewall | Inbound rule **Tula Billing**, TCP 5000, **Private** networks only |
| Shortcut | **Tula Billing** on the desktop and in the Start menu (opens Tula in its own Edge window) |

> **Why it runs as SYSTEM.** Tula has to start when the PC is switched on, before anyone signs in, and without a stored Windows password (shop PCs often have none, and Windows cannot run a task "whether the user is logged on or not" for an account without a password). It also keeps working if someone changes the Windows password. One consequence: the Google Drive **G:** drive is only visible to the signed-in user, not to SYSTEM. So use Google Drive in **Mirror files** mode and choose the mirrored folder (step 5).

## 3. First start and sign-in

1. Double-click **Tula Billing** on the desktop.
2. Choose **Owner**, PIN **1234**. Tula asks for a new PIN straight away. Choose one only the owner knows.
3. Fill in the business details in **Settings** (name, address, state, GSTIN). Billing is blocked until these are filled in.
4. Add users for the counter staff in **Settings → Users** (role *Billing*).

## 4. Phones on the shop Wi-Fi

1. Connect the phone to the **same Wi-Fi** as the shop computer.
2. Open Chrome and type the **Phones** address (e.g. `http://192.168.1.20:5000`). Bookmark it, or use *Add to Home screen*.
3. If the address changes after a router restart, ask the router to always give the computer the same address ("DHCP reservation"), or look it up again in **Settings → Backup → This computer**.

## 5. Daily backup and Google Drive

Tula backs up every day at **9:00 PM** (change it in **Settings → Backup**). If the computer was off at that time, it backs up shortly after it is next switched on. Each backup is a complete, checked copy named like `tula-2026-10-25-2100.db`. Tula keeps the last 30 days, one per month for a year, and every hand-made backup from the last week.

**Copy backups to the cloud (recommended):**
1. Install **Google Drive for desktop** and sign in with the shop's Google account.
2. Google Drive settings (gear icon) → **Preferences** → **Google Drive** → choose **Mirror files**. The files are then kept in a normal folder, `C:\Users\<name>\My Drive`.
3. In Tula: **Settings → Backup → Backup folder**, type `C:\Users\<name>\My Drive\Tula backups`, then **Save backup settings**, then **Back up now**.
4. Check the backup appears in drive.google.com within a few minutes.

**Or a USB drive:** type e.g. `E:\Tula backups`. Leave it plugged in. If it is unplugged at backup time, Tula saves the backup on the computer instead and shows a warning on the Backup screen.

The Backup screen shows green **Backups OK** when the last backup is recent. Look at it once a week. A red **Problem** means no good backup for 2 days: fix it the same day.

You can also back up from PowerShell: `powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\backup-now.ps1`

## 6. Restore a backup

Restoring replaces **all** current data with the backup. Bills made after that backup are lost from the live data. Tula first saves a safety copy of the current data, kind "Before restore or update", so a restore can itself be undone.

**From the app (owner):** **Settings → Backup** → pick the backup → **Restore** → enter your PIN → **Restore and restart**. Tula restarts in under a minute. Everyone signs in again.

**From PowerShell** (e.g. a backup file copied from Google Drive or a USB drive):
```powershell
powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\restore.ps1 -File "E:\Tula backups\tula-2026-10-25-2100.db"
```
It stops Tula, checks the file, saves the safety copy, swaps the backup in and starts Tula again. The replaced database is also kept in `C:\TulaData\before-restore\`.

A damaged backup, or one made by a newer version of Tula, is refused and nothing changes.

## 7. Update Tula

```powershell
powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\update.ps1 -From D:\Downloads\tula-new.zip
```
(or `-GitPull` if `C:\Tula\app` is a git clone). It stops Tula, takes a safety backup, installs the new version and starts it. If the new version does not answer within 3 minutes, it **puts the previous version back** by itself. The previous version is kept in `C:\Tula\app.previous`.

## 8. Move to a new computer

1. **Old computer:** Settings → Backup → **Back up now**, then **Download** that backup (or take it from Google Drive / the USB drive). Then **stop Tula on the old computer for good**: `uninstall.ps1` (data is kept), or at least turn it off. Two computers must never run the same shop's data at the same time.
2. **New computer:** install (step 2).
3. Restore the backup with `restore.ps1 -File <the backup>` (step 6).
4. Sign in with the owner's usual PIN. Check the latest bills are there.
5. Set the backup folder again if the new computer uses a different path (Settings → Backup).
6. Update the phones' bookmark if the computer's address changed.

## 9. Power cuts

- Tula's database is written so that a power cut cannot leave half a bill: after the power comes back, the last completed bill is there and an unfinished one simply was not saved.
- When the power returns, Windows starts and Tula starts by itself. Nobody needs to sign in to Windows.
- To make Windows start by itself when power returns, set **"Restore on AC power loss" = Power On** in the computer's BIOS/UEFI settings (ask the computer shop if unsure).
- A **UPS** with 10+ minutes is strongly recommended; shut Windows down normally during long cuts.

## 10. Checking on Tula

```powershell
powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\status.ps1
```
shows whether it is running, the addresses, the last backup, network/firewall problems and the last lines of the log. Add `-Restart` to restart it. Logs are in `C:\TulaData\logs\tula-YYYY-MM-DD.log` (14 days are kept).

## 11. Troubleshooting

| Problem | What to do |
|---|---|
| "Tula Billing" shows *can't reach this page* on the shop PC | Wait one minute after switching on. Then run `status.ps1`. If it says *NOT answering*, run `status.ps1 -Restart` and read the log lines it prints. |
| Log says `EADDRINUSE` / port in use | Another program uses port 5000. Find it: `Get-NetTCPConnection -LocalPort 5000 -State Listen` then `Get-Process -Id <OwningProcess>`. Close it, or change `TULA_PORT` in `C:\TulaData\tula.env`, run `install.ps1` again (updates firewall and shortcuts) and update the phone bookmarks. |
| Works on the PC, but not on phones | (1) Phone on the **same Wi-Fi** (not mobile data, not a guest Wi-Fi). (2) Windows network must be **Private**: Settings → Network & Internet → Wi-Fi/Ethernet → the network → *Private*, or `install.ps1 -SetNetworkPrivate`. (3) `status.ps1` shows the firewall rule. (4) Other antivirus firewalls (Quick Heal, K7, etc.) need port 5000 allowed for the local network. (5) The PC's address may have changed: see **Settings → Backup → This computer**. |
| Phones lose Tula after some time | The PC went to sleep: run `install.ps1 -KeepAwake`, or Settings → System → Power → *When plugged in, put my device to sleep after* → **Never**. |
| Backup screen says the folder cannot be reached | USB drive unplugged, or the Google Drive folder is the **G:** drive (not visible to Tula). Use the Mirror files folder under `C:\Users\<name>\My Drive` (section 5). |
| Printing: wrong size or blank margins | In the print dialog choose the right printer and paper (A4/A5 as set in Settings → Invoice), Margins: *Default*, Scale: *100*, and turn **off** *Headers and footers*. Set the printer as Windows' default so Tula's print button picks it first. |
| PIN locked ("Too many wrong PINs") | Wait 5 minutes and try again (a restart of Tula also clears it). |
| Owner forgot the PIN | Another owner can reset it in Settings → People. With no other owner, on the shop PC (as administrator): `reset-pin.ps1` lists people, `reset-pin.ps1 -Name "Owner"` sets the temporary PIN 1234; they choose a new one at sign-in. |
| "This backup was made by a newer version of Tula" | Update Tula on this computer (section 7), then restore. |
| Tula keeps restarting (log shows "starting again in 60 s") | Read the error just above that line in the log. If it started after an update, re-run `update.ps1` with the previous version, or restore the "Before restore or update" backup. |

## 12. Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File C:\Tula\app\scripts\windows\uninstall.ps1
```
removes the task, firewall rule, shortcuts and app, and **keeps** `C:\TulaData`. Add `-RemoveData` to delete the data too (asks you to type DELETE; copies in Google Drive or on USB drives are not touched).

## Linux (shop PC or small server)

```bash
sudo ./scripts/linux/install.sh --port 5000
```
Installs to `/opt/tula/app`, data in `/var/lib/tula`, settings in `/etc/tula/tula.env`, and a systemd service `tula` (starts at boot, `Restart=always`) running as the `tula` user. Status: `systemctl status tula` or `journalctl -u tula`. Backup now / restore / status:
```bash
cd /opt/tula/app
sudo -u tula node --import tsx apps/server/src/cli/backup.ts  --env-file /etc/tula/tula.env
sudo systemctl stop tula
sudo -u tula node --import tsx apps/server/src/cli/restore.ts /path/to/tula-2026-10-25-2100.db --env-file /etc/tula/tula.env
sudo systemctl start tula
```

## For developers: what runs

```
Task Scheduler "Tula" (SYSTEM, at start-up)        systemd tula.service
          └─ scripts\windows\run-tula.cmd                    │
               └─ node --import tsx apps/server/src/supervisor.ts --env-file <tula.env>
                    ├─ applies <data>/restore-pending.json if present (swap DB, old one to <data>/before-restore/)
                    ├─ node --import tsx apps/server/src/main.ts   (TULA_SUPERVISED=1)
                    ├─ GET /api/health every 30 s; 3 failures → restart
                    ├─ restart on exit: 2 s, 5 s, 15 s, 30 s, 60 s… (reset after 10 healthy minutes)
                    └─ logs → <data>/logs/tula-YYYY-MM-DD.log (14 days); lock → <data>/tula-supervisor.lock
```
Command-line tools (all accept `--env-file`): `apps/server/src/cli/backup.ts [--kind manual|safety] [--json]`, `cli/restore.ts <file> [--yes]` (refuses while Tula runs), `cli/status.ts [--json] [--wait SECONDS]`.

Backup settings and status are machine-specific and live in the local-only `sync_state` table (`ops.backup_folder`, `ops.backup_time`, `ops.backup_enabled`, `ops.backup_last_*`); a restore keeps this computer's backup settings. API (owner only): `GET/PUT /api/ops/backup`, `POST /api/ops/backup/run`, `GET /api/ops/backup/:file/download`, `POST /api/ops/restore {file, pin}`, `GET /api/ops/info`.

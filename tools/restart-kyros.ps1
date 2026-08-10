# Restart Kyros Studio.
#
# The owner should not have to do this by hand after every change (2026-08-10). A build watcher now
# reloads the WINDOW on a client change, and the server forks with --watch, so most edits need
# nothing. This exists for the one case neither covers: electron/main.js, which cannot watch its own
# bootstrap.
#
#   powershell -ExecutionPolicy Bypass -File tools\restart-kyros.ps1
#
# Rebuilds the client first, because a restart that serves a stale dist is the exact failure this is
# meant to end.

$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $PSScriptRoot

# --- 1. build, so the restart cannot serve yesterday's UI ----------------------------------------
Write-Host '  building client...'
Push-Location (Join-Path $AppDir 'client')
try {
    # NOT 2>&1. In PowerShell 5.1 redirecting a native command's stderr wraps every line in an
    # ErrorRecord and trips $ErrorActionPreference='Stop' -- vite writes its normal build output to
    # stderr, so a SUCCESSFUL build was reported as a failure. Let stderr through to the console and
    # judge by the exit code, which is what actually says whether it worked.
    $build = (& npx --yes vite build | Out-String)
    if ($LASTEXITCODE -ne 0) {
        # A failed build must NOT be followed by a restart -- that would replace a working window
        # with one serving a half-written dist.
        Write-Host '  BUILD FAILED - not restarting. The running app is left alone.'
        Write-Host ($build -split "`n" | Select-Object -Last 12 | Out-String)
        exit 1
    }
    $line = ($build -split "`n" | Where-Object { $_ -match 'built in' } | Select-Object -Last 1)
    if ($line) { Write-Host ('  ' + $line.Trim()) } else { Write-Host '  built' }
} finally { Pop-Location }

# --- 2. stop every Kyros electron process -----------------------------------------------------------
# Matched on the executable path, not the name: killing every "electron" on the machine would take
# down unrelated apps.
$procs = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($AppDir, 'OrdinalIgnoreCase') }
if ($procs) {
    Write-Host ('  stopping {0} process(es)...' -f $procs.Count)
    foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
    # The server holds a port and a single-instance lock; relaunching before they clear gives a
    # second instance that immediately quits, which reads as "the restart did nothing".
    Start-Sleep -Seconds 3
} else {
    Write-Host '  nothing running'
}

# --- 3. launch ---------------------------------------------------------------------------------------
$electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { Write-Host "  electron not found at $electron"; exit 1 }
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $AppDir
Write-Host '  launched'

# --- 4. wait for the server, so "restarted" means "answering" -------------------------------------------
$port = 18421
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { Write-Host ('  up on {0} after {1:N1}s' -f $port, ($i * 0.5)); exit 0 }
    } catch { }
}
# Not a failure: the window may be up while health is still warming. Say which is unknown rather
# than claiming success.
Write-Host '  launched, but /api/health did not answer within 20s - check the window'
exit 0

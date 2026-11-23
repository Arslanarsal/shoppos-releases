$ErrorActionPreference = "Stop"
$vault = "C:\ProgramData\ShopPOS Vault"
$bin = Join-Path $vault "bin"
New-Item -ItemType Directory -Force $bin | Out-Null
icacls $vault /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX" | Out-Null

$copy = @'
$vault = "C:\ProgramData\ShopPOS Vault"
$log = Join-Path $vault "vault.log"
$keep = 90
Get-ChildItem C:\Users -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $src = Join-Path $_.FullName "AppData\Local\ShopPOS Data\local-backups\ShopPOS Backups"
  if (-not (Test-Path $src)) { return }
  $dst = Join-Path $vault $_.Name
  robocopy $src $dst /E /XO /R:1 /W:1 /XD ".partial-*" /XF "*.copying" /NP /NJH /NJS /NFL /NDL | Out-Null
  Get-ChildItem $dst -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $snaps = Join-Path $_.FullName "snapshots"
    $all = @(Get-ChildItem $snaps -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName "manifest.json") } | Sort-Object Name -Descending)
    if ($all.Count -gt $keep) { $all | Select-Object -Skip $keep | Remove-Item -Recurse -Force }
  }
  Add-Content $log ("{0} copied backups of {1}" -f (Get-Date -Format s), $_.Name)
}
if ((Get-Item $log -ErrorAction SilentlyContinue).Length -gt 1MB) { Remove-Item $log }
'@
Set-Content (Join-Path $bin "vault-copy.ps1") $copy -Encoding UTF8
Set-Content (Join-Path $vault "README.txt") "Protected copies of the ShopPOS backups. Windows copies them here every 30 minutes. Normal programs (and viruses that run as the normal user) cannot change or delete them. To use one: open ShopPOS, Settings, Backups, Restore from a backup, and choose this folder." -Encoding UTF8

$action = New-ScheduledTaskAction -Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bin\vault-copy.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$boot = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "ShopPOS Vault" -Action $action -Trigger @($trigger, $boot) -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "ShopPOS Vault"
"vault ready: $vault"

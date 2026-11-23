param([string]$DataDir = 'C:\Users\Public\pc\test\pc1', [string]$Extra = '')
Get-Process shoppos -ErrorAction SilentlyContinue | % { $_.CloseMainWindow() | Out-Null }
Start-Sleep 2
Get-Process shoppos -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 1
$a = "$env:LOCALAPPDATA\ShopPOS\shoppos.exe"
$lines = @(
 "@echo off",
 "set SHOPPOS_DATA_DIR=$DataDir",
 "set SHOPPOS_NO_UPDATE=1",
 "set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222",
 $Extra,
 "start `"`" `"$a`""
)
Set-Content C:\Users\Public\pc\launch.cmd ($lines -join "`r`n") -Encoding ascii
schtasks /create /tn ShopPOSTest /tr C:\Users\Public\pc\launch.cmd /sc once /st 23:59 /it /rl limited /f | Out-Null
schtasks /run /tn ShopPOSTest | Out-Null
for ($i=0; $i -lt 120; $i++) { Start-Sleep 1; try { $r = Invoke-WebRequest http://127.0.0.1:9222/json -UseBasicParsing -TimeoutSec 2; if ($r.Content -match 'webSocketDebuggerUrl') { "debug port up after $i s"; $r.Content; break } } catch {} }

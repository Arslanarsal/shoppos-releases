#!/bin/bash
set -e
PC="${PC:-pak lab@192.168.100.215}"
KEY="${PC_KEY:-$HOME/.ssh/pos_client_pc}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ssh -i "$KEY" -o BatchMode=yes "$PC" "New-Item -ItemType Directory -Force C:\\Users\\Public\\pc | Out-Null; [IO.File]::WriteAllBytes('C:\\Users\\Public\\pc\\pc-launch.ps1', [Convert]::FromBase64String('$(base64 -w0 "$DIR/pc-launch.ps1")'))"
ssh -i "$KEY" -o BatchMode=yes "$PC" "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\Public\\pc\\pc-launch.ps1 -DataDir '$1'${2:+ -Extra '$2'}" | grep -E "debug port up|^[a-z]" | head -1
if ! ss -ltn | grep -q '127.0.0.1:9222 '; then
  ssh -i "$KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -f -N -L 9222:127.0.0.1:9222 "$PC"
fi
for i in $(seq 1 30); do curl -s -m 2 http://127.0.0.1:9222/json | grep -q tauri.localhost && exit 0; sleep 1; done
echo "app page not found"; exit 1

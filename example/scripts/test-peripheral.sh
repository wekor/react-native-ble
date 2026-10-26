#!/bin/sh
# Builds the test peripheral as an app and starts it. macOS charges Bluetooth access to the process that launched a
# tool, so it runs as its own app (via `open`); the first run asks for Bluetooth permission.
# Usage: example/scripts/test-peripheral.sh [build dir]   Log: <build dir>/test-peripheral.log
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../build"}
app="$out/BLETestPeripheral.app"
mkdir -p "$app/Contents/MacOS"
cp "$here/test-peripheral.plist" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string test-peripheral" "$app/Contents/Info.plist"
swiftc -O "$here/test-peripheral.swift" -o "$app/Contents/MacOS/test-peripheral"
codesign --force --sign - "$app"
# SIGTERM lets a running copy give back its L2CAP PSM; wait for it to exit before starting the new one.
pkill -f "BLETestPeripheral.app/Contents/MacOS/test-peripheral" || true
while pgrep -f "BLETestPeripheral.app/Contents/MacOS/test-peripheral" >/dev/null; do sleep 0.2; done
open -g --stdout "$out/test-peripheral.log" --stderr "$out/test-peripheral.log" "$app"
echo "started; log: $out/test-peripheral.log"

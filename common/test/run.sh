#!/bin/sh
# Builds and runs the C++ unit tests against React Native's JSI sources.
set -e
root=$(cd "$(dirname "$0")/../.." && pwd)
jsi="$root/node_modules/react-native/ReactCommon/jsi"
out="$root/common/test/build"
mkdir -p "$out"
${CXX:-c++} -std=c++20 -Wall -Wextra -O1 -g -fsanitize=address,undefined \
  -I "$root/common/cpp" -I "$jsi" \
  "$root/common/test/BleScanHubTest.cpp" "$root/common/cpp/BleScanHub.cpp" "$root/common/cpp/BleValue.cpp" "$jsi/jsi/jsi.cpp" \
  -o "$out/ble-scan-hub"
"$out/ble-scan-hub"

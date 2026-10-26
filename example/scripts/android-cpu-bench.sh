#!/bin/sh
# Runs a measurement in the installed release build of the example and attributes the app's CPU time to each step.
# Usage: example/scripts/android-cpu-bench.sh <serial> '<query>' <out.json>   e.g. 'kind=throughput&rounds=2'
# It samples utime+stime of the app process on the phone every 0.5 s, then splits them by the step timeline the
# app logs as `BENCH` lines. Each step also gets its CPU less the idle step's rate over the same time: the idle app
# keeps a core a few percent busy, which would otherwise make a slower link look like more work.
set -e
serial=$1; query=$2; out=$3
adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb -s $serial"
$adb shell am force-stop com.wekor.ble.example
# Compiled ahead of time, so runs don't differ by how much ART has compiled since the install.
$adb shell cmd package compile -m speed -f com.wekor.ble.example >/dev/null
$adb logcat -c
$adb shell am start -n com.wekor.ble.example/.MainActivity >/dev/null
sleep 6
pid=$($adb shell pidof com.wekor.ble.example)
samples=$(mktemp)
$adb shell "while true; do echo \$(date +%s%3N) \$(cut -d' ' -f14,15 /proc/$pid/stat); sleep 0.5; done" > "$samples" &
sampler=$!
$adb shell am start -a android.intent.action.VIEW -d "'bleexample://bench?$query'" com.wekor.ble.example >/dev/null
until $adb logcat -d -s ReactNativeJS:I | grep -q "BENCH 1/"; do sleep 2; done
sleep 2
kill $sampler 2>/dev/null || true
$adb logcat -d -s ReactNativeJS:I | grep "BENCH " | sed 's/.*BENCH [0-9]*\/[0-9]* //' | tr -d '\n' > "$out.raw"
python3 - "$out.raw" "$samples" "$out" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
samples = []
for line in open(sys.argv[2]):
    parts = line.split()
    if len(parts) == 3: samples.append((int(parts[0]), int(parts[1]) + int(parts[2])))
def ticks_at(t):
    # Linear between the samples around t; clock ticks are 10 ms.
    before = max((s for s in samples if s[0] <= t), default=samples[0])
    after = min((s for s in samples if s[0] >= t), default=samples[-1])
    if after[0] == before[0]: return before[1]
    return before[1] + (after[1] - before[1]) * (t - before[0]) / (after[0] - before[0])
steps = report.get("timeline", [])
for step in steps:
    step["cpuMs"] = round((ticks_at(step["end"]) - ticks_at(step["start"])) * 10)
    step["wallMs"] = step["end"] - step["start"]
idle = next((s for s in steps if s["step"] == "idle"), None)
idle_rate = idle["cpuMs"] / max(idle["wallMs"], 1) if idle else 0
for step in steps:
    step["cpuLessIdleMs"] = round(step["cpuMs"] - idle_rate * step["wallMs"])
json.dump(report, open(sys.argv[3], "w"), indent=1, ensure_ascii=False)
for step in steps:
    print(f'{step["lib"]:5} {step["step"][:42]:42} wall {step["wallMs"]:6} ms  cpu {step["cpuMs"]:6} ms  ({100 * step["cpuMs"] / max(step["wallMs"], 1):.0f}%)  less idle {step["cpuLessIdleMs"]:6} ms')
# A step that used no CPU at all means the sampler stopped, not that the step was free.
stalled = [s["step"] for s in steps if s["step"] != "idle" and s["wallMs"] > 1000 and s["cpuMs"] == 0]
if stalled: print("warning: CPU sampling stalled during", ", ".join(stalled))
PY
rm -f "$samples"

# @wekor/react-native-ble

A general-purpose Bluetooth Low Energy central for React Native 0.80+, New Architecture only. Correct first, then
fast; the API stays general (never shaped around one app).

## Layout

- `src/` — the TS API: `device.ts`, `scan.ts`, `adapter.ts` are public; `NativeReactNativeBle.ts` is the TurboModule
  spec and `native.ts` the ops and the events native sends.
- `ios/` — `ReactNativeBle.mm` is only the React Native boundary: TurboModule, JSI install, forwarding calls and
  converting what Swift reports to C++. The Bluetooth logic: `BleCentral.swift` (what all devices share: the
  manager and its queue, permission, state, scan, connections, L2CAP channel ids, restoration; it reports through
  the `@objc` `BleCentralDelegate` protocol), `BleConnection.swift` (one device: connecting, discovery, the GATT
  queue, its peripheral's callbacks), `BleL2capChannel.swift`, `BleSupport.swift`, and `BleCentralManagerProxy.mm`,
  the manager's delegate, which turns advertisements into C++ values without bridging them into Swift.
- `android/` — Kotlin, everything on one handler thread. `BleModule.kt` is only the React Native boundary: the
  TurboModule, reading JS arguments into Kotlin types, forwarding calls. `BleCentral.kt` (what all devices share:
  the thread, permission, state, connections; it reports through `BleCentralDelegate`), `BleConnection.kt` (one
  device: connecting, discovery, the GATT queue), `BleScanner.kt` (the native scan and its advertisements),
  `BleBonds.kt`, `BleL2cap.kt`, `BleSupport.kt`. JNI in `src/main/jni`.
- `common/cpp/` — shared C++: `BleBridge` (JSI functions, byte store, event queue to JS), `BleValue`, `BleScanHub`
  (one native scan for all JS scans: filters, duplicates, presence). Tests in `common/test/`.
- `plugin/` — the Expo config plugin (`app.plugin.js` loads `plugin/build`).
- `docs/` — Docusaurus site.
- `example/` — an Expo Router app that integrates one device, the test peripheral a Mac runs
  (`example/scripts/test-peripheral.sh`). Tabs: Devices (scan, then read/write, notifications, file transfer, L2CAP),
  Tests (the peripheral suite, scan filter tests), Performance (ours against react-native-ble-plx, which stays as the
  baseline). The device's protocol and its tests live in `example/src/lib/test-peripheral/`.

## Commands

```sh
bun install
bun run check        # biome
bun run typecheck
bun run test         # bun test (JS) ; bun run test:cpp for BleScanHub
bun run prepare      # bob build + plugin
bun run build:android
bun run --cwd docs start
```

No Jest, ESLint, Prettier or Lefthook.

## Rules

- Every async op goes through one channel: JS allocates an `opId`, native answers once with a `result` event via
  the C++ bridge, in order with all other events (`notification`, `disconnected`, ...). Side effects of a result
  or a failure are applied inside the result handler (`request(start, apply, fail)`), not after `await`.
- Every op settles exactly once — on its callback, Bluetooth off, disconnect, or teardown.
- No hidden timers, sleeps, retries or magic constants. Only the caller's timeouts bound waiting; an op timeout rejects the
  op, the next op waits for its late callback, and a second timeout drops the link. OS rules (Android's 5 scan starts
  per 30 s, the 30-minute scan limit) are named constants with a comment.
- Sync getters read lock-protected snapshots; anything that asks the system or the radio is async.
- Bytes are `Uint8Array` over JSI, never base64.
- Swift, Kotlin, Objective-C++ and C++ follow their own conventions and idioms, not TypeScript's. A change is judged
  by correctness and measured performance, not by matching the other platforms.

## Verifying a change

- Unit tests and both builds; then real phones, with the test peripheral running on a Mac.
- Debug builds: `example/scripts/cdp.mjs` drives the app's JS, where `peripheralTests.run()` runs the suite
  (`peripheralTests.run({ only: 'L2CAP' })` the matching tests), `compare.run(id)` the comparison and `ble` is the
  library. Run only the tests a change touches; the whole suite takes minutes.
- Release builds have no debugger: `bleexample://bench?kind=...` runs `tests` (with `only`), `bridge`, `scanning`,
  `throughput`, `latency`, `l2cap` or `compare`, shows the result and writes `Documents/bench-result.json` (iOS,
  pulled with devicectl) and `BENCH` log lines (Android). CPU comes from `example/modules/cpu-time` on both.
- Measuring CPU: release builds only, each variant at least three times, alternating, with the build before a change
  kept aside. Compare CPU less the idle app's (the idle step's rate over the step's time; Android's script writes it as
  `cpuLessIdleMs`): the idle app keeps a few percent of a core busy, so raw CPU per byte grows with a slower link. On Android, `example/scripts/android-cpu-bench.sh` compiles the app ahead
  of time first, samples `/proc/<pid>/stat` and warns when sampling stalls; drop runs where a system dialog sent the
  app to the background (`wm_on_stop_called` in `logcat -b events`).
- Android release builds don't re-bundle JS when only `src/` changed: delete
  `example/android/app/build/generated/assets/react/release` first.

## Docs

English, in the style of Expo's docs. If one sentence can say it, don't use two. Measured claims link to
`docs/content/comparison.mdx`, which holds the method and the disclaimer.

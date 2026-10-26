# Contributing

Contributions are always welcome, no matter how large or small!

We want this community to be friendly and respectful to each other. Please follow it in all your interactions with the project. Before contributing, please read the [code of conduct](./CODE_OF_CONDUCT.md).

## Development workflow

This project is a monorepo managed using [Bun workspaces](https://bun.sh/docs/install/workspaces). It contains the following packages:

- The library package in the root directory.
- An example app in the `example/` directory.

To get started with the project, make sure you have the correct version of [Node.js](https://nodejs.org/) installed. See the [`.nvmrc`](./.nvmrc) file for the version used in this project.

You also need [Bun](https://bun.sh/); see [`.bun-version`](./.bun-version). Run `bun install` in the root directory to install the required dependencies for each package:

```sh
bun install
```

The [example app](/example/) demonstrates usage of the library. You need to run it to test any changes you make.

It is configured to use the local version of the library, so any changes you make to the library's source code will be reflected in the example app. Changes to the library's JavaScript code will be reflected in the example app without a rebuild, but native code changes will require a rebuild of the example app.

If you want to use Android Studio or Xcode to edit the native code, you can open the `example/android` or `example/ios` directories respectively in those editors. To edit the Objective-C or Swift files, open `example/ios/BLEExample.xcworkspace` in Xcode and find the source files at `Pods > Development Pods > ReactNativeBle`.

To edit the Java or Kotlin files, open `example/android` in Android studio and find the source files in the `wekor_react-native-ble` module.

You can use various commands from the root directory to work with the project.

To start the packager:

```sh
bun run example start
```

To run the example app on Android:

```sh
bun run example android
```

To run the example app on iOS:

```sh
bun run example ios
```

Make sure your code passes Biome and TypeScript:

```sh
bun run check
bun run typecheck
```

Run the unit tests of the library and the config plugin, and of the shared C++:

```sh
bun run test
bun run test:cpp
```

Then test on real phones against the test peripheral, which a Mac runs with `example/scripts/test-peripheral.sh`: the example's **Tests** tab runs its suite, and the **Performance** tab compares CPU time with react-native-ble-plx. Measure CPU with release builds only; on Android, `example/scripts/android-cpu-bench.sh` runs a measurement and reports each step less the idle app's CPU.

The Expo config plugin lives in `plugin/src` and compiles to `plugin/build`, which `app.plugin.js` loads. `bun install` builds it through `prepare`; after editing the plugin, run `bun run prepare` before `npx expo prebuild` in the example app.

To fix formatting and safe lint issues:

```sh
bun run fix
```

### Scripts

The `package.json` file contains various scripts for common tasks:

- `bun install`: setup project by installing dependencies.
- `bun run check`: lint and check formatting with Biome.
- `bun run fix`: apply Biome fixes and formatting.
- `bun run typecheck`: type-check files with TypeScript.
- `bun run test`: run the unit tests of the library and the config plugin.
- `bun run test:cpp`: run the unit tests of the shared C++ (`common/cpp`).
- `bun run prepare`: build the library into `lib/` and the config plugin into `plugin/build/`.
- `bun run build:android`: compile the library's Android module (run `bun run build:android:prepare` first).
- `bun run build:ios`: compile the example app, and with it the library, for the iOS simulator (run `bun run build:ios:prepare` first).
- `bun run example start`: start the Metro server for the example app.
- `bun run example android`: run the example app on Android.
- `bun run example ios`: run the example app on iOS.

### Sending a pull request

> **Working on your first pull request?** You can learn how from this _free_ series: [How to Contribute to an Open Source Project on GitHub](https://app.egghead.io/playlists/how-to-contribute-to-an-open-source-project-on-github).

When you're sending a pull request:

- Prefer small pull requests focused on one change.
- Verify that linters and tests are passing.
- Review the documentation to make sure it looks good.
- Follow the pull request template when opening a pull request.
- For pull requests that change the API or implementation, discuss with maintainers first by opening an issue.

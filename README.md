# @wekor/react-native-ble

Bluetooth Low Energy for React Native: simple by default, every native option one argument away.

```ts
import { requestPermission, startScan } from '@wekor/react-native-ble';

if (!(await requestPermission()).granted) return;

const stop = startScan({
  services: ['180d'],
  onFound: async ({ device }) => {
    stop();
    await device.connect();
    device.subscribe('2a37', (value) => console.log(value));
    await device.write('2a39', new Uint8Array([1]));
  },
});
```

## Requirements

| React Native | iOS | Android | Expo |
| --- | --- | --- | --- |
| 0.80+, New Architecture | 15.1+ | 7.0+ (API 24) | Development builds; config plugin included. Not Expo Go. |

## Why this library

Measured against react-native-ble-plx 3.5.1 with release builds, on the same
phones and devices:

| Measured | @wekor/react-native-ble | react-native-ble-plx |
| --- | --- | --- |
| CPU time (usage), receiving 1000 notifications · iPhone | **391 ms (1.5%)** | 1331 ms (4.7%) |
| CPU time (usage), receiving 1000 notifications · Android | **1.6 s (12%)** | 4.7 s (35%) |
| CPU time (usage), 200 writes · iPhone | **155 ms (1.0%)** | 413 ms (2.9%) |
| CPU time (usage), 200 writes · Android | **0.49 s (5.9%)** | 1.46 s (14%) |
| CPU time (usage), scanning nearby devices for 20 s · iPhone | **86–92 ms (0.4%)** | 242–260 ms (1.3%) |
| CPU time (usage), scanning nearby devices for 20 s · Android | **2.6 s (13%)** | 4.6 s (23%) |
| Fast writes that arrive, of 2000 sent · iPhone | **2000** | 92 |
| Reading the Bluetooth state | **1.2 µs**, synchronous | 20 µs (iPhone) · 144 µs (Android) |

Usage is CPU time over the test's duration on one core; throughput, connecting, reading and scanning take the same time with both. [How it was measured](docs/content/comparison.mdx).

## Installation

```sh
npm i @wekor/react-native-ble
```

With Expo, add the config plugin:

```ts
plugins: [['@wekor/react-native-ble', { bluetoothPermission: 'Allow $(PRODUCT_NAME) to connect to your device' }]];
```

## Documentation

[Guides and API reference](docs/content/overview.mdx); run the site locally with `bun run --cwd docs start`.

## Example

`example/` is a test app: a scanner and GATT explorer, scan filter and stress tests, and the comparison with react-native-ble-plx.

```sh
bun install
bun run example ios      # or: bun run example android
```

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

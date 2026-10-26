import {
  type BleError,
  type CharacteristicOptions,
  type Device,
  getDevice,
  startScan,
} from '@wekor/react-native-ble';
import {
  characteristics,
  commands,
  crc32,
  EXTRA_SERVICE,
  parseFileStatus,
  parseSinkStats,
  readU32,
  SERVICE,
  sequenceOf,
  sinkPacket,
  USER_DESCRIPTION,
} from './protocol';
import { bytesToText } from '@/lib/text';

/** The test peripheral a Mac runs, as an app talks to it: every method is one exchange of its protocol. */
export class TestPeripheral {
  constructor(readonly device: Device) {}

  static fromId(id: string) {
    return new TestPeripheral(getDevice(id));
  }

  /** Scans for the peripheral's service and returns the first one heard. */
  static find(timeout = 10_000) {
    return new Promise<TestPeripheral>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(
          new Error(
            'Test peripheral not found: is example/scripts/test-peripheral.sh running?'
          )
        );
      }, timeout);
      const stop = startScan({
        services: [SERVICE],
        onFound: ({ device }) => {
          clearTimeout(timer);
          stop();
          resolve(new TestPeripheral(device));
        },
      });
    });
  }

  // Connection

  connect() {
    return this.device.connect();
  }

  disconnect() {
    return this.device.disconnect();
  }

  onDisconnect(listener: (error?: BleError) => void) {
    return this.device.onDisconnect(listener);
  }

  get hasExtraService() {
    return this.device.services.some(({ uuid }) => uuid === EXTRA_SERVICE);
  }

  // Reads

  /** The 512-byte PATTERN: longer than one packet, so it arrives as a long read. */
  readPattern() {
    return this.device.read(characteristics.pattern);
  }

  /**
   * The user description, without the NUL macOS ends it with: Android hands over the raw bytes, while iOS reads a
   * user description as text and drops it.
   */
  async readPatternDescription() {
    const value = await this.device.readDescriptor(
      characteristics.pattern,
      USER_DESCRIPTION
    );
    return bytesToText(value).replace(/\0+$/, '');
  }

  /** A number that grows by one on every read. */
  async readCounter() {
    return readU32(await this.device.read(characteristics.counter));
  }

  /** Always fails with an ATT error. */
  readError() {
    return this.device.read(characteristics.error);
  }

  /** Answers after the delay `setSlowDelay` set. */
  async readSlow(options?: CharacteristicOptions) {
    return bytesToText(await this.device.read(characteristics.slow, options));
  }

  /** Never answers. */
  readNever(options?: CharacteristicOptions) {
    return this.device.read(characteristics.never, options);
  }

  async readExtra() {
    return bytesToText(await this.device.read(characteristics.extra));
  }

  // Writes

  /** Writes `value` for ECHO to keep; `readEcho` returns it. */
  writeEcho(value: Uint8Array) {
    return this.device.write(characteristics.echo, value);
  }

  readEcho() {
    return this.device.read(characteristics.echo);
  }

  /** Writes sink packet `sequence` of `size` bytes without response. */
  writeSink(sequence: number, size: number) {
    return this.device.write(characteristics.sink, sinkPacket(sequence, size), {
      withoutResponse: true,
    });
  }

  resetSink() {
    return this.device.write(characteristics.control, commands.resetSink());
  }

  async readSinkStats() {
    return parseSinkStats(await this.device.read(characteristics.control));
  }

  // Notifications

  /** Calls `listener` with the sequence number of each notification on STREAM; returns the unsubscribe. */
  onNotification(
    listener: (sequence: number) => void,
    onError?: (error: BleError) => void
  ) {
    return this.device.subscribe(
      characteristics.stream,
      (value) => listener(sequenceOf(value)),
      { onError }
    );
  }

  /** Like `onNotification`, for indications on INDICATE. */
  onIndication(listener: (sequence: number) => void) {
    return this.device.subscribe(characteristics.indicate, (value) =>
      listener(sequenceOf(value))
    );
  }

  /** Asks the peripheral to notify `count` values of `size` bytes. */
  startNotifications(count: number, size: number) {
    return this.device.write(
      characteristics.control,
      commands.notify(count, size)
    );
  }

  /** Asks the peripheral to indicate `count` values of `size` bytes. */
  startIndications(count: number, size: number) {
    return this.device.write(
      characteristics.control,
      commands.indicate(count, size)
    );
  }

  // File transfer

  /**
   * Sends `file` in chunks as large as one write without response carries, then checks that the peripheral got
   * every byte with the same CRC-32. Writes without response wait for room in the radio's queue, so they need no
   * pacing; they also arrive in order, so the chunks need no sequence numbers.
   */
  async sendFile(
    file: Uint8Array,
    onProgress?: (sent: number, total: number) => void
  ) {
    await this.device.write(characteristics.control, commands.startFile());
    const chunk = this.device.maxWriteLength({ withoutResponse: true });
    for (let offset = 0; offset < file.length; offset += chunk) {
      const end = Math.min(offset + chunk, file.length);
      await this.device.write(
        characteristics.file,
        file.subarray(offset, end),
        {
          withoutResponse: true,
        }
      );
      onProgress?.(end, file.length);
    }
    // The read goes out after every write, so the peripheral has counted them all.
    const status = parseFileStatus(
      await this.device.read(characteristics.file)
    );
    if (status.bytes !== file.length || status.crc32 !== crc32(file))
      throw new Error(
        `The peripheral got ${status.bytes} of ${file.length} bytes, CRC-32 ${status.crc32.toString(16)}`
      );
  }

  // L2CAP

  /** The PSM of the peripheral's L2CAP channel. */
  async readPsm() {
    const value = await this.device.read(characteristics.psm);
    return (value[0] ?? 0) | ((value[1] ?? 0) << 8);
  }

  /** Opens the peripheral's L2CAP channel, which echoes what it receives. */
  async openChannel() {
    return this.device.openL2capChannel(await this.readPsm());
  }

  // Test controls

  greetOnNextChannel(count: number) {
    return this.device.write(
      characteristics.control,
      commands.greetOnNextChannel(count)
    );
  }

  discardOnNextChannel(count: number) {
    return this.device.write(
      characteristics.control,
      commands.discardOnNextChannel(count)
    );
  }

  setSlowDelay(ms: number) {
    return this.device.write(characteristics.control, commands.slowDelay(ms));
  }

  addExtraService() {
    return this.device.write(
      characteristics.control,
      commands.addExtraService()
    );
  }

  removeExtraService() {
    return this.device.write(
      characteristics.control,
      commands.removeExtraService()
    );
  }

  /** Stops advertising for `ms`, then starts again. */
  pauseAdvertising(ms: number) {
    return this.device.write(
      characteristics.control,
      commands.pauseAdvertising(ms)
    );
  }
}

/**
 * The test peripheral's GATT protocol: its UUIDs, the commands its CONTROL characteristic takes and the layout of
 * the values it returns. The peripheral runs on a Mac.
 */
const uuid = (suffix: string) => `8e1a${suffix}-6c1f-4b8f-9d3c-5a0b1c2d3e4f`;

/** The service it advertises: scan for this, since macOS leaves the local name out of the advertisement. */
export const SERVICE = uuid('0000');
/** Added and removed on command, to change the peripheral's services while connected. */
export const EXTRA_SERVICE = uuid('1000');

export const characteristics = {
  /** Notifies `count` values of `size` bytes on command, each starting with its sequence number. */
  stream: uuid('0001'),
  /** Write without response; counts what arrives. */
  sink: uuid('0002'),
  /** Takes the commands below; a read returns the sink's statistics. */
  control: uuid('0003'),
  /** Like `sink`, with responses. */
  sinkAck: uuid('0004'),
  /** Indicates `count` values of `size` bytes on command. */
  indicate: uuid('0005'),
  /** 512 bytes, byte i = i & 0xff, with a user description descriptor (2901) "Pattern". */
  pattern: uuid('0006'),
  /** A u32 that grows by one on every read. */
  counter: uuid('0007'),
  /** Returns what was last written. */
  echo: uuid('0008'),
  /** Always answers ATT error 0x0E (unlikely error). */
  error: uuid('0009'),
  /** Needs an encrypted link, so reading it pairs. */
  encrypted: uuid('000a'),
  /** The u16 PSM of an L2CAP channel that echoes what it receives. */
  psm: uuid('000b'),
  /** Answers after the delay `slowDelay` set (1500 ms at start). */
  slow: uuid('000c'),
  /** Never answers. */
  never: uuid('000d'),
  /** Takes a file in chunks written without response; a read returns what arrived. */
  file: uuid('000e'),
  /** Write without response; each write comes straight back as a notification. */
  ping: uuid('000f'),
  /** The extra service's one characteristic: reads "extra". */
  extra: uuid('1001'),
} as const;

/** The user description descriptor PATTERN carries. */
export const USER_DESCRIPTION = '2901';

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number) => [...u16(value), ...u16(value >>> 16)];

/** What to write to CONTROL. */
export const commands = {
  /** Notify `count` values of `size` bytes on `stream` (at most what the link allows). */
  notify: (count: number, size: number) =>
    new Uint8Array([1, ...u32(count), ...u16(size)]),
  resetSink: () => new Uint8Array([2]),
  /** Indicate `count` values of `size` bytes on `indicate`. */
  indicate: (count: number, size: number) =>
    new Uint8Array([3, ...u32(count), ...u16(size)]),
  addExtraService: () => new Uint8Array([4]),
  removeExtraService: () => new Uint8Array([5]),
  /** Stop advertising for `ms`, then start again. */
  pauseAdvertising: (ms: number) => new Uint8Array([6, ...u32(ms)]),
  slowDelay: (ms: number) => new Uint8Array([8, ...u32(ms)]),
  /** Start a new file on `file`. */
  startFile: () => new Uint8Array([9]),
  /** Have the next L2CAP channel send `count` bytes, byte i = i & 0xff, as soon as it opens. */
  greetOnNextChannel: (count: number) => new Uint8Array([10, ...u32(count)]),
  /** Have the next L2CAP channel discard the first `count` bytes it receives, then send one byte. */
  discardOnNextChannel: (count: number) => new Uint8Array([11, ...u32(count)]),
};

/** The little-endian u32 at `at`. */
export const readU32 = (data: Uint8Array, at = 0) =>
  ((data[at] ?? 0) |
    ((data[at + 1] ?? 0) << 8) |
    ((data[at + 2] ?? 0) << 16) |
    ((data[at + 3] ?? 0) << 24)) >>>
  0;

/** A streamed value or sink packet: its first four bytes are its sequence number. */
export const sequenceOf = (value: Uint8Array) => readU32(value);

/** A packet for SINK, SINK_ACK or PING: sequence number `sequence`, `size` bytes in all. */
export const sinkPacket = (sequence: number, size: number) => {
  const value = new Uint8Array(size);
  value.set(u32(sequence));
  return value;
};

type SinkStats = {
  packets: number;
  bytes: number;
  outOfOrder: number;
  /** From the first write to the last. */
  spanMs: number;
};

/** A read of CONTROL. */
export const parseSinkStats = (value: Uint8Array): SinkStats => ({
  packets: readU32(value, 0),
  bytes: readU32(value, 4),
  outOfOrder: readU32(value, 8),
  spanMs: readU32(value, 12),
});

/** A read of FILE: how many bytes arrived since `startFile`, and their CRC-32. */
export const parseFileStatus = (value: Uint8Array) => ({
  bytes: readU32(value, 0),
  crc32: readU32(value, 4),
});

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

/** CRC-32 (IEEE 802.3), the checksum zip and PNG use; the peripheral computes the same over a file. */
export const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

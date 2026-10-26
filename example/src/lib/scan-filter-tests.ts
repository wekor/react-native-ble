import {
  type ScanFilter,
  type ScanResult,
  startScan,
} from '@wekor/react-native-ble';
import type { Log } from '@/hooks/use-log';
import { toHex } from './hex';
import { sleep } from './wait';

const SCAN_MS = 2_500;

/** Hardware cases start their own native scan; this spacing stays within Android's 5 starts per 30 s. */
const HARDWARE_SPACING_MS = 7_000;

/**
 * Android's scan-start window: the software cases restart the scan often enough to use up its 5 starts, and the
 * library delays a start past the limit, so a hardware case right after them would scan after its window closed.
 */
const SCAN_START_WINDOW_MS = 30_000;

const fullUuid = (uuid: string) =>
  uuid.length === 4
    ? `0000${uuid}-0000-1000-8000-00805f9b34fb`.toLowerCase()
    : uuid.toLowerCase();

const companyOf = (data: Uint8Array) => data[0]! | (data[1]! << 8);

/** `actual` starts with `expected`, comparing the bits `mask` sets: the rule the C++ hub must follow. */
const startsWith = (
  actual: Uint8Array,
  expected: number[],
  mask: number[] = []
) =>
  actual.length >= expected.length &&
  expected.every(
    (byte, i) =>
      ((actual[i] ?? 0) & (mask[i] ?? 0xff)) === (byte & (mask[i] ?? 0xff))
  );

/** The same decision as the library, made again in JS, to check every result it delivered. */
const matches = (filter: ScanFilter, result: ScanResult) => {
  const name = result.device.name;
  if (filter.name !== undefined && name !== filter.name) return false;
  if (filter.namePrefix !== undefined && !name?.startsWith(filter.namePrefix))
    return false;
  if (filter.manufacturerData) {
    const {
      companyId,
      data: expected = new Uint8Array(),
      mask,
    } = filter.manufacturerData;
    // Android lists every entry, and the library matches any of them; iOS has only the first.
    const entries =
      result.android?.manufacturerEntries ??
      (result.manufacturerData ? [result.manufacturerData] : []);
    const matching = entries.some(
      (data) =>
        data.length >= 2 &&
        companyOf(data) === companyId &&
        startsWith(
          data.subarray(2),
          [...expected],
          mask ? [...mask] : undefined
        )
    );
    if (!matching) return false;
  }
  if (filter.serviceData) {
    const data = result.serviceData[fullUuid(filter.serviceData.uuid)];
    const { data: expected = new Uint8Array(), mask } = filter.serviceData;
    if (!data || !startsWith(data, [...expected], mask ? [...mask] : undefined))
      return false;
  }
  return true;
};

type Case = {
  name: string;
  filters: ScanFilter[];
  services?: string[];
  /** Whether the target device must be among the results. */
  expectTarget: boolean;
  /** The fewest results the scan must deliver. */
  minResults?: number;
  /** Also run alone, so its filters go to the Bluetooth chip; such cases must expect matches. */
  hardware?: boolean;
};

const bytes = (...values: number[]) => new Uint8Array(values);

/** The nearby device to test against: one advertising a name and manufacturer data, the more the better. */
const pickTarget = (results: ScanResult[]) => {
  const score = (result: ScanResult) =>
    (result.device.name ? 1 : 0) +
    ((result.manufacturerData?.length ?? 0) >= 3 ? 2 : 0) +
    (Object.keys(result.serviceData).length ? 1 : 0) +
    (result.serviceUuids.length ? 1 : 0);
  return [...results]
    .filter((result) => result.device.name && result.manufacturerData?.length)
    .sort((a, b) => score(b) - score(a) || b.rssi - a.rssi)[0];
};

/** Cases built from the target's own advertisement, so they run against any device. */
const casesFor = (target: ScanResult, others: ScanResult[]): Case[] => {
  const name = target.device.name!;
  const prefix = name.slice(0, Math.min(3, name.length));
  const data = target.manufacturerData!;
  const company = companyOf(data);
  const first = data[2];
  const cases: Case[] = [
    {
      name: `name = ${name}`,
      filters: [{ name }],
      expectTarget: true,
      hardware: true,
    },
    {
      name: `name = ${name}x`,
      filters: [{ name: `${name}x` }],
      expectTarget: false,
    },
    {
      name: `namePrefix ${prefix}`,
      filters: [{ namePrefix: prefix }],
      expectTarget: true,
    },
    {
      name: `mfr id 0x${company.toString(16)}`,
      filters: [{ manufacturerData: { companyId: company } }],
      expectTarget: true,
    },
    {
      name: 'OR: name nope | mfr id',
      filters: [{ name: 'nope' }, { manufacturerData: { companyId: company } }],
      expectTarget: true,
    },
  ];
  if (prefix.toLowerCase() !== prefix) {
    cases.push({
      name: `namePrefix ${prefix.toLowerCase()} (case)`,
      filters: [{ namePrefix: prefix.toLowerCase() }],
      expectTarget: false,
    });
  }
  if (first !== undefined) {
    cases.push(
      {
        name: `mfr id + data ${toHex(bytes(first))}`,
        filters: [
          { manufacturerData: { companyId: company, data: bytes(first) } },
        ],
        expectTarget: true,
        hardware: true,
      },
      {
        name: `mfr id + data ${toHex(bytes(first ^ 0xff))}`,
        filters: [
          {
            manufacturerData: { companyId: company, data: bytes(first ^ 0xff) },
          },
        ],
        expectTarget: false,
      },
      {
        name: `mfr data ${toHex(bytes(first & 0xf0))} mask f0`,
        filters: [
          {
            manufacturerData: {
              companyId: company,
              data: bytes(first & 0xf0),
              mask: bytes(0xf0),
            },
          },
        ],
        expectTarget: true,
      }
    );
  }
  const [serviceUuid, serviceValue] =
    Object.entries(target.serviceData)[0] ?? [];
  if (serviceUuid && serviceValue?.length) {
    const value = serviceValue[0]!;
    cases.push(
      {
        name: `serviceData = ${toHex(bytes(value))}`,
        filters: [{ serviceData: { uuid: serviceUuid, data: bytes(value) } }],
        expectTarget: true,
        hardware: true,
      },
      {
        name: `serviceData = ${toHex(bytes(value ^ 0xff))}`,
        filters: [
          { serviceData: { uuid: serviceUuid, data: bytes(value ^ 0xff) } },
        ],
        expectTarget: false,
      }
    );
  }
  const service = target.serviceUuids[0];
  if (service) {
    cases.push({
      name: 'advertised service + namePrefix',
      services: [service],
      filters: [{ namePrefix: prefix }],
      expectTarget: true,
    });
  }
  // A manufacturer other devices around use and the target doesn't: matches without the target.
  const other = others
    .map((result) => result.manufacturerData)
    .find(
      (entry) => entry && entry.length >= 2 && companyOf(entry) !== company
    );
  if (other) {
    const id = companyOf(other);
    cases.push(
      {
        name: `other mfr id 0x${id.toString(16)}`,
        filters: [{ manufacturerData: { companyId: id } }],
        expectTarget: false,
        minResults: 1,
        hardware: true,
      },
      {
        name: `other mfr id 0x${id.toString(16)}, software only`,
        // `namePrefix` cannot go to the chip, so the C++ hub alone decides.
        filters: [
          { manufacturerData: { companyId: id } },
          { namePrefix: '\u0000' },
        ],
        expectTarget: false,
        minResults: 1,
      }
    );
  }
  return cases;
};

const scanFor = async (
  ms: number,
  options: { services?: string[]; filters?: ScanFilter[] } = {}
) => {
  const results: ScanResult[] = [];
  let errors = 0;
  const stop = startScan({
    ...options,
    onFound: (result) => results.push(result),
    onError: () => errors++,
  });
  await sleep(ms);
  stop();
  return { results, errors };
};

/**
 * Every scan filter against real advertisements of a nearby device, each result re-checked in JS. Picks a device
 * that advertises a name and manufacturer data, and builds the cases from its advertisement.
 */
export const runScanFilterTests = async (log: Log) => {
  const { results: around } = await scanFor(3_000);
  const target = pickTarget(around);
  if (!target) {
    log(
      'filter tests: no nearby device advertises a name and manufacturer data',
      'error'
    );
    return;
  }
  const cases = casesFor(
    target,
    around.filter((result) => result.device.id !== target.device.id)
  );
  log(`filter tests against ${target.device.name} (${target.device.id})`, 'tx');

  /** With `heard`, a case during which nothing at all was heard is inconclusive: no scan ran. */
  const check = async (testCase: Case, heard?: () => number) => {
    const before = heard?.();
    const { results, errors } = await scanFor(SCAN_MS, {
      services: testCase.services,
      filters: testCase.filters,
    });
    if (heard && heard() === before)
      return `? ${testCase.name}: no advertisements heard, inconclusive`;
    const wrong = results.filter(
      (result) => !testCase.filters.some((filter) => matches(filter, result))
    );
    const seen = results.some(
      (result) => result.device.id === target.device.id
    );
    const ok =
      wrong.length === 0 &&
      errors === 0 &&
      seen === testCase.expectTarget &&
      results.length >= (testCase.minResults ?? 0);
    return `${ok ? '✓' : '✗'} ${testCase.name}: ${results.length} results, ${wrong.length} wrong, target ${seen ? 'seen' : 'not seen'}${errors ? `, ${errors} errors` : ''}`;
  };
  const report = (line: string) =>
    log(line, line.startsWith('✓') ? 'rx' : 'error');

  // Software: an unfiltered scan keeps one native scan running unchanged, so the C++ hub alone filters.
  let lines: string[] = [];
  let heard = 0;
  const stopBase = startScan({
    allowDuplicates: true,
    onFound: () => heard++,
  });
  await sleep(1_000);
  for (const testCase of cases) {
    const line = await check(testCase, () => heard);
    report(`software ${line}`);
    lines.push(line);
  }
  stopBase();
  const software = lines.filter((line) => line.startsWith('✓')).length;

  // Hardware: each case alone, so its filters go to the Bluetooth chip. Every one expects matches, so a scan
  // that never ran fails rather than passes.
  const hardwareCases = cases.filter((testCase) => testCase.hardware);
  await sleep(SCAN_START_WINDOW_MS);
  lines = [];
  for (const testCase of hardwareCases) {
    await sleep(HARDWARE_SPACING_MS - SCAN_MS);
    const line = await check(testCase);
    report(`hardware ${line}`);
    lines.push(line);
  }
  const hardware = lines.filter((line) => line.startsWith('✓')).length;
  log(
    `filter tests: software ${software}/${cases.length}, hardware ${hardware}/${hardwareCases.length}`,
    software === cases.length && hardware === hardwareCases.length
      ? 'rx'
      : 'error'
  );
};

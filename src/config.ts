import type { LogEntry, LogLevel } from './types';

const LOG_LEVELS: readonly (LogLevel | 'off')[] = [
  'debug',
  'info',
  'warn',
  'error',
  'off',
];

const consoleLogger = ({ level, message, deviceId, details }: LogEntry) => {
  const prefix = deviceId ? `[ble ${deviceId}]` : '[ble]';
  console[level](prefix, message, ...(details ? [details] : []));
};

export const settings = {
  timeouts: { connect: 10_000, operation: 30_000 },
  logLevel: 'warn' as LogLevel | 'off',
  logger: consoleLogger as (entry: LogEntry) => void,
};

export const log = (entry: LogEntry) => {
  if (LOG_LEVELS.indexOf(entry.level) < LOG_LEVELS.indexOf(settings.logLevel))
    return;
  settings.logger(entry);
};

export const operationTimeout = (timeout?: number) =>
  timeout ?? settings.timeouts.operation;

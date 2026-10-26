export type BleErrorCode =
  | 'unauthorized'
  | 'bluetooth-off'
  | 'unsupported'
  | 'timeout'
  | 'cancelled'
  | 'disconnected'
  | 'not-connected'
  | 'connection-failed'
  | 'not-found'
  | 'ambiguous'
  | 'not-permitted'
  | 'invalid-argument'
  | 'scan-throttled'
  | 'scan-failed'
  | 'bond-failed'
  | 'gatt'
  | 'unknown';

/** The one error type the library rejects with; switch on `code`, which is the same on both platforms. */
export class BleError extends Error {
  readonly code: BleErrorCode;
  readonly nativeCode?: number;
  readonly nativeDomain?: string;

  constructor(
    code: BleErrorCode,
    message: string,
    native?: { nativeCode?: number; nativeDomain?: string }
  ) {
    super(message);
    this.name = 'BleError';
    this.code = code;
    this.nativeCode = native?.nativeCode;
    this.nativeDomain = native?.nativeDomain;
  }
}

export const isBleError = (
  error: unknown,
  code?: BleErrorCode
): error is BleError =>
  error instanceof BleError && (code === undefined || error.code === code);

/** An error as native sends it in a `result` or event payload. */
export type NativeError = {
  code: BleErrorCode;
  message: string;
  nativeCode?: number;
  nativeDomain?: string;
};

export const errorOf = (error: NativeError) =>
  new BleError(error.code, error.message, error);

/** `error` as a `BleError`; anything else becomes one with code `unknown`. */
export const toBleError = (error: unknown) =>
  error instanceof BleError ? error : new BleError('unknown', String(error));

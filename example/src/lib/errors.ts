/** A BleError as `code: message (nativeCode)`, another Error as its message, anything else as its string. */
export const errorText = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code, message, nativeCode } = error as {
      code: string;
      message: string;
      nativeCode?: number;
    };
    return `${code}: ${message}${nativeCode === undefined ? '' : ` (${nativeCode})`}`;
  }
  return error instanceof Error ? error.message : String(error);
};

/** The short name of an error from either library: our `code`, plx's `errorCode`, else its message. */
export const errorCode = (error: unknown) => {
  const { code, errorCode, message } = (error ?? {}) as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
  };
  return String(code ?? errorCode ?? message ?? error);
};

/** Settled results counted by outcome: `12 ok, 3 disconnected`. */
export const tally = (results: PromiseSettledResult<unknown>[]) => {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key = result.status === 'fulfilled' ? 'ok' : errorCode(result.reason);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => `${count} ${key}`)
    .join(', ');
};

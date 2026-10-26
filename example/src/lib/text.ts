/** UTF-8 bytes of `text`. */
export const textToBytes = (text: string) =>
  Uint8Array.from(unescape(encodeURIComponent(text)), (char) =>
    char.charCodeAt(0)
  );

/**
 * `bytes` decoded as UTF-8; bytes that aren't valid UTF-8 come out as Latin-1. Hermes has no TextDecoder, so this
 * goes through URI encoding instead.
 */
export const bytesToText = (bytes: Uint8Array) => {
  const latin1 = String.fromCharCode(...bytes);
  try {
    return decodeURIComponent(escape(latin1));
  } catch {
    return latin1;
  }
};

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const timedOut = (what: string) => new Error(`Timed out waiting for ${what}`);

/** `promise`, or a rejection if it has not settled after `ms`. */
export const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    sleep(ms).then(() => Promise.reject<never>(timedOut(what))),
  ]);

/** Polls `done` until it holds; throws after `ms`. */
export const waitFor = async (
  what: string,
  done: () => boolean,
  ms: number
) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw timedOut(what);
    await sleep(20);
  }
};

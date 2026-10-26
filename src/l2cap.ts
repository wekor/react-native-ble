import { type BleError, errorOf } from './errors';
import { Listeners } from './listeners';
import { native, putBytes, request, setEventHandler } from './native';
import type { L2capChannel } from './types';

type Channel = {
  data: Listeners<(value: Uint8Array) => void>;
  close: Listeners<(error?: BleError) => void>;
  /**
   * Chunks that arrived before the first data listener, which gets them as it is added; null from then on. The
   * device may send as soon as the channel opens, before the caller's code after `await` has run.
   */
  early: Uint8Array[] | null;
  /** Set once the channel has closed, so a close listener added later still learns of it. */
  closed?: { error?: BleError };
};

const channels = new Map<number, Channel>();

/** Registers a channel native has just opened; call it inside the open's `result`, before any of its events. */
export const createL2capChannel = (
  channelId: number,
  psm: number
): L2capChannel => {
  const channel: Channel = {
    data: new Listeners(),
    close: new Listeners(),
    early: [],
  };
  channels.set(channelId, channel);
  return {
    psm,
    write: (value) =>
      request((opId) =>
        native.writeL2capChannel(opId, channelId, putBytes(value))
      ),
    onData: (listener) => {
      const remove = channel.data.add(listener);
      const { early } = channel;
      if (early) {
        channel.early = null;
        for (const value of early) listener(value);
      }
      return remove;
    },
    onClose: (listener) => {
      if (channel.closed) {
        listener(channel.closed.error);
        return () => {};
      }
      return channel.close.add(listener);
    },
    close: () => request((opId) => native.closeL2capChannel(opId, channelId)),
  };
};

setEventHandler('l2capData', ({ channelId, value }) => {
  const channel = channels.get(channelId);
  if (!channel) return;
  if (channel.early) {
    channel.early.push(value);
    return;
  }
  // Every listener but the last gets a copy, made before the last sees `value`, so none can mutate another's.
  const listeners = channel.data.list();
  const last = listeners.length - 1;
  for (let i = 0; i < listeners.length; i++)
    listeners[i]!(i === last ? value : value.slice());
});

setEventHandler('l2capClosed', ({ channelId, error }) => {
  const channel = channels.get(channelId);
  if (!channel) return;
  channels.delete(channelId);
  channel.closed = { error: error ? errorOf(error) : undefined };
  for (const listener of channel.close.list()) listener(channel.closed.error);
  channel.close.clear();
});

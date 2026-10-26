import { expect, test } from 'bun:test';
import { answer, callsOf, connectedDevice as connected, emit } from './native';

await import('../index');

const data = (channelId: number, ...bytes: number[]) =>
  emit('l2capData', { channelId, value: new Uint8Array(bytes) });

// Native delivers events in batches and promise continuations run after the batch, so these tests emit the open's
// result and the events following it synchronously, as one batch would.

test('data in the same batch as the open reaches the first listener, in order', async () => {
  const device = await connected();
  const opening = device.openL2capChannel(0x80);
  answer(callsOf('openL2capChannel').at(-1), { channelId: 101 });
  data(101, 1, 2);
  data(101, 3);
  const channel = await opening;
  const received: number[] = [];
  channel.onData((value) => received.push(...value));
  data(101, 4);
  expect(received).toEqual([1, 2, 3, 4]);
});

test('data is kept only until the first listener', async () => {
  const device = await connected();
  const opening = device.openL2capChannel(0x80);
  answer(callsOf('openL2capChannel').at(-1), { channelId: 102 });
  const channel = await opening;
  const first: number[] = [];
  channel.onData((value) => first.push(...value))();
  data(102, 1);
  const second: number[] = [];
  channel.onData((value) => second.push(...value));
  data(102, 2);
  expect(first).toEqual([]);
  expect(second).toEqual([2]);
});

test('a close in the same batch as the open reaches a listener added later', async () => {
  const device = await connected();
  const opening = device.openL2capChannel(0x80);
  answer(callsOf('openL2capChannel').at(-1), { channelId: 103 });
  data(103, 1);
  emit('l2capClosed', {
    channelId: 103,
    error: { code: 'disconnected', message: 'gone' },
  });
  const channel = await opening;
  const received: number[] = [];
  const reasons: (string | undefined)[] = [];
  channel.onData((value) => received.push(...value));
  channel.onClose((error) => reasons.push(error?.code));
  expect(received).toEqual([1]);
  expect(reasons).toEqual(['disconnected']);
});

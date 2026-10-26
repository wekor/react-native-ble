import { beforeEach, expect, test } from 'bun:test';
import type { RestoredState } from '../index';
import { answer, calls, callsOf, emit, services } from './native';

const { configure, getPermission } = await import('../index');

beforeEach(() => {
  calls.length = 0;
});

test('a restore adopts connected devices and runs pending connects again without a time limit', async () => {
  emit('restore', {
    connected: [{ id: 'restored', mtu: 185, services }],
    connecting: [{ id: 'pending', name: 'Pending' }],
    scan: { services: ['180d'] },
  });
  const connects = callsOf('connect');
  expect(connects.map((call) => call.args[1])).toEqual(['pending']);
  expect(connects[0]?.args[2]).toMatchObject({ timeout: 0 });

  let state: RestoredState | undefined;
  configure({ ios: { onRestore: (restored) => (state = restored) } });
  const [connected] = state?.connected ?? [];
  const [connecting] = state?.connecting ?? [];
  if (!connected || !connecting) throw new Error('Nothing restored');
  expect(connected.state).toBe('connected');
  expect(connected.mtu).toBe(185);
  expect(connecting.name).toBe('Pending');
  expect(connecting.state).toBe('disconnected');
  expect(state?.scan).toEqual({ services: ['180d'] });

  // The app's own connect() is the pending one.
  const connect = connecting.connect();
  expect(callsOf('connect')).toHaveLength(1);
  answer(connects[0], { mtu: 185, services });
  await connect;
  expect(connecting.state).toBe('connected');
});

test('getPermission answers in the shape of Expo responses', async () => {
  const pending = getPermission();
  answer(callsOf('getPermission')[0], { status: 'denied', canAskAgain: false });
  expect(await pending).toEqual({
    status: 'denied',
    granted: false,
    canAskAgain: false,
    expires: 'never',
  });
});

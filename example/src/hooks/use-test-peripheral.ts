import type { BleError, ConnectionState } from '@wekor/react-native-ble';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { TestPeripheral } from '@/lib/test-peripheral';

/**
 * The test peripheral the route's `id` names, its connection state as it changes, and why the last connection
 * ended when the device or the system ended it.
 */
export const useTestPeripheral = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  const peripheral = useMemo(() => TestPeripheral.fromId(id), [id]);
  const [state, setState] = useState<ConnectionState>(peripheral.device.state);
  const [disconnectReason, setDisconnectReason] = useState<BleError>();
  useEffect(() => {
    setState(peripheral.device.state);
    const offState = peripheral.device.onStateChange((next) => {
      setState(next);
      if (next === 'connecting') setDisconnectReason(undefined);
    });
    // Called without an error when the app disconnected.
    const offDisconnect = peripheral.onDisconnect(setDisconnectReason);
    return () => {
      offState();
      offDisconnect();
    };
  }, [peripheral]);
  return { peripheral, state, disconnectReason };
};

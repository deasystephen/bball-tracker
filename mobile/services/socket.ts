/**
 * Socket.io client singleton.
 *
 * One persistent connection per app launch. Lazily constructed on first
 * `getSocket()` call. The auth token is supplied via a callback so reconnects
 * pick up a rotated token without recreating the socket.
 *
 * RN note: pin transport to ['websocket']. The polling fallback works poorly
 * on iOS/Android and adds latency.
 */

import Constants from 'expo-constants';
import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../store/auth-store';

const getBaseURL = (): string => {
  return (
    Constants.expoConfig?.extra?.apiUrl ||
    (__DEV__ ? 'http://127.0.0.1:3000' : 'https://api.capyhoops.com')
  );
};

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(getBaseURL(), {
    transports: ['websocket'],
    reconnection: true,
    autoConnect: true,
    auth: (cb) => {
      const token = useAuthStore.getState().accessToken;
      cb({ token: token ?? '' });
    },
  });

  return socket;
}

export function resetSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
}

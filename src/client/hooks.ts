import { useEffect, useState, useSyncExternalStore } from 'react';
import { client, type ClientState } from './net/client';

export function useClientState(): ClientState {
  return useSyncExternalStore(client.subscribe, client.getState);
}

/** 서버 시계 보정된 남은 초 (deadline 없으면 null) */
export function useRemainingSeconds(deadline: number | null | undefined): number | null {
  const [now, setNow] = useState(() => client.serverNow());
  useEffect(() => {
    if (deadline == null) return;
    const t = setInterval(() => setNow(client.serverNow()), 250);
    setNow(client.serverNow());
    return () => clearInterval(t);
  }, [deadline]);
  if (deadline == null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_TIMEZONE, type AppContext, type Family } from '../domain/types';
import type { SyncSnapshot } from '../repo/serverRepository';
import type { Services } from './services';

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext가 없어요.');
  return s;
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export const POLL_MS = 5000;

/** 서버 문서 동기화 상태 (version, 충돌, 다른 기기 변경, 연결 끊김) */
export function useSyncSnapshot(): SyncSnapshot {
  const { server } = useServices();
  return useSyncExternalStore(server.sync.subscribe, server.sync.getSnapshot, server.sync.getSnapshot);
}

/** 서버 값을 다시 불러오고 화면 조회를 갱신한다 */
export function useReloadFromServer() {
  const { server, queryClient } = useServices();
  return async () => {
    await server.reloadFromServer();
    await queryClient.invalidateQueries();
  };
}

/**
 * 5초마다 서버 version을 확인한다. 기본은 알림만 하고 문서를 교체하지 않는다(편집 중 보호).
 * 읽기 전용 화면(TV)만 autoApply로 새 문서를 자동 반영한다.
 */
export function useRemoteSync(autoApply = false) {
  const { server } = useServices();
  const snap = useSyncSnapshot();
  const reload = useReloadFromServer();
  useEffect(() => {
    const t = setInterval(() => void server.poll(), POLL_MS);
    return () => clearInterval(t);
  }, [server]);
  const pending = autoApply && snap.remoteVersion !== null;
  useEffect(() => {
    if (pending) void reload().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, snap.remoteVersion]);
  return snap;
}

/** 로그인/기기 상태. 모든 라우트가 이 값을 기준으로 이동한다. */
export function useAppCtx() {
  const { repo, deviceStore, queryClient } = useServices();
  const q = useQuery<AppContext>({ queryKey: ['ctx'], queryFn: () => repo.getAppContext(), staleTime: 0, refetchOnWindowFocus: true });
  useEffect(() => deviceStore.subscribe(() => void queryClient.invalidateQueries({ queryKey: ['ctx'] })), [deviceStore, queryClient]);
  return q;
}

export interface SessionInfo {
  kind: 'adult' | 'device';
  familyId: string;
  familyName: string;
  /** 캐시/outbox namespace: 가족 ID + 사용자(또는 기기) */
  ns: string;
  tz: string;
  userId: string | null;
  email: string | null;
  isOwner: boolean;
  displayName: string | null;
}

const SessionContext = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionContext가 없어요.');
  return s;
}

export function SessionProvider({ ctx, children }: { ctx: Extract<AppContext, { kind: 'adult' | 'device' }>; children: ReactNode }) {
  const { repo } = useServices();
  const isDevice = ctx.kind === 'device';
  const familyId = ctx.kind === 'device' ? ctx.familyId : (ctx.family?.id ?? '');
  const ns = ctx.kind === 'device' ? `${familyId}:device` : `${familyId}:${ctx.session.userId}`;
  // 기기는 ctx에 timezone이 없으므로 getFamily 로 가져온다 (실패해도 기본값으로 동작)
  const fam = useQuery<Family>({ queryKey: ['data', ns, 'family'], queryFn: () => repo.getFamily(), enabled: isDevice, staleTime: 60_000 });
  const adultFamily = ctx.kind === 'adult' ? ctx.family : null;
  const tz = adultFamily?.timezone ?? fam.data?.timezone ?? DEFAULT_TIMEZONE;
  const value = useMemo<SessionInfo>(
    () => ({
      kind: ctx.kind,
      familyId,
      familyName: ctx.kind === 'device' ? ctx.familyName : (adultFamily?.name ?? ''),
      ns,
      tz,
      userId: ctx.kind === 'adult' ? ctx.session.userId : null,
      email: ctx.kind === 'adult' ? ctx.session.email : null,
      isOwner: ctx.kind === 'adult' && ctx.member?.role === 'owner',
      displayName: ctx.kind === 'adult' ? (ctx.member?.displayName ?? null) : null,
    }),
    [ctx, familyId, ns, tz, adultFamily],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** 부모 PIN 해제 상태 (메모리 전용, 15분) */
export function useUnlocked(): boolean {
  const { unlockStore } = useServices();
  return useSyncExternalStore(
    (cb) => unlockStore.subscribe(cb),
    () => unlockStore.isUnlocked(),
    () => false,
  );
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · 몽글 패밀리보드`;
  }, [title]);
}

export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const dkey = (ns: string, ...rest: unknown[]) => ['data', ns, ...rest] as const;

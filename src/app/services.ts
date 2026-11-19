import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { isFamilyBoardError } from '../domain/errors';
import { CacheStore } from '../offline/cache';
import { Outbox } from '../offline/outbox';
import type { FullRepository } from '../repo/repository';
import { ServerBackedRepository } from '../repo/serverRepository';
import { DeviceStore, MemoryStorage, UnlockStore } from '../repo/stores';
import { ServerApi } from '../server/api';

export type AdapterKind = 'server';

export interface Services {
  adapter: AdapterKind;
  /** 서버 문서에 연결된 repository (모든 쓰기는 서버 저장 뒤에 성공한다) */
  repo: FullRepository;
  server: ServerBackedRepository;
  api: ServerApi;
  deviceStore: DeviceStore;
  unlockStore: UnlockStore;
  /** 이전 버전이 남긴 로컬 대기열/캐시 삭제용 (서버 모드는 로컬 대기열을 쓰지 않는다) */
  outbox: Outbox;
  cache: CacheStore;
  queryClient: QueryClient;
}

export interface ServiceOptions {
  api?: ServerApi;
}

export function createQueryClient(onAuthLost: (e: unknown) => void): QueryClient {
  const handle = (e: unknown) => {
    if (isFamilyBoardError(e) && (e.code === 'TOKEN_REVOKED' || e.code === 'UNAUTHENTICATED')) onAuthLost(e);
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: handle }),
    mutationCache: new MutationCache({ onError: handle }),
    defaultOptions: {
      queries: {
        networkMode: 'always',
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (count, e) => isFamilyBoardError(e) && e.code === 'NETWORK_ERROR' && count < 1,
        retryDelay: 800,
      },
      mutations: { networkMode: 'always', retry: false },
    },
  });
}

export function createServices(opts: ServiceOptions = {}): Services {
  const api = opts.api ?? new ServerApi();
  const deviceStore = new DeviceStore(new MemoryStorage());
  const unlockStore = new UnlockStore();
  const outbox = new Outbox();
  const cache = new CacheStore();
  let queryClientRef: QueryClient | null = null;
  const onSessionLost = () => void queryClientRef?.invalidateQueries({ queryKey: ['ctx'] });
  const queryClient = createQueryClient(() => void queryClientRef?.invalidateQueries({ queryKey: ['ctx'] }));
  queryClientRef = queryClient;
  const server = new ServerBackedRepository(api, unlockStore, onSessionLost);
  return { adapter: 'server', repo: server.repo, server, api, deviceStore, unlockStore, outbox, cache, queryClient };
}

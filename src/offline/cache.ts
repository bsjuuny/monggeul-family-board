// 조회 캐시 영속화 (IndexedDB). 가족/사용자 namespace로 분리하고 로그아웃·기기 철회 시 삭제한다.
import { dehydrate, hydrate, type QueryClient } from '@tanstack/react-query';

const DB = 'mgfb-cache';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function wrap<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const rq = fn(tx.objectStore(STORE));
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

export class CacheStore {
  private mem = new Map<string, unknown>();
  private dbp: Promise<IDBDatabase> | null = null;
  private useMem = typeof indexedDB === 'undefined';

  private db() {
    return (this.dbp ??= open());
  }

  async get<T>(ns: string): Promise<T | undefined> {
    if (this.useMem) return this.mem.get(ns) as T | undefined;
    return (await wrap(await this.db(), 'readonly', (s) => s.get(ns))) as T | undefined;
  }

  async set(ns: string, value: unknown): Promise<void> {
    if (this.useMem) {
      this.mem.set(ns, value);
      return;
    }
    await wrap(await this.db(), 'readwrite', (s) => s.put(value, ns));
  }

  async clearAll(): Promise<void> {
    this.mem.clear();
    if (this.useMem) return;
    await wrap(await this.db(), 'readwrite', (s) => s.clear());
  }
}

interface Persisted {
  savedAt: string;
  state: ReturnType<typeof dehydrate>;
}

export async function restoreCache(qc: QueryClient, cache: CacheStore, ns: string): Promise<string | null> {
  try {
    const p = await cache.get<Persisted>(ns);
    if (!p) return null;
    hydrate(qc, p.state);
    return p.savedAt;
  } catch {
    return null;
  }
}

/** 성공한 조회만 500ms debounce로 저장한다. 반환값은 해제 함수. */
export function attachCachePersistence(qc: QueryClient, cache: CacheStore, ns: string): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    const state = dehydrate(qc, {
      shouldDehydrateQuery: (q) => q.state.status === 'success' && q.queryKey[0] === 'data' && q.queryKey[1] === ns,
    });
    void cache.set(ns, { savedAt: new Date().toISOString(), state } satisfies Persisted).catch(() => undefined);
  };
  const unsub = qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  });
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}

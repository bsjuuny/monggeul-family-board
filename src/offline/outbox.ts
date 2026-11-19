// IndexedDB outbox. P0에서는 task 완료/취소와 habit 체크 2종만 쌓는다 (명세 §7, AC-10).
// 같은 대상(task / habit+날짜)에 대한 오프라인 변경은 최신 1건으로 합쳐 "1회 반영"을 보장한다.
import { FamilyBoardError, isFamilyBoardError } from '../domain/errors';
import type { OutboxAction } from '../domain/types';
import type { FullRepository } from '../repo/repository';

export interface OutboxEntry {
  /** = idempotencyKey */
  id: string;
  namespace: string;
  /** 합치기용 키 */
  target: string;
  action: OutboxAction;
  createdAt: string;
}

const DB_NAME = 'mgfb-outbox';
const STORE = 'entries';

function targetOf(a: OutboxAction): string {
  return a.type === 'task_completed' ? `task:${a.taskId}` : `habit:${a.habitId}:${a.localDate}`;
}

export function isAllowedOfflineAction(a: { type: string }): boolean {
  return a.type === 'task_completed' || a.type === 'habit_check';
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

type Listener = () => void;

export class Outbox {
  private dbp: Promise<IDBDatabase> | null = null;
  private mem: OutboxEntry[] | null = null; // IndexedDB를 쓸 수 없을 때 메모리 대체
  private listeners = new Set<Listener>();

  constructor(private dbName: string = DB_NAME) {
    if (typeof indexedDB === 'undefined') this.mem = [];
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const open = indexedDB.open(this.dbName, 1);
        open.onupgradeneeded = () => {
          const store = open.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('namespace', 'namespace');
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
    }
    return this.dbp;
  }

  async list(namespace: string): Promise<OutboxEntry[]> {
    let all: OutboxEntry[];
    if (this.mem) all = this.mem.filter((e) => e.namespace === namespace);
    else {
      const db = await this.db();
      all = await req(db.transaction(STORE).objectStore(STORE).index('namespace').getAll(namespace) as IDBRequest<OutboxEntry[]>);
    }
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async count(namespace: string): Promise<number> {
    return (await this.list(namespace)).length;
  }

  async add(namespace: string, action: OutboxAction): Promise<OutboxEntry> {
    if (!isAllowedOfflineAction(action)) {
      throw new FamilyBoardError('VALIDATION_ERROR', '이 작업은 오프라인에서 저장할 수 없어요.');
    }
    const entry: OutboxEntry = { id: action.idempotencyKey, namespace, target: targetOf(action), action, createdAt: new Date().toISOString() };
    const existing = (await this.list(namespace)).filter((e) => e.target === entry.target);
    if (this.mem) {
      this.mem = this.mem.filter((e) => !(e.namespace === namespace && e.target === entry.target));
      this.mem.push(entry);
    } else {
      const db = await this.db();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of existing) store.delete(e.id);
      store.put(entry);
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    }
    this.emit();
    return entry;
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    if (this.mem) this.mem = this.mem.filter((e) => !ids.includes(e.id));
    else {
      const db = await this.db();
      const tx = db.transaction(STORE, 'readwrite');
      for (const id of ids) tx.objectStore(STORE).delete(id);
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    this.emit();
  }

  async clearNamespace(namespace: string): Promise<void> {
    await this.remove((await this.list(namespace)).map((e) => e.id));
  }

  /** 로그아웃·기기 철회 시 모든 namespace 삭제 */
  async clearAll(): Promise<void> {
    if (this.mem) this.mem = [];
    else {
      const db = await this.db();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
    this.emit();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit() {
    for (const l of this.listeners) l();
  }
}

export interface FlushResult {
  sent: number;
  applied: number;
  stale: number;
  duplicate: number;
  dropped: number;
}

const RETRYABLE = new Set(['NETWORK_ERROR', 'INTERNAL_ERROR', 'RATE_LIMITED']);
const flushing = new Map<string, Promise<FlushResult>>();

/** 대기열을 서버(LWW + 멱등)로 보낸다. 네트워크 실패면 그대로 남기고 다음 연결 때 다시 보낸다. */
export function flushOutbox(repo: Pick<FullRepository, 'syncOfflineActions'>, outbox: Outbox, namespace: string): Promise<FlushResult> {
  const running = flushing.get(namespace);
  if (running) return running;
  const p = (async (): Promise<FlushResult> => {
    const entries = await outbox.list(namespace);
    const out: FlushResult = { sent: entries.length, applied: 0, stale: 0, duplicate: 0, dropped: 0 };
    if (entries.length === 0) return out;
    let results;
    try {
      results = await repo.syncOfflineActions(entries.map((e) => e.action));
    } catch (e) {
      if (isFamilyBoardError(e) && RETRYABLE.has(e.code)) return { ...out, sent: 0 };
      throw e; // TOKEN_REVOKED / UNAUTHENTICATED 등은 호출자가 처리 (대기열은 보존)
    }
    const done: string[] = [];
    for (const r of results) {
      if (r.status === 'error' && r.errorCode && RETRYABLE.has(r.errorCode)) continue;
      done.push(r.idempotencyKey);
      if (r.status === 'applied') out.applied++;
      else if (r.status === 'stale') out.stale++;
      else if (r.status === 'duplicate') out.duplicate++;
      else out.dropped++;
    }
    await outbox.remove(done);
    return out;
  })().finally(() => flushing.delete(namespace));
  flushing.set(namespace, p);
  return p;
}

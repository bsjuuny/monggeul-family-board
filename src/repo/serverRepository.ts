// 태블릿 서버 연동 어댑터.
// 가족 문서(= DemoRepository의 JSON 상태)를 서버의 version 있는 JSON 문서로 보관한다.
//  - 로그인/새로고침 시 서버에서 문서를 받아 메모리에 적재하고, DemoRepository가 그 문서를 그대로 다룬다.
//  - 쓰기가 문서를 바꾸면 baseVersion과 함께 서버에 PUT 한다. 409면 덮어쓰지 않고 충돌 상태로 두며
//    메모리 문서는 마지막 서버 문서로 되돌린다(내 변경은 JSON 백업으로 내려받을 수 있다).
//  - 서버에 닿지 않으면 NETWORK_ERROR를 던진다. 로컬에만 저장하는 조용한 fallback은 없다.
import { FamilyBoardError } from '../domain/errors';
import type { AppContext } from '../domain/types';
import { newId } from '../lib/crypto';
import { makeBackupFile, type BackupFile, type ServerApi, type ServerRole } from '../server/api';
import { DEMO_SESSION_KEY, DEMO_STATE_KEY, DemoRepository, emptyState, type DemoState } from './demoRepository';
import type { FullRepository } from './repository';
import { DeviceStore, MemoryStorage, UnlockStore } from './stores';

export interface ConflictInfo {
  /** 충돌을 알려준 서버 version */
  serverVersion: number;
  /** 저장되지 못한 내 문서(JSON 백업용) */
  mine: Record<string, unknown>;
}

export interface SyncSnapshot {
  /** 로그인되어 문서를 적재했는지 */
  ready: boolean;
  version: number;
  role: ServerRole | null;
  loginId: string | null;
  conflict: ConflictInfo | null;
  /** 다른 기기가 더 새 version을 저장했다 (자동 교체하지 않음) */
  remoteVersion: number | null;
  /** 마지막 서버 접속이 실패했는지 */
  unreachable: boolean;
}

const INITIAL: SyncSnapshot = { ready: false, version: 0, role: null, loginId: null, conflict: null, remoteVersion: null, unreachable: false };

/** 서버 문서 동기화 상태 저장소 (useSyncExternalStore 호환) */
export class SyncState {
  private snap: SyncSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  getSnapshot = (): SyncSnapshot => this.snap;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(patch: Partial<SyncSnapshot>): void {
    const next = { ...this.snap, ...patch };
    if ((Object.keys(next) as Array<keyof SyncSnapshot>).every((k) => next[k] === this.snap[k])) return;
    this.snap = next;
    for (const l of this.listeners) l();
  }
  reset(): void {
    this.snap = INITIAL;
    for (const l of this.listeners) l();
  }
}

const normalize = (data: Record<string, unknown> | null): string => JSON.stringify({ ...emptyState(), ...(data ?? {}) });

const isCode = (e: unknown, code: string): e is FamilyBoardError => e instanceof FamilyBoardError && e.code === code;

export class ServerBackedRepository {
  readonly sync = new SyncState();
  /** FullRepository (Proxy): 쓰기 뒤 서버 저장을 보장한다 */
  readonly repo: FullRepository;

  private readonly docStore = new MemoryStorage();
  private readonly session = new MemoryStorage();
  private readonly inner: DemoRepository;
  private syncedRaw = normalize(null);
  private version = 0;
  private loginId: string | null = null;
  private role: ServerRole | null = null;
  private pushChain: Promise<void> = Promise.resolve();
  private bootstrapping: Promise<void> | null = null;

  constructor(
    private api: ServerApi,
    private unlockStore: UnlockStore,
    private onSessionLost: () => void = () => undefined,
  ) {
    this.inner = new DemoRepository({
      storage: this.docStore,
      sessionStorage: this.session,
      deviceStore: new DeviceStore(new MemoryStorage()),
      unlockStore,
      latencyMs: 0,
      simulateNetwork: false,
    });
    this.repo = this.makeProxy();
  }

  // ───── 로그인 / 컨텍스트 ─────
  async login(id: string, password: string): Promise<void> {
    this.resetLocal();
    const user = await this.api.login(id.trim(), password);
    await this.bootstrap(user.id, user.role);
  }

  /** 서버 세션이 살아 있으면 문서를 적재한다. 서버가 안 닿으면 NETWORK_ERROR (fallback 없음) */
  private async getAppContext(): Promise<AppContext> {
    let user;
    try {
      user = await this.api.me();
    } catch (e) {
      if (isCode(e, 'UNAUTHENTICATED')) {
        this.resetLocal();
        return { kind: 'anonymous' };
      }
      if (isCode(e, 'NETWORK_ERROR')) this.sync.set({ unreachable: true });
      throw e;
    }
    if (!this.sync.getSnapshot().ready || this.loginId !== user.id) {
      await this.bootstrap(user.id, user.role);
    } else {
      this.role = user.role;
      this.sync.set({ unreachable: false, role: user.role });
    }
    return this.inner.getAppContext();
  }

  private bootstrap(loginId: string, role: ServerRole): Promise<void> {
    this.bootstrapping ??= this.doBootstrap(loginId, role).finally(() => {
      this.bootstrapping = null;
    });
    return this.bootstrapping;
  }

  private async doBootstrap(loginId: string, role: ServerRole): Promise<void> {
    const state = await this.api.getState();
    this.loadDoc(state.version, state.data);
    this.loginId = loginId;
    this.role = role;
    this.attachUser(loginId, role);
    this.sync.set({ ready: true, version: this.version, role, loginId, conflict: null, remoteVersion: null, unreachable: false });
    // 계정 연결로 문서가 바뀌었으면 저장한다 (다른 기기와 겹치면 한 번 더 받아 다시 시도)
    try {
      await this.pushIfChanged();
    } catch (e) {
      if (!isCode(e, 'VERSION_CONFLICT')) throw e;
      const again = await this.api.getState();
      this.loadDoc(again.version, again.data);
      this.attachUser(loginId, role);
      this.sync.set({ version: this.version, conflict: null, remoteVersion: null });
      await this.pushIfChanged();
    }
  }

  private loadDoc(version: number, data: Record<string, unknown> | null): void {
    const raw = normalize(data);
    this.docStore.setItem(DEMO_STATE_KEY, raw);
    this.syncedRaw = raw;
    this.version = version;
  }

  /** 서버 계정을 문서의 사용자/구성원과 연결한다 (문서 안에서는 ID가 email 역할) */
  private attachUser(loginId: string, role: ServerRole): void {
    const s = JSON.parse(this.docStore.getItem(DEMO_STATE_KEY) ?? normalize(null)) as DemoState;
    let user = s.users.find((u) => u.email === loginId);
    if (!user) {
      user = { id: newId(), email: loginId };
      s.users.push(user);
    }
    const fam = s.families[0];
    if (fam && !s.members.some((m) => m.userId === user.id)) {
      s.members.push({ familyId: fam.id, userId: user.id, role: role === 'owner' ? 'owner' : 'adult', displayName: loginId });
    }
    this.docStore.setItem(DEMO_STATE_KEY, JSON.stringify(s));
    this.session.setItem(DEMO_SESSION_KEY, user.id);
  }

  async signOut(): Promise<void> {
    try {
      await this.api.logout();
    } finally {
      this.resetLocal();
    }
  }

  private resetLocal(): void {
    this.docStore.removeItem(DEMO_STATE_KEY);
    this.session.removeItem(DEMO_SESSION_KEY);
    this.syncedRaw = normalize(null);
    this.version = 0;
    this.loginId = null;
    this.role = null;
    this.unlockStore.clear();
    this.sync.reset();
  }

  // ───── 저장 / 충돌 ─────
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.sync.getSnapshot().ready) throw new FamilyBoardError('UNAUTHENTICATED', '로그인이 필요해요.');
    let result: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      result = await fn();
    } catch (e) {
      failed = true;
      failure = e;
    }
    try {
      await this.pushIfChanged();
    } catch (pushError) {
      throw failed ? failure : pushError;
    }
    if (failed) throw failure;
    return result as T;
  }

  /** 메모리 문서가 마지막 서버 문서와 다르면 저장한다 (직렬화) */
  private pushIfChanged(): Promise<void> {
    const run = this.pushChain.then(() => this.doPush());
    this.pushChain = run.catch(() => undefined);
    return run;
  }

  private async doPush(): Promise<void> {
    const raw = this.docStore.getItem(DEMO_STATE_KEY);
    if (raw === null || raw === this.syncedRaw) return;
    try {
      const res = await this.api.putState(this.version, JSON.parse(raw) as Record<string, unknown>);
      this.syncedRaw = raw;
      this.version = res.version;
      this.sync.set({ version: res.version, unreachable: false, remoteVersion: null });
    } catch (e) {
      // 저장되지 않은 변경을 메모리에 남기지 않는다 (서버 문서와 항상 같게 유지)
      this.docStore.setItem(DEMO_STATE_KEY, this.syncedRaw);
      if (isCode(e, 'VERSION_CONFLICT')) {
        const serverVersion = typeof e.details.serverVersion === 'number' ? e.details.serverVersion : this.version + 1;
        this.sync.set({ conflict: { serverVersion, mine: JSON.parse(raw) as Record<string, unknown> }, remoteVersion: serverVersion });
      } else if (isCode(e, 'NETWORK_ERROR')) {
        this.sync.set({ unreachable: true });
      } else if (isCode(e, 'UNAUTHENTICATED')) {
        this.resetLocal();
        this.onSessionLost();
      }
      throw e;
    }
  }

  /** 서버 값을 다시 불러온다 (충돌 해소). 로컬 변경은 버려진다 */
  async reloadFromServer(): Promise<void> {
    try {
      const state = await this.api.getState();
      this.loadDoc(state.version, state.data);
      if (this.loginId && this.role) this.attachUser(this.loginId, this.role);
      this.sync.set({ version: this.version, conflict: null, remoteVersion: null, unreachable: false });
      await this.pushIfChanged();
    } catch (e) {
      if (isCode(e, 'UNAUTHENTICATED')) {
        this.resetLocal();
        this.onSessionLost();
      } else if (isCode(e, 'NETWORK_ERROR')) this.sync.set({ unreachable: true });
      throw e;
    }
  }

  /** 5초 주기 version 확인. 문서는 자동으로 교체하지 않는다 */
  async poll(): Promise<void> {
    if (!this.sync.getSnapshot().ready) return;
    try {
      const meta = await this.api.getStateMeta();
      this.sync.set({ unreachable: false, remoteVersion: meta.version > this.version ? meta.version : null });
    } catch (e) {
      if (isCode(e, 'UNAUTHENTICATED')) {
        this.resetLocal();
        this.onSessionLost();
      } else if (isCode(e, 'NETWORK_ERROR')) this.sync.set({ unreachable: true });
    }
  }

  /** 충돌로 저장되지 못한 내 문서, 없으면 현재 문서를 백업 형식으로 */
  myBackup(): BackupFile {
    const c = this.sync.getSnapshot().conflict;
    const data = c ? c.mine : (JSON.parse(this.docStore.getItem(DEMO_STATE_KEY) ?? normalize(null)) as Record<string, unknown>);
    return makeBackupFile(data);
  }

  /** 서버 복원/백업 같은 owner 전용 호출 */
  get serverApi(): ServerApi {
    return this.api;
  }

  /** 복원 뒤: 서버 문서를 새로 적재한다 */
  async afterRestore(): Promise<void> {
    await this.reloadFromServer();
  }

  // ───── Proxy: 모든 repo 메서드를 guard로 감싼다 ─────
  private makeProxy(): FullRepository {
    const self = this;
    const special: Record<string, (...a: never[]) => Promise<unknown>> = {
      getAppContext: () => self.getAppContext(),
      signOut: () => self.signOut(),
      requestOtp: () => Promise.reject(new FamilyBoardError('VALIDATION_ERROR', 'ID/비밀번호 로그인을 사용해 주세요.')),
      verifyOtp: () => Promise.reject(new FamilyBoardError('VALIDATION_ERROR', 'ID/비밀번호 로그인을 사용해 주세요.')),
    };
    return new Proxy(this.inner, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in special) return special[prop];
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => self.guard(() => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      },
    }) as unknown as FullRepository;
  }
}

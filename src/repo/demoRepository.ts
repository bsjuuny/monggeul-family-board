// 완전한 demo 어댑터. localStorage에 영속화하며 "서버" 규칙(RLS 불변 조건, 멱등, LWW, 버전 충돌, 기기 철회)을 흉내 낸다.
// 주의: 데모는 운영 연결/보안 구현이 아니다. 데모 OTP는 고정값이고 PIN 해시는 브라우저에 저장된다.
import { FamilyBoardError, type ErrorCode } from '../domain/errors';
import { compareDates, eventOverlapsRange, addDays, todayIn, zonedToIso } from '../domain/dates';
import {
  mergeEventChanges,
  mergeTaskChanges,
  validateChildName,
  validateEmail,
  validateEventInput,
  validateFamilyName,
  validateHabit,
  validateOtp,
  validatePairingCode,
  validatePin,
  validateTaskInput,
  validateUuid,
} from '../domain/validation';
import {
  DEFAULT_TIMEZONE,
  type AppContext,
  type CalendarEvent,
  type ChildProfile,
  type CreatedInvitation,
  type DateRange,
  type DeviceInfo,
  type DeviceMode,
  type DeviceSession,
  type EventChanges,
  type Family,
  type FamilyMember,
  type HabitRecord,
  type HabitTemplate,
  type HabitWithRecord,
  type InvitationInfo,
  type InvitationPreview,
  type NewEvent,
  type NewHabitTemplate,
  type NewTask,
  type OutboxAction,
  type PairingCode,
  type SyncResult,
  type Task,
  type TaskChanges,
  type TaskFilter,
  type TvDisplayData,
  type UnlockSession,
  type UserSession,
} from '../domain/types';
import { newId, pbkdf2Hex, randomBytes, randomDigits, randomToken, sha256Hex, stableStringify, toHex } from '../lib/crypto';
import type { FullRepository } from './repository';
import { UNLOCK_TTL_MS, type DeviceStore, type KeyValueStorage, type UnlockStore } from './stores';

export const DEMO_OTP = '123456';
export const DEMO_STATE_KEY = 'mgfb:demo:state:v1';
export const DEMO_FAULT_KEY = 'mgfb:demo:fault';
export const DEMO_SESSION_KEY = 'mgfb:demo:session:v1';
export const DEVICE_SESSION_DAYS = 90;
export const INVITE_TTL_DAYS = 7;
export const PAIRING_TTL_MS = 10 * 60 * 1000;

const MIN = 60 * 1000;

interface MemberRow extends FamilyMember {
  familyId: string;
}
interface ChildRow extends ChildProfile {
  familyId: string;
}
interface HabitTemplateRow extends HabitTemplate {
  familyId: string;
}
interface HabitRecordRow extends HabitRecord {
  familyId: string;
}
interface SecretRow {
  familyId: string;
  salt: string;
  hash: string;
  iterations: number;
  updatedAt: string;
}
interface InvitationRow extends InvitationInfo {
  familyId: string;
  tokenHash: string;
  createdBy: string;
}
interface PairingRow {
  codeHash: string;
  familyId: string;
  mode: DeviceMode;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
}
interface DeviceRow extends DeviceInfo {
  familyId: string;
  tokenHash: string;
  scopes: string[];
}
interface UnlockRow {
  tokenHash: string;
  familyId: string;
  subject: string;
  expiresAt: string;
}
interface IdemRow {
  actor: string;
  key: string;
  requestHash: string;
  response: unknown;
  expiresAt: string;
}

export interface DemoState {
  v: 1;
  users: Array<{ id: string; email: string }>;
  otp: Record<string, { code: string; expiresAt: string; attempts: number }>;
  families: Family[];
  members: MemberRow[];
  secrets: SecretRow[];
  children: ChildRow[];
  events: CalendarEvent[];
  tasks: Task[];
  habitTemplates: HabitTemplateRow[];
  habitRecords: HabitRecordRow[];
  invitations: InvitationRow[];
  pairing: PairingRow[];
  devices: DeviceRow[];
  unlocks: UnlockRow[];
  idempotency: IdemRow[];
  audit: Array<{ at: string; actor: string; action: string; targetType: string; targetId: string }>;
  /** 실패 시도 시각(ms) 기록: 'pin:<familyId>' | 'pairing' */
  failures: Record<string, number[]>;
}

export function emptyState(): DemoState {
  return {
    v: 1,
    users: [],
    otp: {},
    families: [],
    members: [],
    secrets: [],
    children: [],
    events: [],
    tasks: [],
    habitTemplates: [],
    habitRecords: [],
    invitations: [],
    pairing: [],
    devices: [],
    unlocks: [],
    idempotency: [],
    audit: [],
    failures: {},
  };
}

export interface DemoOptions {
  /** "서버" 상태 저장소 */
  storage: KeyValueStorage;
  /** 이 브라우저의 로그인 세션 저장소 (기본: storage와 동일) */
  sessionStorage?: KeyValueStorage;
  deviceStore: DeviceStore;
  unlockStore: UnlockStore;
  /** 응답 지연(ms). 로딩 상태 확인용. 테스트는 0 */
  latencyMs?: number;
  now?: () => Date;
  /** true면 navigator.onLine === false 일 때 NETWORK_ERROR를 던져 서버 연결 끊김을 흉내 낸다 (앱 기본값) */
  simulateNetwork?: boolean;
}

type Actor =
  | { kind: 'user'; userId: string; email: string; familyId: string; role: 'owner' | 'adult'; member: MemberRow }
  | { kind: 'device'; device: DeviceRow };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function fail(code: ErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new FamilyBoardError(code, message, details);
}

export class DemoRepository implements FullRepository {
  private storage: KeyValueStorage;
  private sessionStorage: KeyValueStorage;
  private deviceStore: DeviceStore;
  private unlockStore: UnlockStore;
  private latency: number;
  private nowFn: () => Date;
  private simulateNetwork: boolean;

  constructor(opts: DemoOptions) {
    this.storage = opts.storage;
    this.sessionStorage = opts.sessionStorage ?? opts.storage;
    this.deviceStore = opts.deviceStore;
    this.unlockStore = opts.unlockStore;
    this.latency = opts.latencyMs ?? 0;
    this.simulateNetwork = opts.simulateNetwork ?? false;
    this.nowFn = opts.now ?? (() => new Date());
  }

  // ───────── 내부 도우미 ─────────
  private now(): Date {
    return this.nowFn();
  }
  private nowIso(): string {
    return this.now().toISOString();
  }

  load(): DemoState {
    const raw = this.storage.getItem(DEMO_STATE_KEY);
    if (!raw) return emptyState();
    try {
      const parsed = JSON.parse(raw) as DemoState;
      return parsed.v === 1 ? { ...emptyState(), ...parsed } : emptyState();
    } catch {
      return emptyState();
    }
  }
  save(s: DemoState): void {
    this.storage.setItem(DEMO_STATE_KEY, JSON.stringify(s));
  }

  /** 모든 공개 메서드의 진입점: 지연 + 오류 주입(개발/테스트용) */
  private async enter(method: string): Promise<void> {
    if (this.simulateNetwork && method !== 'getAppContext' && method !== 'signOut' && typeof navigator !== 'undefined' && navigator.onLine === false) {
      fail('NETWORK_ERROR', '오프라인이에요.', { offline: true });
    }
    if (this.latency > 0) await new Promise((r) => setTimeout(r, this.latency));
    const raw = this.storage.getItem(DEMO_FAULT_KEY);
    if (!raw) return;
    try {
      const f = JSON.parse(raw) as { method?: string; code: ErrorCode; remaining: number };
      if (f.remaining > 0 && (!f.method || f.method === method)) {
        f.remaining -= 1;
        if (f.remaining <= 0) this.storage.removeItem(DEMO_FAULT_KEY);
        else this.storage.setItem(DEMO_FAULT_KEY, JSON.stringify(f));
        fail(f.code, '데모 오류 주입', { injected: true });
      }
    } catch (e) {
      if (e instanceof FamilyBoardError) throw e;
    }
  }

  private audit(s: DemoState, actor: string, action: string, targetType: string, targetId: string) {
    s.audit.push({ at: this.nowIso(), actor, action, targetType, targetId });
    if (s.audit.length > 500) s.audit.splice(0, s.audit.length - 500);
  }

  private currentUser(s: DemoState) {
    const sid = this.sessionStorage.getItem(DEMO_SESSION_KEY);
    if (!sid) return null;
    return s.users.find((u) => u.id === sid) ?? null;
  }

  private requireUser(s: DemoState) {
    const u = this.currentUser(s);
    if (!u) fail('UNAUTHENTICATED', '로그인이 필요해요.');
    return u;
  }

  private memberOf(s: DemoState, userId: string): MemberRow | null {
    return s.members.find((m) => m.userId === userId) ?? null;
  }

  /** 성인 로그인 사용자만 허용 */
  private requireAdult(s: DemoState): Extract<Actor, { kind: 'user' }> {
    const u = this.requireUser(s);
    const m = this.memberOf(s, u.id);
    if (!m) fail('NOT_FOUND', '가족이 아직 없어요.', { reason: 'NO_FAMILY' });
    return { kind: 'user', userId: u.id, email: u.email, familyId: m.familyId, role: m.role, member: m };
  }

  private requireOwner(s: DemoState) {
    const a = this.requireAdult(s);
    if (a.role !== 'owner') fail('FORBIDDEN', 'owner만 할 수 있어요.', { reason: 'OWNER_ONLY' });
    return a;
  }

  /** child 기기가 저장돼 있으면 기기 actor, 아니면 성인 사용자 actor */
  private async actorAdultOrChild(s: DemoState): Promise<Actor> {
    const dev = this.deviceStore.get('child');
    if (dev) return { kind: 'device', device: await this.validateDeviceToken(s, dev.token, 'child') };
    return this.requireAdult(s);
  }

  private async validateDeviceToken(s: DemoState, token: string, mode: DeviceMode): Promise<DeviceRow> {
    const hash = await sha256Hex(token);
    const d = s.devices.find((x) => x.tokenHash === hash);
    if (!d || d.mode !== mode) fail('TOKEN_REVOKED', '기기 연결이 유효하지 않아요.', { reason: 'UNKNOWN_TOKEN' });
    if (d.revokedAt) fail('TOKEN_REVOKED', '기기 연결이 해제되었어요.', { reason: 'REVOKED' });
    if (Date.parse(d.expiresAt) <= this.now().getTime()) fail('TOKEN_REVOKED', '기기 연결이 만료되었어요.', { reason: 'EXPIRED' });
    d.lastSeenAt = this.nowIso();
    return d;
  }

  private actorKey(a: Actor): string {
    return a.kind === 'user' ? `user:${a.userId}` : `device:${a.device.id}`;
  }
  private actorFamily(a: Actor): string {
    return a.kind === 'user' ? a.familyId : a.device.familyId;
  }

  private family(s: DemoState, familyId: string): Family {
    const f = s.families.find((x) => x.id === familyId);
    if (!f) fail('NOT_FOUND', '가족을 찾을 수 없어요.');
    return f;
  }

  private idem<T>(s: DemoState, actor: string, key: string, body: unknown, fn: () => T): T {
    validateUuid(key, 'idempotencyKey');
    const nowMs = this.now().getTime();
    s.idempotency = s.idempotency.filter((r) => Date.parse(r.expiresAt) > nowMs);
    const hash = stableStringify(body);
    const hit = s.idempotency.find((r) => r.actor === actor && r.key === key);
    if (hit) {
      if (hit.requestHash !== hash) fail('IDEMPOTENCY_CONFLICT', '같은 key로 다른 요청이 왔어요.');
      return clone(hit.response) as T;
    }
    const response = fn();
    s.idempotency.push({ actor, key, requestHash: hash, response: clone(response), expiresAt: new Date(nowMs + 24 * 60 * MIN).toISOString() });
    return response;
  }

  private visibleEvent(a: Extract<Actor, { kind: 'user' }>, e: CalendarEvent): boolean {
    return e.familyId === a.familyId && (e.visibility === 'family' || e.createdBy === a.userId);
  }

  private tzOf(s: DemoState, familyId: string): string {
    return this.family(s, familyId).timezone;
  }

  /** 서버 측 unlock 검증 흉내: 메모리 token의 hash가 같은 가족·같은 주체로 발급되었고 만료 전인지 */
  private async unlockValid(s: DemoState, familyId: string, subject: string): Promise<boolean> {
    const token = this.unlockStore.getToken();
    if (!token) return false;
    const h = await sha256Hex(token);
    const nowMs = this.now().getTime();
    return s.unlocks.some((u) => u.tokenHash === h && u.familyId === familyId && u.subject === subject && Date.parse(u.expiresAt) > nowMs);
  }

  // ───────── 인증 ─────────
  async requestOtp(email: string): Promise<void> {
    await this.enter('requestOtp');
    const e = validateEmail(email);
    const s = this.load();
    const prev = s.otp[e];
    s.otp[e] = { code: DEMO_OTP, expiresAt: new Date(this.now().getTime() + 10 * MIN).toISOString(), attempts: prev?.attempts ?? 0 };
    this.save(s);
  }

  async verifyOtp(email: string, token: string): Promise<UserSession> {
    await this.enter('verifyOtp');
    const e = validateEmail(email);
    const code = validateOtp(token);
    const s = this.load();
    const o = s.otp[e];
    if (!o) fail('UNAUTHENTICATED', '먼저 인증 코드를 요청해 주세요.', { reason: 'NO_REQUEST' });
    if (o.attempts >= 5) fail('RATE_LIMITED', '시도가 너무 많아요. 새 코드를 요청해 주세요.');
    if (Date.parse(o.expiresAt) <= this.now().getTime()) fail('UNAUTHENTICATED', '코드가 만료됐어요. 새 코드를 요청해 주세요.', { reason: 'EXPIRED' });
    if (o.code !== code) {
      o.attempts += 1;
      this.save(s);
      fail('UNAUTHENTICATED', '코드가 올바르지 않아요.', { reason: 'MISMATCH' });
    }
    delete s.otp[e];
    let user = s.users.find((u) => u.email === e);
    if (!user) {
      user = { id: newId(), email: e };
      s.users.push(user);
    }
    this.sessionStorage.setItem(DEMO_SESSION_KEY, user.id);
    this.save(s);
    return { userId: user.id, email: user.email };
  }

  async signOut(): Promise<void> {
    await this.enter('signOut');
    const s = this.load();
    this.sessionStorage.removeItem(DEMO_SESSION_KEY);
    this.save(s);
    this.unlockStore.clear();
  }

  async getAppContext(): Promise<AppContext> {
    await this.enter('getAppContext');
    const s = this.load();
    const dev = this.deviceStore.get('child');
    if (dev) {
      try {
        const d = await this.validateDeviceToken(s, dev.token, 'child');
        this.save(s);
        return { kind: 'device', mode: 'child', familyId: d.familyId, familyName: this.family(s, d.familyId).name };
      } catch (e) {
        if (e instanceof FamilyBoardError && e.code === 'TOKEN_REVOKED') this.deviceStore.clear('child');
        else throw e;
      }
    }
    const u = this.currentUser(s);
    if (!u) return { kind: 'anonymous' };
    const m = this.memberOf(s, u.id);
    const session: UserSession = { userId: u.id, email: u.email };
    if (!m) return { kind: 'adult', session, family: null, member: null };
    return { kind: 'adult', session, family: this.family(s, m.familyId), member: { userId: m.userId, displayName: m.displayName, role: m.role } };
  }

  // ───────── 가족 ─────────
  async createFamily(name: string, idempotencyKey: string): Promise<Family> {
    await this.enter('createFamily');
    const n = validateFamilyName(name);
    const s = this.load();
    const u = this.requireUser(s);
    const out = this.idem(s, `user:${u.id}`, idempotencyKey, { op: 'createFamily', n }, () => {
      if (this.memberOf(s, u.id)) fail('FORBIDDEN', '이미 가족에 속해 있어요.', { reason: 'ALREADY_MEMBER' });
      const nowIso = this.nowIso();
      const f: Family = { id: newId(), name: n, timezone: DEFAULT_TIMEZONE, createdAt: nowIso };
      s.families.push(f);
      s.members.push({ familyId: f.id, userId: u.id, role: 'owner', displayName: u.email.split('@')[0] ?? '보호자' });
      this.audit(s, `user:${u.id}`, 'family.create', 'family', f.id);
      return f;
    });
    this.save(s);
    return out;
  }

  async getFamily(): Promise<Family> {
    await this.enter('getFamily');
    const s = this.load();
    const a = await this.actorAdultOrChild(s);
    this.save(s);
    return this.family(s, this.actorFamily(a));
  }

  async getMembers(): Promise<{ adults: FamilyMember[]; children: ChildProfile[] }> {
    await this.enter('getMembers');
    const s = this.load();
    const a = await this.actorAdultOrChild(s);
    this.save(s);
    const fid = this.actorFamily(a);
    const children = s.children
      .filter((c) => c.familyId === fid && (a.kind === 'user' || c.active))
      .map(({ familyId: _f, ...c }) => c);
    // 아이 기기에는 성인 목록을 주지 않는다 (최소 공개)
    const adults =
      a.kind === 'user'
        ? s.members.filter((m) => m.familyId === fid).map(({ familyId: _f, ...m }) => m)
        : [];
    return { adults, children };
  }

  async setParentPin(pin: string): Promise<void> {
    await this.enter('setParentPin');
    const p = validatePin(pin);
    const s0 = this.load();
    const a0 = this.requireOwner(s0);
    if (s0.secrets.some((x) => x.familyId === a0.familyId) && !(await this.unlockValid(s0, a0.familyId, `user:${a0.userId}`))) {
      fail('FORBIDDEN', '현재 PIN 확인 후 바꿀 수 있어요.', { reason: 'PIN_REQUIRED' });
    }
    const salt = toHex(randomBytes(16));
    const hash = await pbkdf2Hex(p, salt);
    const s = this.load();
    const a = this.requireOwner(s);
    s.secrets = s.secrets.filter((x) => x.familyId !== a.familyId);
    s.secrets.push({ familyId: a.familyId, salt, hash, iterations: 120000, updatedAt: this.nowIso() });
    this.audit(s, `user:${a.userId}`, 'pin.set', 'family', a.familyId);
    this.save(s);
  }

  async verifyParentPin(pin: string): Promise<UnlockSession> {
    await this.enter('verifyParentPin');
    const p = validatePin(pin);
    const s0 = this.load();
    const a0 = await this.actorAdultOrChild(s0);
    const fid = this.actorFamily(a0);
    const bucket = `pin:${fid}`;
    const nowMs = this.now().getTime();
    const recent = (s0.failures[bucket] ?? []).filter((t) => nowMs - t < 5 * MIN);
    if (recent.length >= 5) fail('RATE_LIMITED', 'PIN 시도가 너무 많아요. 5분 뒤 다시 시도해 주세요.', { retryAfterSec: 300 });
    const secret = s0.secrets.find((x) => x.familyId === fid);
    if (!secret) fail('NOT_FOUND', '부모 PIN이 아직 설정되지 않았어요.', { reason: 'NO_PIN' });
    const hash = await pbkdf2Hex(p, secret.salt, secret.iterations);
    const s = this.load();
    if (hash !== secret.hash) {
      s.failures[bucket] = [...(s.failures[bucket] ?? []).filter((t) => nowMs - t < 5 * MIN), nowMs];
      this.save(s);
      fail('FORBIDDEN', 'PIN이 맞지 않아요.', { reason: 'PIN_MISMATCH', remaining: Math.max(0, 5 - (s.failures[bucket]?.length ?? 0)) });
    }
    delete s.failures[bucket];
    const token = randomToken(32);
    const expiresAt = new Date(nowMs + UNLOCK_TTL_MS).toISOString();
    const subject = a0.kind === 'user' ? `user:${a0.userId}` : `device:${a0.device.id}`;
    s.unlocks = s.unlocks.filter((u) => Date.parse(u.expiresAt) > nowMs);
    s.unlocks.push({ tokenHash: await sha256Hex(token), familyId: fid, subject, expiresAt });
    this.save(s);
    this.unlockStore.set(token, expiresAt);
    return { token, expiresAt };
  }

  // ───────── 아이/습관 ─────────
  async addChild(input: { displayName: string; avatarKey: string }, idempotencyKey: string): Promise<ChildProfile> {
    await this.enter('addChild');
    const name = validateChildName(input.displayName);
    const s = this.load();
    const a = this.requireAdult(s);
    const out = this.idem(s, this.actorKey(a), idempotencyKey, { op: 'addChild', name, k: input.avatarKey }, () => {
      const row: ChildRow = { id: newId(), familyId: a.familyId, displayName: name, avatarKey: (input.avatarKey || 'bear').slice(0, 20), active: true };
      s.children.push(row);
      this.audit(s, this.actorKey(a), 'child.add', 'child', row.id);
      const { familyId: _f, ...c } = row;
      return c as ChildProfile;
    });
    this.save(s);
    return out;
  }

  async setChildActive(id: string, active: boolean): Promise<ChildProfile> {
    await this.enter('setChildActive');
    const s = this.load();
    const a = this.requireAdult(s);
    const c = s.children.find((x) => x.id === id && x.familyId === a.familyId);
    if (!c) fail('NOT_FOUND', '아이 프로필을 찾을 수 없어요.');
    c.active = active;
    this.audit(s, this.actorKey(a), 'child.active', 'child', id);
    this.save(s);
    const { familyId: _f, ...out } = c;
    return out;
  }

  async addHabitTemplate(input: NewHabitTemplate, idempotencyKey: string): Promise<HabitTemplate> {
    await this.enter('addHabitTemplate');
    const v = validateHabit(input);
    const s = this.load();
    const a = this.requireAdult(s);
    const out = this.idem(s, this.actorKey(a), idempotencyKey, { op: 'addHabit', v }, () => {
      const child = s.children.find((c) => c.id === v.childId && c.familyId === a.familyId);
      if (!child) fail('NOT_FOUND', '아이 프로필을 찾을 수 없어요.');
      const row: HabitTemplateRow = { id: newId(), familyId: a.familyId, childId: v.childId, title: v.title, iconKey: v.iconKey, approvalRequired: v.approvalRequired, active: true };
      s.habitTemplates.push(row);
      this.audit(s, this.actorKey(a), 'habit.add', 'habit', row.id);
      const { familyId: _f, ...h } = row;
      return h as HabitTemplate;
    });
    this.save(s);
    return out;
  }

  async setHabitActive(id: string, active: boolean): Promise<HabitTemplate> {
    await this.enter('setHabitActive');
    const s = this.load();
    const a = this.requireAdult(s);
    const h = s.habitTemplates.find((x) => x.id === id && x.familyId === a.familyId);
    if (!h) fail('NOT_FOUND', '습관을 찾을 수 없어요.');
    h.active = active;
    this.save(s);
    const { familyId: _f, ...out } = h;
    return out;
  }

  async getHabits(childId: string, localDate: string): Promise<HabitWithRecord[]> {
    await this.enter('getHabits');
    const s = this.load();
    const a = await this.actorAdultOrChild(s);
    this.save(s);
    const fid = this.actorFamily(a);
    const child = s.children.find((c) => c.id === childId && c.familyId === fid);
    if (!child) fail('NOT_FOUND', '아이 프로필을 찾을 수 없어요.');
    return s.habitTemplates
      .filter((h) => h.familyId === fid && h.childId === childId && h.active)
      .map((h) => {
        const rec = s.habitRecords.find((r) => r.habitId === h.id && r.localDate === localDate) ?? null;
        const { familyId: _f, ...t } = h;
        let record: HabitRecord | null = null;
        if (rec) {
          const { familyId: _rf, ...r } = rec;
          record = r;
        }
        return { ...t, record };
      });
  }

  /** LWW 적용. 반환: 적용 여부와 현재 레코드 */
  private applyHabitCheck(s: DemoState, a: Actor, habitId: string, localDate: string, ts: string): { rec: HabitRecordRow; applied: boolean } {
    const fid = this.actorFamily(a);
    const h = s.habitTemplates.find((x) => x.id === habitId && x.familyId === fid && x.active);
    if (!h) fail('NOT_FOUND', '습관을 찾을 수 없어요.');
    const child = s.children.find((c) => c.id === h.childId && c.familyId === fid && c.active);
    if (!child) fail('NOT_FOUND', '아이 프로필을 찾을 수 없어요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) fail('VALIDATION_ERROR', '날짜 형식을 확인해 주세요.', { field: 'localDate' });
    if (Number.isNaN(Date.parse(ts))) fail('VALIDATION_ERROR', '시각 형식을 확인해 주세요.', { field: 'clientTimestamp' });
    const tz = this.tzOf(s, fid);
    if (compareDates(localDate, addDays(todayIn(tz, this.now()), 1)) > 0) fail('VALIDATION_ERROR', '미래 날짜는 체크할 수 없어요.', { field: 'localDate' });
    const tsIso = new Date(ts).toISOString();
    const nextState: HabitRecord['state'] = h.approvalRequired ? 'pending' : 'done';
    let rec = s.habitRecords.find((r) => r.habitId === habitId && r.localDate === localDate);
    if (!rec) {
      rec = { id: newId(), familyId: fid, habitId, localDate, state: nextState, approvedBy: null, clientTimestamp: tsIso, version: 1 };
      s.habitRecords.push(rec);
      this.audit(s, this.actorKey(a), 'habit.check', 'habit_record', rec.id);
      return { rec, applied: true };
    }
    if (rec.state === 'approved' || rec.state === 'done' || Date.parse(tsIso) < Date.parse(rec.clientTimestamp)) {
      return { rec, applied: false }; // 승인됨/이미 완료/더 오래된 요청은 무시 (LWW)
    }
    rec.state = nextState;
    rec.approvedBy = null;
    rec.clientTimestamp = tsIso;
    rec.version += 1;
    return { rec, applied: true };
  }

  private recOut(r: HabitRecordRow): HabitRecord {
    const { familyId: _f, ...out } = r;
    return out;
  }

  async checkHabit(habitId: string, localDate: string, clientTimestamp: string, idempotencyKey: string): Promise<HabitRecord> {
    await this.enter('checkHabit');
    const s = this.load();
    const a = await this.actorAdultOrChild(s);
    const out = this.idem(s, this.actorKey(a), idempotencyKey, { op: 'checkHabit', habitId, localDate, clientTimestamp }, () =>
      this.recOut(this.applyHabitCheck(s, a, habitId, localDate, clientTimestamp).rec),
    );
    this.save(s);
    return out;
  }

  private decideHabit(recordId: string, state: 'approved' | 'rejected', method: string): HabitRecord {
    const s = this.load();
    const a = this.requireAdult(s);
    const rec = s.habitRecords.find((r) => r.id === recordId && r.familyId === a.familyId);
    if (!rec) fail('NOT_FOUND', '기록을 찾을 수 없어요.');
    if (rec.state === state) return this.recOut(rec);
    if (rec.state !== 'pending') fail('VALIDATION_ERROR', '승인 대기 중인 기록만 처리할 수 있어요.', { state: rec.state });
    rec.state = state;
    rec.approvedBy = state === 'approved' ? a.userId : null;
    rec.version += 1;
    this.audit(s, this.actorKey(a), method, 'habit_record', rec.id);
    this.save(s);
    return this.recOut(rec);
  }

  async approveHabit(recordId: string): Promise<HabitRecord> {
    await this.enter('approveHabit');
    return this.decideHabit(recordId, 'approved', 'habit.approve');
  }
  async rejectHabit(recordId: string): Promise<HabitRecord> {
    await this.enter('rejectHabit');
    return this.decideHabit(recordId, 'rejected', 'habit.reject');
  }

  // ───────── 일정 ─────────
  async getEvents(range: DateRange): Promise<CalendarEvent[]> {
    await this.enter('getEvents');
    const s = this.load();
    const a = this.requireAdult(s);
    const tz = this.tzOf(s, a.familyId);
    return s.events
      .filter((e) => this.visibleEvent(a, e) && eventOverlapsRange(e, range.from, range.to, tz))
      .sort((x, y) => (x.startsAt ?? `${x.startDate}T00:00:00Z`).localeCompare(y.startsAt ?? `${y.startDate}T00:00:00Z`));
  }

  async createEvent(input: NewEvent, idempotencyKey: string): Promise<CalendarEvent> {
    await this.enter('createEvent');
    const v = validateEventInput(input);
    const s = this.load();
    const a = this.requireAdult(s);
    const out = this.idem(s, this.actorKey(a), idempotencyKey, { op: 'createEvent', v }, () => {
      const nowIso = this.nowIso();
      const e: CalendarEvent = { id: newId(), familyId: a.familyId, createdBy: a.userId, ...v, version: 1, createdAt: nowIso, updatedAt: nowIso };
      s.events.push(e);
      this.audit(s, this.actorKey(a), 'event.create', 'event', e.id);
      return e;
    });
    this.save(s);
    return out;
  }

  async updateEvent(id: string, version: number, changes: EventChanges): Promise<CalendarEvent> {
    await this.enter('updateEvent');
    const s = this.load();
    const a = this.requireAdult(s);
    const e = s.events.find((x) => x.id === id && this.visibleEvent(a, x));
    if (!e) fail('NOT_FOUND', '일정을 찾을 수 없어요.');
    if (e.version !== version) fail('VERSION_CONFLICT', '다른 사람이 먼저 수정했어요.', { latest: clone(e) });
    const merged = mergeEventChanges(e, changes);
    if (merged.visibility === 'private' && e.createdBy !== a.userId) fail('FORBIDDEN', '다른 사람의 일정을 나만 보기로 바꿀 수 없어요.');
    Object.assign(e, merged, { version: e.version + 1, updatedAt: this.nowIso() });
    this.audit(s, this.actorKey(a), 'event.update', 'event', e.id);
    this.save(s);
    return clone(e);
  }

  async deleteEvent(id: string, version: number): Promise<void> {
    await this.enter('deleteEvent');
    const s = this.load();
    const a = this.requireAdult(s);
    const e = s.events.find((x) => x.id === id && this.visibleEvent(a, x));
    if (!e) fail('NOT_FOUND', '일정을 찾을 수 없어요.');
    if (e.version !== version) fail('VERSION_CONFLICT', '다른 사람이 먼저 수정했어요.', { latest: clone(e) });
    s.events = s.events.filter((x) => x.id !== id);
    this.audit(s, this.actorKey(a), 'event.delete', 'event', id);
    this.save(s);
  }

  // ───────── 할 일 ─────────
  private assertAssignee(s: DemoState, familyId: string, id: string | null, type: 'adult' | 'child' | null) {
    if (id === null || type === null) return;
    const ok =
      type === 'adult'
        ? s.members.some((m) => m.familyId === familyId && m.userId === id)
        : s.children.some((c) => c.familyId === familyId && c.id === id && c.active);
    if (!ok) fail('VALIDATION_ERROR', '같은 가족의 담당자를 선택해 주세요.', { field: 'assigneeId' });
  }

  async getTasks(filter: TaskFilter = {}): Promise<Task[]> {
    await this.enter('getTasks');
    const s = this.load();
    const a = this.requireAdult(s);
    return s.tasks
      .filter((t) => t.familyId === a.familyId)
      .filter((t) => (filter.kind ? t.kind === filter.kind : true))
      .filter((t) => (filter.assigneeId ? t.assigneeId === filter.assigneeId : true))
      .filter((t) => (filter.completed === undefined ? true : (t.completedAt !== null) === filter.completed))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  }

  async createTask(input: NewTask, idempotencyKey: string): Promise<Task> {
    await this.enter('createTask');
    const v = validateTaskInput(input);
    const s = this.load();
    const a = this.requireAdult(s);
    const out = this.idem(s, this.actorKey(a), idempotencyKey, { op: 'createTask', v }, () => {
      this.assertAssignee(s, a.familyId, v.assigneeId, v.assigneeType);
      const nowIso = this.nowIso();
      const t: Task = { id: newId(), familyId: a.familyId, createdBy: a.userId, ...v, completedAt: null, clientTimestamp: nowIso, version: 1, createdAt: nowIso, updatedAt: nowIso };
      s.tasks.push(t);
      this.audit(s, this.actorKey(a), 'task.create', 'task', t.id);
      return t;
    });
    this.save(s);
    return out;
  }

  /** LWW: 더 오래된 client_timestamp는 무시 */
  private applyTaskCompletion(s: DemoState, familyId: string, id: string, completed: boolean, ts: string): { task: Task; applied: boolean } {
    if (Number.isNaN(Date.parse(ts))) fail('VALIDATION_ERROR', '시각 형식을 확인해 주세요.', { field: 'clientTimestamp' });
    const t = s.tasks.find((x) => x.id === id && x.familyId === familyId);
    if (!t) fail('NOT_FOUND', '할 일을 찾을 수 없어요.');
    const tsIso = new Date(ts).toISOString();
    if (Date.parse(tsIso) < Date.parse(t.clientTimestamp)) return { task: t, applied: false };
    t.completedAt = completed ? tsIso : null;
    t.clientTimestamp = tsIso;
    t.version += 1;
    t.updatedAt = this.nowIso();
    return { task: t, applied: true };
  }

  async setTaskCompleted(id: string, completed: boolean, clientTimestamp: string, idempotencyKey: string): Promise<Task> {
    await this.enter('setTaskCompleted');
    const s = this.load();
    const a = this.requireAdult(s);
    const out = this.idem(s, this.actorKey(a), idempotencyKey, { op: 'setTaskCompleted', id, completed, clientTimestamp }, () =>
      clone(this.applyTaskCompletion(s, a.familyId, id, completed, clientTimestamp).task),
    );
    this.save(s);
    return out;
  }

  async updateTask(id: string, version: number, changes: TaskChanges): Promise<Task> {
    await this.enter('updateTask');
    const s = this.load();
    const a = this.requireAdult(s);
    const t = s.tasks.find((x) => x.id === id && x.familyId === a.familyId);
    if (!t) fail('NOT_FOUND', '할 일을 찾을 수 없어요.');
    if (t.version !== version) fail('VERSION_CONFLICT', '다른 사람이 먼저 수정했어요.', { latest: clone(t) });
    const merged = mergeTaskChanges(t, changes);
    this.assertAssignee(s, a.familyId, merged.assigneeId, merged.assigneeType);
    Object.assign(t, merged, { version: t.version + 1, updatedAt: this.nowIso() });
    this.save(s);
    return clone(t);
  }

  async deleteTask(id: string, version: number): Promise<void> {
    await this.enter('deleteTask');
    const s = this.load();
    const a = this.requireAdult(s);
    const t = s.tasks.find((x) => x.id === id && x.familyId === a.familyId);
    if (!t) fail('NOT_FOUND', '할 일을 찾을 수 없어요.');
    if (t.version !== version) fail('VERSION_CONFLICT', '다른 사람이 먼저 수정했어요.', { latest: clone(t) });
    s.tasks = s.tasks.filter((x) => x.id !== id);
    this.save(s);
  }

  // ───────── 오프라인 outbox 동기화 (task 완료/취소, habit 체크만) ─────────
  async syncOfflineActions(actions: OutboxAction[]): Promise<SyncResult[]> {
    await this.enter('syncOfflineActions');
    const s = this.load();
    const a = await this.actorAdultOrChild(s);
    const results: SyncResult[] = [];
    for (const act of actions) {
      const key = act.idempotencyKey;
      try {
        validateUuid(key, 'idempotencyKey');
        const nowMs = this.now().getTime();
        s.idempotency = s.idempotency.filter((r) => Date.parse(r.expiresAt) > nowMs);
        const body =
          act.type === 'task_completed'
            ? { op: 'setTaskCompleted', id: act.taskId, completed: act.completed, clientTimestamp: act.clientTimestamp }
            : { op: 'checkHabit', habitId: act.habitId, localDate: act.localDate, clientTimestamp: act.clientTimestamp };
        const hit = s.idempotency.find((r) => r.actor === this.actorKey(a) && r.key === key);
        if (hit) {
          results.push({ idempotencyKey: key, status: hit.requestHash === stableStringify(body) ? 'duplicate' : 'error', errorCode: hit.requestHash === stableStringify(body) ? undefined : 'IDEMPOTENCY_CONFLICT' });
          continue;
        }
        let applied: boolean;
        if (act.type === 'task_completed') {
          if (a.kind !== 'user') fail('FORBIDDEN', '이 기기는 할 일을 바꿀 수 없어요.');
          applied = this.applyTaskCompletion(s, a.familyId, act.taskId, act.completed, act.clientTimestamp).applied;
        } else {
          applied = this.applyHabitCheck(s, a, act.habitId, act.localDate, act.clientTimestamp).applied;
        }
        s.idempotency.push({ actor: this.actorKey(a), key, requestHash: stableStringify(body), response: { applied }, expiresAt: new Date(nowMs + 24 * 60 * MIN).toISOString() });
        results.push({ idempotencyKey: key, status: applied ? 'applied' : 'stale' });
      } catch (e) {
        if (e instanceof FamilyBoardError && e.code === 'TOKEN_REVOKED') throw e;
        results.push({ idempotencyKey: key, status: 'error', errorCode: e instanceof FamilyBoardError ? e.code : 'INTERNAL_ERROR' });
      }
    }
    this.save(s);
    return results;
  }

  // ───────── 초대 ─────────
  async createInvitation(role: 'adult' = 'adult'): Promise<CreatedInvitation> {
    await this.enter('createInvitation');
    const token = randomToken(24);
    const tokenHash = await sha256Hex(token);
    const s = this.load();
    const a = this.requireOwner(s);
    const nowMs = this.now().getTime();
    const row: InvitationRow = {
      id: newId(),
      familyId: a.familyId,
      tokenHash,
      role,
      createdBy: a.userId,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + INVITE_TTL_DAYS * 24 * 60 * MIN).toISOString(),
      acceptedAt: null,
      revokedAt: null,
    };
    s.invitations.push(row);
    this.audit(s, this.actorKey(a), 'invite.create', 'invitation', row.id);
    this.save(s);
    return { id: row.id, token, role, expiresAt: row.expiresAt };
  }

  async listInvitations(): Promise<InvitationInfo[]> {
    await this.enter('listInvitations');
    const s = this.load();
    const a = this.requireOwner(s);
    return s.invitations
      .filter((i) => i.familyId === a.familyId)
      .map(({ id, role, createdAt, expiresAt, acceptedAt, revokedAt }) => ({ id, role, createdAt, expiresAt, acceptedAt, revokedAt }));
  }

  async revokeInvitation(id: string): Promise<void> {
    await this.enter('revokeInvitation');
    const s = this.load();
    const a = this.requireOwner(s);
    const i = s.invitations.find((x) => x.id === id && x.familyId === a.familyId);
    if (!i) fail('NOT_FOUND', '초대를 찾을 수 없어요.');
    if (!i.revokedAt) i.revokedAt = this.nowIso();
    this.audit(s, this.actorKey(a), 'invite.revoke', 'invitation', id);
    this.save(s);
  }

  private async findInvitation(s: DemoState, token: string): Promise<InvitationRow | null> {
    if (typeof token !== 'string' || token.length < 8 || token.length > 200) return null;
    const h = await sha256Hex(token);
    return s.invitations.find((i) => i.tokenHash === h) ?? null;
  }

  private invitationStatus(i: InvitationRow | null): 'valid' | 'expired' | 'used' | 'revoked' | 'invalid' {
    if (!i) return 'invalid';
    if (i.revokedAt) return 'revoked';
    if (i.acceptedAt) return 'used';
    if (Date.parse(i.expiresAt) <= this.now().getTime()) return 'expired';
    return 'valid';
  }

  async previewInvitation(token: string): Promise<InvitationPreview> {
    await this.enter('previewInvitation');
    const s = this.load();
    this.requireUser(s);
    const i = await this.findInvitation(s, token);
    const st = this.invitationStatus(i);
    if (st !== 'valid' || !i) return { status: st === 'valid' ? 'invalid' : st };
    return { status: 'valid', role: i.role, familyName: this.family(s, i.familyId).name };
  }

  async acceptInvitation(token: string): Promise<Family> {
    await this.enter('acceptInvitation');
    const s = this.load();
    const u = this.requireUser(s);
    const i = await this.findInvitation(s, token);
    const st = this.invitationStatus(i);
    if (st !== 'valid' || !i) fail('INVITE_EXPIRED', '초대를 사용할 수 없어요.', { reason: st });
    if (this.memberOf(s, u.id)) fail('FORBIDDEN', '이미 가족에 속한 계정이에요. 초대받은 다른 계정으로 로그인해 주세요.', { reason: 'ALREADY_MEMBER' });
    i.acceptedAt = this.nowIso();
    s.members.push({ familyId: i.familyId, userId: u.id, role: i.role, displayName: u.email.split('@')[0] ?? '보호자' });
    this.audit(s, `user:${u.id}`, 'invite.accept', 'invitation', i.id);
    this.save(s);
    return this.family(s, i.familyId);
  }

  async removeMember(userId: string): Promise<void> {
    await this.enter('removeMember');
    const s = this.load();
    const a = this.requireOwner(s);
    const m = s.members.find((x) => x.familyId === a.familyId && x.userId === userId);
    if (!m) fail('NOT_FOUND', '구성원을 찾을 수 없어요.');
    if (m.role === 'owner') fail('FORBIDDEN', 'owner는 제거할 수 없어요.');
    s.members = s.members.filter((x) => x !== m);
    this.audit(s, this.actorKey(a), 'member.remove', 'user', userId);
    this.save(s);
  }

  // ───────── 기기 ─────────
  async createPairingCode(mode: 'tv' | 'child'): Promise<PairingCode> {
    await this.enter('createPairingCode');
    if (mode !== 'tv' && mode !== 'child') fail('VALIDATION_ERROR', '기기 종류를 확인해 주세요.');
    const s = this.load();
    const a = this.requireAdult(s);
    if (mode === 'child' && !(await this.unlockValid(s, a.familyId, `user:${a.userId}`))) {
      fail('FORBIDDEN', '아이 기기 코드는 부모 PIN 확인 후 만들 수 있어요.', { reason: 'PIN_REQUIRED' });
    }
    const nowMs = this.now().getTime();
    s.pairing = s.pairing.filter((p) => Date.parse(p.expiresAt) > nowMs && !p.usedAt);
    let code = '';
    let codeHash = '';
    for (let i = 0; i < 20; i++) {
      code = randomDigits(6);
      codeHash = await sha256Hex(`pair:${code}`);
      if (!s.pairing.some((p) => p.codeHash === codeHash)) break;
    }
    const expiresAt = new Date(nowMs + PAIRING_TTL_MS).toISOString();
    s.pairing.push({ codeHash, familyId: a.familyId, mode, createdBy: a.userId, expiresAt, usedAt: null });
    this.audit(s, this.actorKey(a), 'pairing.create', 'pairing', mode);
    this.save(s);
    return { code, mode, expiresAt };
  }

  async exchangePairingCode(code: string): Promise<DeviceSession> {
    await this.enter('exchangePairingCode');
    const c = validatePairingCode(code);
    const codeHash = await sha256Hex(`pair:${c}`);
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const s = this.load();
    const nowMs = this.now().getTime();
    const recent = (s.failures.pairing ?? []).filter((t) => nowMs - t < PAIRING_TTL_MS);
    if (recent.length >= 8) fail('RATE_LIMITED', '연결 시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.');
    const p = s.pairing.find((x) => x.codeHash === codeHash && !x.usedAt && Date.parse(x.expiresAt) > nowMs);
    if (!p) {
      s.failures.pairing = [...recent, nowMs];
      this.save(s);
      fail('NOT_FOUND', '코드가 맞지 않거나 만료됐어요.', { reason: 'INVALID_CODE' });
    }
    p.usedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + DEVICE_SESSION_DAYS * 24 * 60 * MIN).toISOString();
    const dev: DeviceRow = {
      id: newId(),
      familyId: p.familyId,
      tokenHash,
      mode: p.mode,
      scopes: p.mode === 'tv' ? ['tv:read'] : ['child:habit', 'child:read'],
      label: p.mode === 'tv' ? 'TV' : '아이 태블릿',
      createdAt: new Date(nowMs).toISOString(),
      expiresAt,
      lastSeenAt: null,
      revokedAt: null,
    };
    s.devices.push(dev);
    this.audit(s, `device:${dev.id}`, 'device.pair', 'device', dev.id);
    this.save(s);
    return { token, mode: p.mode, expiresAt, familyName: this.family(s, p.familyId).name };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    await this.enter('listDevices');
    const s = this.load();
    const a = this.requireOwner(s);
    return s.devices
      .filter((d) => d.familyId === a.familyId)
      .map(({ id, mode, label, createdAt, expiresAt, lastSeenAt, revokedAt }) => ({ id, mode, label, createdAt, expiresAt, lastSeenAt, revokedAt }));
  }

  async revokeDevice(id: string): Promise<void> {
    await this.enter('revokeDevice');
    const s = this.load();
    const a = this.requireOwner(s);
    const d = s.devices.find((x) => x.id === id && x.familyId === a.familyId);
    if (!d) fail('NOT_FOUND', '기기를 찾을 수 없어요.');
    if (!d.revokedAt) d.revokedAt = this.nowIso();
    this.audit(s, this.actorKey(a), 'device.revoke', 'device', id);
    this.save(s);
  }

  /** TV: allowlist 직렬화만. private 일정·메모·이메일·token·아이 이름은 포함하지 않는다. */
  async getTvBoardData(deviceToken: string): Promise<TvDisplayData> {
    await this.enter('getTvBoardData');
    const s = this.load();
    const d = await this.validateDeviceToken(s, deviceToken, 'tv');
    this.save(s);
    const fam = this.family(s, d.familyId);
    const today = todayIn(fam.timezone, this.now());
    const horizon = addDays(today, 2);
    const events = s.events
      .filter((e) => e.familyId === d.familyId && e.visibility === 'family' && eventOverlapsRange(e, today, horizon, fam.timezone))
      .sort((x, y) => (x.startsAt ?? `${x.startDate}T00:00:00Z`).localeCompare(y.startsAt ?? `${y.startDate}T00:00:00Z`))
      .slice(0, 12)
      .map((e) => ({ id: e.id, title: e.title, allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, startsAt: e.startsAt, endsAt: e.endsAt }));
    const tasks = s.tasks
      .filter((t) => t.familyId === d.familyId && !t.completedAt)
      .slice(0, 12)
      .map((t) => ({ id: t.id, title: t.title, kind: t.kind, dueAt: t.dueAt }));
    const activeChildren = new Set(s.children.filter((c) => c.familyId === d.familyId && c.active).map((c) => c.id));
    const templates = s.habitTemplates.filter((h) => h.familyId === d.familyId && h.active && activeChildren.has(h.childId));
    const done = templates.filter((h) => s.habitRecords.some((r) => r.habitId === h.id && r.localDate === today && r.state !== 'rejected')).length;
    return { familyName: fam.name, today, serverTime: this.nowIso(), events, tasks, habits: { done, total: templates.length } };
  }

  // ───────── 로컬 JSON 전용 도구 (Repository 계약 밖) ─────────
  /** 브라우저 JSON DB를 백업 파일 형태로 직렬화한다. OTP와 일회성 token은 제외한다. */
  exportJson(): string {
    const s = this.load();
    const state: DemoState = {
      ...s,
      otp: {},
      pairing: [],
      unlocks: [],
      idempotency: [],
      failures: {},
    };
    return JSON.stringify(
      { format: 'monggeul-family-board', version: 1, exportedAt: this.nowIso(), state },
      null,
      2,
    );
  }

  /** 내보낸 JSON을 검증해 로컬 DB로 복원하고 첫 owner를 현재 사용자로 선택한다. */
  importJson(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      fail('VALIDATION_ERROR', 'JSON 파일을 읽을 수 없어요.');
    }
    const envelope = value as { format?: unknown; version?: unknown; state?: unknown };
    const raw = envelope?.state as Partial<DemoState> | undefined;
    if (envelope?.format !== 'monggeul-family-board' || envelope.version !== 1 || !raw || raw.v !== 1) {
      fail('VALIDATION_ERROR', '몽글 패밀리보드 백업 JSON이 아니에요.');
    }
    const required = ['users', 'families', 'members', 'children', 'events', 'tasks', 'habitTemplates', 'habitRecords'] as const;
    if (required.some((key) => !Array.isArray(raw[key]))) {
      fail('VALIDATION_ERROR', 'JSON 데이터 구조가 올바르지 않아요.');
    }
    const next = { ...emptyState(), ...clone(raw), v: 1 as const };
    next.otp = {};
    next.pairing = [];
    next.unlocks = [];
    next.idempotency = [];
    next.failures = {};
    this.save(next);
    const owner = next.members.find((m) => m.role === 'owner');
    if (owner) this.sessionStorage.setItem(DEMO_SESSION_KEY, owner.userId);
    else this.sessionStorage.removeItem(DEMO_SESSION_KEY);
    this.deviceStore.clear('tv');
    this.deviceStore.clear('child');
    this.unlockStore.clear();
  }

  /** 현재 로그인 사용자를 owner로 하는 샘플 가족을 만든다. PIN은 1234. */
  async seedSample(): Promise<Family> {
    await this.enter('seedSample');
    const s0 = this.load();
    const u = this.requireUser(s0);
    if (this.memberOf(s0, u.id)) fail('FORBIDDEN', '이미 가족이 있어요.', { reason: 'ALREADY_MEMBER' });
    const salt = toHex(randomBytes(16));
    const hash = await pbkdf2Hex('1234', salt);
    const s = this.load();
    const nowIso = this.nowIso();
    const f: Family = { id: newId(), name: '몽글네', timezone: DEFAULT_TIMEZONE, createdAt: nowIso };
    s.families.push(f);
    s.members.push({ familyId: f.id, userId: u.id, role: 'owner', displayName: u.email.split('@')[0] ?? '보호자' });
    s.secrets.push({ familyId: f.id, salt, hash, iterations: 120000, updatedAt: nowIso });
    const sky: ChildRow = { id: newId(), familyId: f.id, displayName: '하늘', avatarKey: 'bear', active: true };
    const star: ChildRow = { id: newId(), familyId: f.id, displayName: '별이', avatarKey: 'rabbit', active: true };
    s.children.push(sky, star);
    const mk = (c: ChildRow, title: string, icon: string, approval: boolean) =>
      s.habitTemplates.push({ id: newId(), familyId: f.id, childId: c.id, title, iconKey: icon, approvalRequired: approval, active: true });
    mk(sky, '양치하기', 'tooth', true);
    mk(sky, '책 10분 읽기', 'book', true);
    mk(sky, '장난감 정리', 'toy', false);
    mk(star, '양치하기', 'tooth', true);
    mk(star, '물 한 컵 마시기', 'water', false);
    const today = todayIn(f.timezone, this.now());
    const ev =(title: string, date: string, visibility: 'family' | 'private'): CalendarEvent => ({
      id: newId(), familyId: f.id, createdBy: u.id, title, allDay: true, startDate: date, endDate: date, startsAt: null, endsAt: null, visibility, note: null, version: 1, createdAt: nowIso, updatedAt: nowIso,
    });
    s.events.push(ev('가족 외식', today, 'family'), ev('병원 예약 (나만 보기)', today, 'private'), ev('할머니 댁 방문', addDays(today, 2), 'family'));
    s.events.push({
      id: newId(), familyId: f.id, createdBy: u.id, title: '태권도', allDay: false, startDate: null, endDate: null,
      startsAt: zonedToIso(today, '16:00', f.timezone), endsAt: zonedToIso(today, '17:00', f.timezone),
      visibility: 'family', note: '도복 챙기기', version: 1, createdAt: nowIso, updatedAt: nowIso,
    });
    const task = (kind: 'todo' | 'shopping', title: string, extra: Partial<Task> = {}) =>
      s.tasks.push({ id: newId(), familyId: f.id, createdBy: u.id, kind, title, assigneeId: null, assigneeType: null, quantity: null, unit: null, dueAt: null, completedAt: null, clientTimestamp: nowIso, version: 1, createdAt: nowIso, updatedAt: nowIso, ...extra });
    task('todo', '분리수거 내놓기');
    task('todo', '학교 알림장 확인', { assigneeId: sky.id, assigneeType: 'child' });
    task('shopping', '우유', { quantity: 2, unit: '개' });
    task('shopping', '달걀', { quantity: 10, unit: '알' });
    this.audit(s, `user:${u.id}`, 'demo.seed', 'family', f.id);
    this.save(s);
    return f;
  }

  /** 데모 데이터와 기기 token을 모두 지운다 */
  async resetDemo(): Promise<void> {
    this.storage.removeItem(DEMO_STATE_KEY);
    this.sessionStorage.removeItem(DEMO_SESSION_KEY);
    this.deviceStore.clear('tv');
    this.deviceStore.clear('child');
    this.unlockStore.clear();
  }
}

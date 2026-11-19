// 몽글 패밀리보드 도메인 타입 (명세 v1.2 §6, §7)

export type Role = 'owner' | 'adult';
export type Visibility = 'family' | 'private';
export type TaskKind = 'todo' | 'shopping';
export type AssigneeType = 'adult' | 'child';
export type DeviceMode = 'tv' | 'child';
export type HabitState = 'pending' | 'approved' | 'rejected' | 'done';

export interface UserSession {
  userId: string;
  email: string;
}

export interface Family {
  id: string;
  name: string;
  timezone: string;
  createdAt: string;
}

export interface FamilyMember {
  userId: string;
  displayName: string;
  role: Role;
}

export interface ChildProfile {
  id: string;
  displayName: string;
  avatarKey: string;
  active: boolean;
}

/** 로컬 날짜(YYYY-MM-DD) 양끝 포함 범위 */
export interface DateRange {
  from: string;
  to: string;
}

export interface CalendarEvent {
  id: string;
  familyId: string;
  createdBy: string;
  title: string;
  allDay: boolean;
  /** 종일 일정: date 문자열만 */
  startDate: string | null;
  endDate: string | null;
  /** 시간형 일정: ISO-8601 timestamptz만 */
  startsAt: string | null;
  endsAt: string | null;
  visibility: Visibility;
  note: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewEvent {
  title: string;
  allDay: boolean;
  startDate?: string | null;
  endDate?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  visibility: Visibility;
  note?: string | null;
}
export type EventChanges = Partial<NewEvent>;

export interface Task {
  id: string;
  familyId: string;
  createdBy: string;
  kind: TaskKind;
  title: string;
  assigneeId: string | null;
  assigneeType: AssigneeType | null;
  quantity: number | null;
  unit: string | null;
  dueAt: string | null;
  completedAt: string | null;
  clientTimestamp: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  kind: TaskKind;
  title: string;
  assigneeId?: string | null;
  assigneeType?: AssigneeType | null;
  quantity?: number | null;
  unit?: string | null;
  dueAt?: string | null;
}
export type TaskChanges = Partial<NewTask>;

export interface TaskFilter {
  kind?: TaskKind;
  assigneeId?: string;
  completed?: boolean;
}

export interface HabitTemplate {
  id: string;
  childId: string;
  title: string;
  iconKey: string;
  approvalRequired: boolean;
  active: boolean;
}

export interface NewHabitTemplate {
  childId: string;
  title: string;
  iconKey: string;
  approvalRequired: boolean;
}

export interface HabitRecord {
  id: string;
  habitId: string;
  localDate: string;
  state: HabitState;
  approvedBy: string | null;
  clientTimestamp: string;
  version: number;
}

export type HabitWithRecord = HabitTemplate & { record: HabitRecord | null };

export interface PairingCode {
  code: string;
  mode: DeviceMode;
  expiresAt: string;
}

export interface DeviceSession {
  /** 장기 opaque token. DB에는 hash만 있다. URL query 금지 */
  token: string;
  mode: DeviceMode;
  expiresAt: string;
  familyName: string;
}

export interface DeviceInfo {
  id: string;
  mode: DeviceMode;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface UnlockSession {
  /** 메모리에만 보관, 15분 뒤 폐기 */
  token: string;
  expiresAt: string;
}

export interface TvDisplayData {
  familyName: string;
  /** family timezone 기준 오늘 (YYYY-MM-DD) */
  today: string;
  serverTime: string;
  events: Array<{
    id: string;
    title: string;
    allDay: boolean;
    startDate: string | null;
    endDate: string | null;
    startsAt: string | null;
    endsAt: string | null;
  }>;
  tasks: Array<{ id: string; title: string; kind: TaskKind; dueAt: string | null }>;
  habits: { done: number; total: number };
}

export interface InvitationInfo {
  id: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedInvitation {
  id: string;
  /** 원문 token은 생성 응답에서 1회만 반환된다 */
  token: string;
  role: Role;
  expiresAt: string;
}

export type InvitationPreview =
  | { status: 'valid'; role: Role; familyName: string }
  | { status: 'expired' | 'used' | 'revoked' | 'invalid' };

export type AppContext =
  | { kind: 'anonymous' }
  | { kind: 'adult'; session: UserSession; family: Family | null; member: FamilyMember | null }
  | { kind: 'device'; mode: DeviceMode; familyId: string; familyName: string };

export type OutboxAction =
  | {
      type: 'task_completed';
      taskId: string;
      completed: boolean;
      clientTimestamp: string;
      idempotencyKey: string;
    }
  | {
      type: 'habit_check';
      habitId: string;
      localDate: string;
      clientTimestamp: string;
      idempotencyKey: string;
    };

export interface SyncResult {
  idempotencyKey: string;
  status: 'applied' | 'stale' | 'duplicate' | 'error';
  errorCode?: string;
}

/** 목표 timezone 기본값 */
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

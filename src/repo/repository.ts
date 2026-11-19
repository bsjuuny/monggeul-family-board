// 화면이 의존하는 유일한 데이터 계약. 명세 v1.2 §7 "Repository 최소 인터페이스"를 그대로 옮겼다.
import type {
  CalendarEvent,
  ChildProfile,
  DateRange,
  DeviceSession,
  EventChanges,
  Family,
  FamilyMember,
  HabitRecord,
  HabitWithRecord,
  NewEvent,
  NewTask,
  PairingCode,
  Task,
  TaskFilter,
  TvDisplayData,
  UnlockSession,
  UserSession,
  // 확장 계약용
  AppContext,
  CreatedInvitation,
  DeviceInfo,
  HabitTemplate,
  InvitationInfo,
  InvitationPreview,
  NewHabitTemplate,
  OutboxAction,
  SyncResult,
  TaskChanges,
} from '../domain/types';

/** 명세 §7과 시그니처가 동일한 최소 인터페이스 */
export interface FamilyBoardRepository {
  requestOtp(email: string): Promise<void>;
  verifyOtp(email: string, token: string): Promise<UserSession>;
  signOut(): Promise<void>;
  getFamily(): Promise<Family>;
  createFamily(name: string, idempotencyKey: string): Promise<Family>;
  getMembers(): Promise<{ adults: FamilyMember[]; children: ChildProfile[] }>;
  getEvents(range: DateRange): Promise<CalendarEvent[]>;
  createEvent(input: NewEvent, idempotencyKey: string): Promise<CalendarEvent>;
  updateEvent(id: string, version: number, changes: EventChanges): Promise<CalendarEvent>;
  deleteEvent(id: string, version: number): Promise<void>;
  getTasks(filter?: TaskFilter): Promise<Task[]>;
  createTask(input: NewTask, idempotencyKey: string): Promise<Task>;
  setTaskCompleted(id: string, completed: boolean, clientTimestamp: string, idempotencyKey: string): Promise<Task>;
  getHabits(childId: string, localDate: string): Promise<HabitWithRecord[]>;
  checkHabit(habitId: string, localDate: string, clientTimestamp: string, idempotencyKey: string): Promise<HabitRecord>;
  approveHabit(recordId: string): Promise<HabitRecord>;
  createPairingCode(mode: 'tv' | 'child'): Promise<PairingCode>;
  exchangePairingCode(code: string): Promise<DeviceSession>;
  getTvBoardData(deviceToken: string): Promise<TvDisplayData>;
  verifyParentPin(pin: string): Promise<UnlockSession>;
}

/**
 * 명세 최소 인터페이스가 다루지 않는 P0 흐름(초대 수락, 반려, 기기 관리, 아이/습관 설정, outbox 동기화)을
 * 위한 확장 계약. 명세 §1 "최소 가정"에 따라 README에 기록했다.
 */
export interface FamilyBoardExtensions {
  getAppContext(): Promise<AppContext>;
  setParentPin(pin: string): Promise<void>;
  addChild(input: { displayName: string; avatarKey: string }, idempotencyKey: string): Promise<ChildProfile>;
  setChildActive(id: string, active: boolean): Promise<ChildProfile>;
  addHabitTemplate(input: NewHabitTemplate, idempotencyKey: string): Promise<HabitTemplate>;
  setHabitActive(id: string, active: boolean): Promise<HabitTemplate>;
  rejectHabit(recordId: string): Promise<HabitRecord>;
  updateTask(id: string, version: number, changes: TaskChanges): Promise<Task>;
  deleteTask(id: string, version: number): Promise<void>;
  createInvitation(role?: 'adult'): Promise<CreatedInvitation>;
  listInvitations(): Promise<InvitationInfo[]>;
  revokeInvitation(id: string): Promise<void>;
  previewInvitation(token: string): Promise<InvitationPreview>;
  acceptInvitation(token: string): Promise<Family>;
  removeMember(userId: string): Promise<void>;
  listDevices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string): Promise<void>;
  syncOfflineActions(actions: OutboxAction[]): Promise<SyncResult[]>;
}

export type FullRepository = FamilyBoardRepository & FamilyBoardExtensions;

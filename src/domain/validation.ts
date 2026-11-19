// 입력 검증. UI와 로컬 JSON 문서 엔진(DemoRepository)이 같은 규칙을 쓴다.
import { FamilyBoardError } from './errors';
import { isValidDate } from './dates';
import type { NewEvent, NewTask, NewHabitTemplate, EventChanges, TaskChanges } from './types';

export const LIMITS = {
  titleMax: 120,
  noteMax: 500,
  familyNameMax: 40,
  childNameMax: 20,
  habitTitleMax: 40,
  unitMax: 10,
  quantityMax: 9999,
} as const;

function bad(message: string, field?: string): never {
  throw new FamilyBoardError('VALIDATION_ERROR', message, field ? { field } : {});
}

export function validateText(value: unknown, min: number, max: number, label: string, field: string): string {
  if (typeof value !== 'string') bad(`${label}을(를) 입력해 주세요.`, field);
  const v = value.trim();
  if (v.length < min) bad(`${label}을(를) ${min}자 이상 입력해 주세요.`, field);
  if (v.length > max) bad(`${label}은(는) ${max}자 이하로 입력해 주세요.`, field);
  return v;
}

export function validateEmail(email: unknown): string {
  if (typeof email !== 'string') bad('이메일을 입력해 주세요.', 'email');
  const v = email.trim().toLowerCase();
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad('이메일 형식을 확인해 주세요.', 'email');
  return v;
}

export function validateOtp(token: unknown): string {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token.trim())) bad('6자리 숫자 코드를 입력해 주세요.', 'token');
  return token.trim();
}

export function validatePin(pin: unknown): string {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) bad('부모 PIN은 4~6자리 숫자예요.', 'pin');
  return pin;
}

export function validatePairingCode(code: unknown): string {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) bad('연결 코드는 6자리 숫자예요.', 'code');
  return code.trim();
}

export function validateFamilyName(name: unknown): string {
  return validateText(name, 1, LIMITS.familyNameMax, '가족 이름', 'name');
}

export function validateChildName(name: unknown): string {
  return validateText(name, 1, LIMITS.childNameMax, '아이 별칭', 'displayName');
}

export function validateHabit(input: NewHabitTemplate): NewHabitTemplate {
  return {
    childId: input.childId,
    title: validateText(input.title, 1, LIMITS.habitTitleMax, '습관 이름', 'title'),
    iconKey: typeof input.iconKey === 'string' && input.iconKey ? input.iconKey.slice(0, 20) : 'star',
    approvalRequired: Boolean(input.approvalRequired),
  };
}

export function validateUuid(v: unknown, field = 'id'): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    bad('올바르지 않은 식별자예요.', field);
  }
  return v;
}

function validateIso(v: unknown, label: string, field: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    bad(`${label}을(를) 확인해 주세요.`, field);
  }
  return new Date(v).toISOString();
}

export interface NormalizedEvent {
  title: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  visibility: 'family' | 'private';
  note: string | null;
}

/** 종일은 date만, 시간형은 timestamptz만 허용하는 규칙(§6 CHECK)과 동일 */
export function validateEventInput(input: NewEvent): NormalizedEvent {
  const title = validateText(input.title, 1, LIMITS.titleMax, '제목', 'title');
  if (input.visibility !== 'family' && input.visibility !== 'private') bad('공개 범위를 선택해 주세요.', 'visibility');
  const note = input.note == null || input.note.trim() === '' ? null : validateText(input.note, 1, LIMITS.noteMax, '메모', 'note');
  if (input.allDay) {
    if (!isValidDate(input.startDate)) bad('시작 날짜를 확인해 주세요.', 'startDate');
    if (!isValidDate(input.endDate)) bad('종료 날짜를 확인해 주세요.', 'endDate');
    if (input.endDate < input.startDate) bad('종료 날짜는 시작 날짜보다 빠를 수 없어요.', 'endDate');
    if (input.startsAt || input.endsAt) bad('종일 일정에는 시간을 넣을 수 없어요.', 'startsAt');
    return { title, allDay: true, startDate: input.startDate, endDate: input.endDate, startsAt: null, endsAt: null, visibility: input.visibility, note };
  }
  const startsAt = validateIso(input.startsAt, '시작 시각', 'startsAt');
  const endsAt = validateIso(input.endsAt, '종료 시각', 'endsAt');
  if (Date.parse(endsAt) <= Date.parse(startsAt)) bad('종료 시각은 시작 시각보다 늦어야 해요.', 'endsAt');
  if (input.startDate || input.endDate) bad('시간 일정에는 날짜 값만 따로 넣을 수 없어요.', 'startDate');
  return { title, allDay: false, startDate: null, endDate: null, startsAt, endsAt, visibility: input.visibility, note };
}

/** 변경분을 기존 이벤트에 합친 뒤 전체 규칙을 다시 검증한다 */
export function mergeEventChanges(
  current: NormalizedEvent,
  changes: EventChanges,
): NormalizedEvent {
  const merged: NewEvent = {
    title: changes.title ?? current.title,
    allDay: changes.allDay ?? current.allDay,
    startDate: changes.startDate !== undefined ? changes.startDate : current.startDate,
    endDate: changes.endDate !== undefined ? changes.endDate : current.endDate,
    startsAt: changes.startsAt !== undefined ? changes.startsAt : current.startsAt,
    endsAt: changes.endsAt !== undefined ? changes.endsAt : current.endsAt,
    visibility: changes.visibility ?? current.visibility,
    note: changes.note !== undefined ? changes.note : current.note,
  };
  // 종일↔시간 전환 시 반대쪽 필드는 비운다
  if (merged.allDay) {
    merged.startsAt = null;
    merged.endsAt = null;
  } else {
    merged.startDate = null;
    merged.endDate = null;
  }
  return validateEventInput(merged);
}

export interface NormalizedTask {
  kind: 'todo' | 'shopping';
  title: string;
  assigneeId: string | null;
  assigneeType: 'adult' | 'child' | null;
  quantity: number | null;
  unit: string | null;
  dueAt: string | null;
}

export function validateTaskInput(input: NewTask): NormalizedTask {
  if (input.kind !== 'todo' && input.kind !== 'shopping') bad('종류를 선택해 주세요.', 'kind');
  const title = validateText(input.title, 1, LIMITS.titleMax, '제목', 'title');
  const assigneeId = input.assigneeId ?? null;
  const assigneeType = input.assigneeType ?? null;
  if ((assigneeId === null) !== (assigneeType === null)) bad('담당자를 다시 선택해 주세요.', 'assigneeId');
  if (assigneeType !== null && assigneeType !== 'adult' && assigneeType !== 'child') bad('담당자를 다시 선택해 주세요.', 'assigneeType');
  let quantity: number | null = null;
  if (input.quantity !== undefined && input.quantity !== null) {
    if (typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > LIMITS.quantityMax) {
      bad(`수량은 0보다 크고 ${LIMITS.quantityMax} 이하의 숫자예요.`, 'quantity');
    }
    quantity = input.quantity;
  }
  let unit: string | null = null;
  if (input.unit != null && input.unit.trim() !== '') unit = validateText(input.unit, 1, LIMITS.unitMax, '단위', 'unit');
  const dueAt = input.dueAt ? validateIso(input.dueAt, '마감', 'dueAt') : null;
  if (input.kind === 'shopping' && dueAt) bad('장보기에는 마감을 넣지 않아요.', 'dueAt');
  if (input.kind === 'todo' && (quantity !== null || unit !== null)) bad('수량·단위는 장보기에서만 쓸 수 있어요.', 'quantity');
  return { kind: input.kind, title, assigneeId, assigneeType, quantity, unit, dueAt };
}

export function mergeTaskChanges(current: NormalizedTask, changes: TaskChanges): NormalizedTask {
  return validateTaskInput({
    kind: changes.kind ?? current.kind,
    title: changes.title ?? current.title,
    assigneeId: changes.assigneeId !== undefined ? changes.assigneeId : current.assigneeId,
    assigneeType: changes.assigneeType !== undefined ? changes.assigneeType : current.assigneeType,
    quantity: changes.quantity !== undefined ? changes.quantity : current.quantity,
    unit: changes.unit !== undefined ? changes.unit : current.unit,
    dueAt: changes.dueAt !== undefined ? changes.dueAt : current.dueAt,
  });
}

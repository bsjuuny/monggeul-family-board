// 홈·TV가 함께 쓰는 "오늘 일정/할 일" 선택 규칙 (순수 함수)
import { isoToZoned } from './dates';

type EventLike = { id: string; allDay: boolean; startsAt: string | null; endsAt: string | null; startDate: string | null };
type TaskLike = { completedAt: string | null; dueAt: string | null; createdAt: string };

/** 종일 일정을 먼저, 그다음 시작 시각 순 */
export function sortEvents<T extends EventLike>(events: readonly T[]): T[] {
  const key = (e: T) => (e.allDay || !e.startsAt ? Number.NEGATIVE_INFINITY : new Date(e.startsAt).getTime());
  return [...events].sort((a, b) => key(a) - key(b));
}

export function isEventPast(e: EventLike, now: Date): boolean {
  if (e.allDay || !e.startsAt) return false;
  // 종료 시각이 없으면 시작 후 1시간 동안 진행 중으로 본다
  const end = e.endsAt ? new Date(e.endsAt).getTime() : new Date(e.startsAt).getTime() + 3_600_000;
  return end <= now.getTime();
}

/** "다음 일정": 아직 끝나지 않은 시간형 일정 중 가장 이른 것. 종일 일정은 대상이 아니다. */
export function findNextEvent<T extends EventLike>(sorted: readonly T[], now: Date): T | undefined {
  return sorted.find((e) => !e.allDay && Boolean(e.startsAt) && !isEventPast(e, now));
}

/**
 * 표시 개수 제한 안에서 다음 일정이 반드시 보이도록 고른다.
 * 다음 일정 바로 앞의 일정 1개(직전 맥락)부터 보여 주고, 끝나지 않은 일정이 없으면 마지막 일정들을 보여 준다.
 */
export function pickVisibleEvents<T extends EventLike>(sorted: readonly T[], next: T | undefined, limit: number): T[] {
  if (sorted.length <= limit) return [...sorted];
  const nextIdx = next ? sorted.indexOf(next) : sorted.length;
  const start = Math.min(Math.max(nextIdx - 1, 0), sorted.length - limit);
  return sorted.slice(start, start + limit);
}

/** 다음 일정까지 남은 시간 (분은 올림: 29초 남아도 "1분 후") */
export function countdownKo(startsAt: string | null, now: Date): string {
  if (!startsAt) return '오늘 함께해요';
  const minutes = Math.ceil((new Date(startsAt).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return '지금 진행 중';
  if (minutes < 60) return `${minutes}분 후`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분 후` : `${hours}시간 후`;
}

/** 해당 날짜 기준 표시 시각. 전날부터 이어지는 일정은 "이어서" */
export function eventTimeOn(e: EventLike, date: string, tz: string): { time: string; ampm: string } {
  if (e.allDay || !e.startsAt) return { time: '종일', ampm: '' };
  const start = isoToZoned(e.startsAt, tz);
  if (start.date < date) return { time: '이어서', ampm: '' };
  return { time: start.time, ampm: Number(start.time.slice(0, 2)) < 12 ? 'AM' : 'PM' };
}

/** 미완료 우선 → 기한 빠른 순(기한 없음은 뒤) → 오래된 순 */
export function sortTasks<T extends TaskLike>(tasks: readonly T[]): T[] {
  const due = (t: T) => (t.dueAt ? new Date(t.dueAt).getTime() : Number.POSITIVE_INFINITY);
  return [...tasks].sort(
    (a, b) =>
      Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) ||
      due(a) - due(b) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** 오늘 보여 줄 할 일: 남은 것 전부 + 오늘 끝낸 것 (예전에 끝낸 것은 제외) */
export function tasksForToday<T extends TaskLike>(tasks: readonly T[], today: string, tz: string): T[] {
  return tasks.filter((t) => !t.completedAt || isoToZoned(t.completedAt, tz).date === today);
}

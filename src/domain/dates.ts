// 날짜·시간 유틸. 모든 "로컬 날짜"는 family timezone(기본 Asia/Seoul) 기준 YYYY-MM-DD 문자열이다.
import type { CalendarEvent } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s: unknown): s is string {
  return typeof s === 'string' && TIME_RE.test(s);
}

function parts(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`invalid date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 0 = 일요일 */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function startOfWeek(date: string): string {
  return addDays(date, -weekdayOf(date));
}

export function startOfMonth(date: string): string {
  const [y, m] = parts(date);
  return fmt(y, m, 1);
}

export function endOfMonth(date: string): string {
  const [y, m] = parts(date);
  return fmt(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

export function addMonths(date: string, n: number): string {
  const [y, m] = parts(date);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 월간 달력 칸 (일요일 시작, 5~6주) */
export function monthGrid(anchor: string): string[] {
  const first = startOfMonth(anchor);
  const last = endOfMonth(anchor);
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const out: string[] = [];
  for (let d = start; compareDates(d, end) <= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

export function weekDays(anchor: string): string[] {
  const s = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function zonedParts(ts: number, tz: string) {
  const o: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return {
    y: Number(o.year),
    mo: Number(o.month),
    d: Number(o.day),
    h: Number(o.hour) % 24,
    mi: Number(o.minute),
    s: Number(o.second),
  };
}

function offsetMinutes(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}

/** instant → 해당 timezone의 로컬 날짜/시각 */
export function isoToZoned(iso: string, tz: string): { date: string; time: string } {
  const p = zonedParts(new Date(iso).getTime(), tz);
  return { date: fmt(p.y, p.mo, p.d), time: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` };
}

/** 로컬 날짜/시각 → ISO-8601(UTC) instant */
export function zonedToIso(date: string, time: string, tz: string): string {
  const [y, m, d] = parts(date);
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetMinutes(guess, tz) * 60000;
  ts = guess - offsetMinutes(ts, tz) * 60000;
  return new Date(ts).toISOString();
}

export function todayIn(tz: string, now: Date = new Date()): string {
  return isoToZoned(now.toISOString(), tz).date;
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
export function weekdayKo(date: string): string {
  return WEEKDAY_KO[weekdayOf(date)] ?? '';
}

/** 11월 19일 (목) */
export function formatKoreanDate(date: string): string {
  const [, m, d] = parts(date);
  return `${m}월 ${d}일 (${weekdayKo(date)})`;
}

export function formatKoreanMonth(date: string): string {
  const [y, m] = parts(date);
  return `${y}년 ${m}월`;
}

export function formatTimeRangeKo(ev: Pick<CalendarEvent, 'allDay' | 'startsAt' | 'endsAt'>, tz: string): string {
  if (ev.allDay || !ev.startsAt || !ev.endsAt) return '종일';
  return `${isoToZoned(ev.startsAt, tz).time}–${isoToZoned(ev.endsAt, tz).time}`;
}

type EventLike = Pick<CalendarEvent, 'allDay' | 'startDate' | 'endDate' | 'startsAt' | 'endsAt'>;

/** 일정이 걸치는 로컬 날짜 범위 */
export function eventLocalRange(ev: EventLike, tz: string): { startDate: string; endDate: string } {
  if (ev.allDay && ev.startDate && ev.endDate) return { startDate: ev.startDate, endDate: ev.endDate };
  if (ev.startsAt && ev.endsAt) {
    const s = isoToZoned(ev.startsAt, tz).date;
    // 종료가 정확히 자정이면 그 전날까지로 본다
    const endLocal = isoToZoned(new Date(new Date(ev.endsAt).getTime() - 1).toISOString(), tz).date;
    return { startDate: s, endDate: compareDates(endLocal, s) < 0 ? s : endLocal };
  }
  throw new Error('invalid event');
}

export function eventCoversDate(ev: EventLike, date: string, tz: string): boolean {
  const r = eventLocalRange(ev, tz);
  return compareDates(r.startDate, date) <= 0 && compareDates(date, r.endDate) <= 0;
}

export function eventOverlapsRange(ev: EventLike, from: string, to: string, tz: string): boolean {
  const r = eventLocalRange(ev, tz);
  return compareDates(r.startDate, to) <= 0 && compareDates(from, r.endDate) <= 0;
}

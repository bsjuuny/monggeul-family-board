// 공지 속 한국어 날짜 표현을 실제 날짜(YYYY-MM-DD, Asia/Seoul)로 바꾼다.
// 기준일은 공지를 받은 날(receivedOn)이다. 확실하지 않은 날짜는 confidence 'inferred' 로 표시한다.
import type { DateMention } from './types';

const WD = '일월화수목금토';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function isoOf(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 0=일 … 6=토 */
export function weekdayIdx(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayKoOf(iso: string): string {
  return WD[weekdayIdx(iso)] as string;
}

/** 월~일 주의 월요일 */
function mondayOf(iso: string): string {
  const w = weekdayIdx(iso);
  return addDaysIso(iso, w === 0 ? -6 : 1 - w);
}

function dayOfWeekInWeek(monday: string, wdChar: string): string {
  const idx = WD.indexOf(wdChar); // 0=일
  return addDaysIso(monday, idx === 0 ? 6 : idx - 1);
}

/** 연도 없는 월·일: 기준일보다 90일 넘게 과거면 다음 해로 본다 */
function inferYear(received: string, m: number, d: number): string | null {
  const y = Number(received.slice(0, 4));
  const cand = isoOf(y, m, d);
  if (!cand) return null;
  if (cand < addDaysIso(received, -90)) return isoOf(y + 1, m, d);
  if (cand > addDaysIso(received, 275)) return isoOf(y - 1, m, d);
  return cand;
}

export function parseTime(s: string): string | null {
  let m = s.match(/(\d{1,2})\s*:\s*(\d{2})/);
  let hour: number;
  let min: number;
  let ampm: string | undefined;
  if (m) {
    hour = Number(m[1]);
    min = Number(m[2]);
    ampm = s.match(/(오전|오후|아침|저녁|낮)/)?.[1];
  } else {
    m = s.match(/(오전|오후|아침|저녁|낮)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분|(반))?/);
    if (!m) return null;
    ampm = m[1];
    hour = Number(m[2]);
    min = m[4] ? 30 : m[3] ? Number(m[3]) : 0;
  }
  if (hour > 24 || min > 59) return null;
  if ((ampm === '오후' || ampm === '저녁') && hour < 12) hour += 12;
  else if (ampm === '낮' && hour < 6) hour += 12;
  else if (!ampm && hour >= 1 && hour <= 6) hour += 12; // 어린이집 공지의 '3시 하원'은 오후
  if (hour === 24) hour = 0;
  return `${pad(hour)}:${pad(min)}`;
}

const TIME_RE = /(?:(?:오전|오후|아침|저녁|낮)\s*)?(?:\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*시(?:\s*(?:\d{1,2}\s*분|반))?)/g;

export function findTimes(text: string): Array<{ time: string; index: number; text: string }> {
  const out: Array<{ time: string; index: number; text: string }> = [];
  for (const m of text.matchAll(TIME_RE)) {
    const t = parseTime(m[0]);
    // '1시간', '2시간' 같은 길이는 시각이 아니다
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2);
    if (t && !/^간/.test(after)) out.push({ time: t, index: m.index ?? 0, text: m[0] });
  }
  return out;
}

const EVENT_WORDS = ['체험', '견학', '소풍', '행사', '발표', '공연', '운동회', '수업', '참관', '생일', '졸업', '입학', '활동', '산책', '교육', '방문', '나들이', '축제', '파티', '상담', '촬영', '검진', '접종', '특강', '캠프'];
const DEADLINE_AFTER = /^\s*(?:\([^)]*\)\s*)?(?:[^.!?\n]{0,6})?(?:까지|전까지|마감)/;

interface Raw {
  date: string;
  endDate: string | null;
  index: number;
  len: number;
  text: string;
  confidence: DateMention['confidence'];
  weekdayMismatch?: boolean;
}

/** 원문에서 날짜 표현을 모두 찾는다(겹치는 표현은 먼저 찾은 긴 것을 쓴다). */
export function extractDates(text: string, receivedOn: string): DateMention[] {
  const raws: Raw[] = [];
  const taken: Array<[number, number]> = [];
  const free = (i: number, len: number) => !taken.some(([a, b]) => i < b && i + len > a);
  const push = (r: Raw) => {
    if (!free(r.index, r.len)) return;
    taken.push([r.index, r.index + r.len]);
    raws.push(r);
  };
  const wdCheck = (iso: string, wd: string | undefined) => (wd ? weekdayKoOf(iso) !== wd : false);

  // 1) 연-월-일
  for (const m of text.matchAll(/(\d{4})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*일?(?:\s*\(\s*([월화수목금토일])\s*(?:요일)?\s*\))?/g)) {
    const iso = isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!iso) continue;
    const mis = wdCheck(iso, m[4]);
    push({ date: iso, endDate: null, index: m.index ?? 0, len: m[0].length, text: m[0].trim(), confidence: mis ? 'inferred' : 'exact', weekdayMismatch: mis || undefined });
  }
  // 2) 월 일 (요일)
  for (const m of text.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*\(?\s*([월화수목금토일])\s*(?:요일)?\s*\)?)?/g)) {
    const iso = inferYear(receivedOn, Number(m[1]), Number(m[2]));
    if (!iso) continue;
    const mis = wdCheck(iso, m[3]);
    push({ date: iso, endDate: null, index: m.index ?? 0, len: m[0].length, text: m[0].trim(), confidence: mis ? 'inferred' : 'exact', weekdayMismatch: mis || undefined });
  }
  // 3) 11/23(월), 11.23(월) — 요일 괄호가 있을 때만 날짜로 본다(분수·소수와 구분)
  for (const m of text.matchAll(/(?<![\d.])(\d{1,2})\s*[./]\s*(\d{1,2})\s*\(\s*([월화수목금토일])\s*\)/g)) {
    const iso = inferYear(receivedOn, Number(m[1]), Number(m[2]));
    if (!iso) continue;
    const mis = wdCheck(iso, m[3]);
    push({ date: iso, endDate: null, index: m.index ?? 0, len: m[0].length, text: m[0].trim(), confidence: mis ? 'inferred' : 'exact', weekdayMismatch: mis || undefined });
  }
  // 4) 이번 주/다음 주/다다음 주 X요일
  for (const m of text.matchAll(/(이번|다음|다다음)\s*주\s*([월화수목금토일])\s*요일/g)) {
    const shift = m[1] === '이번' ? 0 : m[1] === '다음' ? 7 : 14;
    const iso = dayOfWeekInWeek(addDaysIso(mondayOf(receivedOn), shift), m[2] as string);
    push({ date: iso, endDate: null, index: m.index ?? 0, len: m[0].length, text: m[0], confidence: 'relative' });
  }
  // 5) 오늘·내일·모레·글피
  for (const m of text.matchAll(/(오늘|내일|모레|글피)/g)) {
    const n = { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1] as '오늘'];
    push({ date: addDaysIso(receivedOn, n), endDate: null, index: m.index ?? 0, len: m[0].length, text: m[0], confidence: 'relative' });
  }
  // 6) 요일만: 다가오는 그 요일(오늘 포함 안 함) — 추정
  for (const m of text.matchAll(/(?<![가-힣])([월화수목금토일])\s*요일/g)) {
    const idx = WD.indexOf(m[1] as string);
    let diff = (idx - weekdayIdx(receivedOn) + 7) % 7;
    if (diff === 0) diff = 7;
    push({ date: addDaysIso(receivedOn, diff), endDate: null, index: m.index ?? 0, len: m[0].length, text: m[0], confidence: 'inferred' });
  }

  raws.sort((a, b) => a.index - b.index);
  // 기간: "A ~ B", "A부터 B까지", "11월 23일~25일"
  const merged: Raw[] = [];
  for (let i = 0; i < raws.length; i++) {
    const r = raws[i] as Raw;
    const next = raws[i + 1];
    const gap = next ? text.slice(r.index + r.len, next.index) : '';
    if (next && /^\s*(?:~|∼|-|–|부터)\s*$/.test(gap) && next.date >= r.date) {
      merged.push({ ...r, endDate: next.date, len: next.index + next.len - r.index, text: text.slice(r.index, next.index + next.len).trim(),
        confidence: r.confidence === 'exact' && next.confidence === 'exact' ? 'exact' : r.confidence === 'inferred' || next.confidence === 'inferred' ? 'inferred' : 'relative' });
      i++;
      continue;
    }
    const dayOnly = text.slice(r.index + r.len).match(/^\s*(?:~|∼|-|–)\s*(\d{1,2})\s*일/);
    if (dayOnly) {
      const end = isoOf(Number(r.date.slice(0, 4)), Number(r.date.slice(5, 7)), Number(dayOnly[1]));
      if (end && end > r.date) {
        merged.push({ ...r, endDate: end, len: r.len + dayOnly[0].length, text: text.slice(r.index, r.index + r.len + dayOnly[0].length).trim() });
        continue;
      }
    }
    merged.push(r);
  }

  const times = findTimes(text);
  return merged.map((r) => {
    const after = text.slice(r.index + r.len, r.index + r.len + 24);
    const sentenceEnd = after.search(/[.!?\n]/);
    const tail = sentenceEnd >= 0 ? after.slice(0, sentenceEnd) : after;
    const t = times.find((x) => x.index >= r.index + r.len && x.index < r.index + r.len + tail.length);
    const sentence = sentenceOf(text, r.index);
    const kind: DateMention['kind'] = DEADLINE_AFTER.test(text.slice(r.index + r.len, r.index + r.len + 14))
      ? 'deadline'
      : EVENT_WORDS.some((w) => sentence.includes(w))
        ? 'event'
        : 'mention';
    return { date: r.date, endDate: r.endDate, time: t?.time ?? null, text: r.text, kind, confidence: r.confidence, index: r.index, weekdayMismatch: r.weekdayMismatch };
  });
}

export function sentenceOf(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('\n', index - 1), text.lastIndexOf('!', index - 1), text.lastIndexOf('?', index - 1)) + 1;
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?\n]/);
  return text.slice(start, endRel >= 0 ? index + endRel + 1 : text.length).trim();
}

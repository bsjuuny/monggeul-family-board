// 보드 표시용 순수 함수 (테스트: tests/board.test.ts)
import type { CommutePlan, Period } from '../server/v2';

const KST_OFFSET = 9 * 3600 * 1000;

/** Date → 한국 시간 'HH:MM' */
export function kstHm(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET).toISOString().slice(11, 16);
}

export function kstDate(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' + 'HH:MM' (한국 시간) → epoch ms */
export function kstToMs(date: string, hm: string): number {
  return Date.parse(`${date}T${hm}:00+09:00`);
}

export function periodAt(now: Date, screen: { morningFrom: string; afternoonFrom: string; eveningFrom: string }): Period {
  const hm = kstHm(now);
  if (hm >= screen.morningFrom && hm < screen.afternoonFrom) return 'morning';
  if (hm >= screen.afternoonFrom && hm < screen.eveningFrom) return 'afternoon';
  return 'evening';
}

/** 지금 시간대가 끝나는 시각(수동 전환은 이때까지 유지) */
export function periodEndsAt(now: Date, screen: { morningFrom: string; afternoonFrom: string; eveningFrom: string }): number {
  const today = kstDate(now);
  const hm = kstHm(now);
  const bounds = [screen.morningFrom, screen.afternoonFrom, screen.eveningFrom];
  const next = bounds.find((b) => b > hm);
  if (next) return kstToMs(today, next);
  const t = new Date(kstToMs(today, '00:00') + 24 * 3600 * 1000);
  return kstToMs(kstDate(t), screen.morningFrom);
}

/** 남은 시간 문구. 60분 미만 '25분', 이상 '1시간 20분', 12시간 이상은 null(시각으로 표시) */
export function remainKo(ms: number): string | null {
  const min = Math.ceil(ms / 60000);
  if (min <= 0) return null;
  if (min < 60) return `${min}분`;
  if (min >= 12 * 60) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

/** 숫자와 단위를 나눠 큰 숫자로 보여 주기 위해 쪼갠다: '1시간 20분' → [['1','시간'],['20','분']] */
export function splitUnits(text: string): Array<[string, string]> {
  return Array.from(text.matchAll(/(\d+)\s*([^\d\s]+)/g), (m) => [m[1] as string, m[2] as string]);
}

const WD = '일월화수목금토';
export function dateKo(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 ${wd}요일`;
}

export function shortDateKo(iso: string, today: string): string {
  const diff = Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === 2) return '모레';
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  const wd = WD[new Date(Date.parse(iso)).getUTCDay()];
  return `${m}/${d}(${wd})`;
}

/** 받침이 있으면 '이'를 붙인다: 서윤 → 서윤이, 하루 → 하루 */
export function callName(name: string): string {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return name;
  return code % 28 ? `${name}이` : name;
}

export function greeting(period: Period, names: string[]): string {
  const who = names.length ? names.map(callName).join('·') : '우리 가족';
  if (period === 'morning') return `좋은 아침이에요, ${who}`;
  if (period === 'afternoon') return `즐거운 오후예요, ${who}`;
  return `오늘도 수고했어요, ${who}`;
}

export type CommuteView =
  | { kind: 'empty' }
  | { kind: 'off'; title: string; note: string | null; needsReview: boolean }
  | { kind: 'countdown'; label: string; value: string; pill: string; sub: string | null; needsReview: boolean; changeNote: string | null }
  | { kind: 'clock'; label: string; value: string; pill: string | null; sub: string | null; needsReview: boolean; changeNote: string | null }
  | { kind: 'done'; title: string; sub: string | null; tone: 'success' | 'warning' };

function earliest(plans: CommutePlan[], key: 'leaveHomeAt' | 'pickupAt'): CommutePlan | undefined {
  return [...plans].filter((p) => p.attends).sort((a, b) => a[key].localeCompare(b[key]))[0];
}

function changeNote(p: CommutePlan, kind: 'dropoff_time' | 'pickup_time'): string | null {
  const c = p.changes.find((x) => x.kind === kind);
  if (!c) return null;
  return `${kind === 'dropoff_time' ? '등원' : '하원'} 시간이 바뀌었어요 · ${c.time}${c.needsReview ? ' (확인 필요)' : ''}`;
}

/** 시간대·현재 시각에 맞는 등하원 카드 내용을 고른다 */
export function commuteView(period: Period, now: Date, today: CommutePlan[], tomorrow: CommutePlan[],
  pickupDone: boolean, assignee: string | null): CommuteView {
  if (!today.length && !tomorrow.length) return { kind: 'empty' };
  const nowMs = now.getTime();
  if (period === 'evening') {
    const p = earliest(tomorrow, 'leaveHomeAt');
    if (!p) {
      const off = tomorrow[0];
      return { kind: 'off', title: off?.closed ? '내일은 쉬는 날이에요' : '내일은 등원하지 않아요', note: off?.closedNote ?? null, needsReview: Boolean(off?.needsReview) };
    }
    const remain = remainKo(kstToMs(p.date, p.leaveHomeAt) - nowMs);
    return { kind: 'clock', label: '내일 등원', value: p.leaveHomeAt, pill: `${p.arriveBy}까지 도착`, sub: [remain ? `출발까지 ${remain}` : null, `내일 하원 ${p.pickupAt}${p.pickupAssignee ? ` · ${p.pickupAssignee}` : ''}`].filter(Boolean).join(' · '), needsReview: p.needsReview, changeNote: changeNote(p, 'dropoff_time') };
  }
  const drop = earliest(today, 'leaveHomeAt');
  if (!drop) {
    const off = today[0];
    return { kind: 'off', title: off?.closed ? '오늘은 쉬는 날이에요' : '오늘은 등원하지 않아요', note: off?.closedNote ?? null, needsReview: Boolean(off?.needsReview) };
  }
  const pick = earliest(today, 'pickupAt') as CommutePlan;
  const leaveMs = kstToMs(drop.date, drop.leaveHomeAt);
  const pickMs = kstToMs(pick.date, pick.pickupAt);
  const pickupRemain = remainKo(pickMs - nowMs);
  if (period === 'morning' && nowMs < leaveMs) {
    return {
      kind: 'countdown', label: '등원 출발까지', value: remainKo(leaveMs - nowMs) ?? drop.leaveHomeAt, pill: `${drop.leaveHomeAt} 출발`,
      sub: `하원 ${pick.pickupAt}${pickupRemain ? ` · ${pickupRemain}` : ''}`, needsReview: drop.needsReview || pick.needsReview,
      changeNote: changeNote(drop, 'dropoff_time') ?? changeNote(pick, 'pickup_time'),
    };
  }
  if (nowMs < pickMs) {
    return {
      kind: 'countdown', label: '하원까지', value: pickupRemain ?? pick.pickupAt, pill: `${pick.pickupAt} 하원`,
      sub: assignee ? `픽업 · ${assignee}` : null, needsReview: pick.needsReview, changeNote: changeNote(pick, 'pickup_time'),
    };
  }
  return pickupDone
    ? { kind: 'done', title: '하원 완료', sub: assignee ? `픽업 · ${assignee}` : null, tone: 'success' }
    : { kind: 'done', title: '하원 확인 필요', sub: `${pick.pickupAt} 하원 예정이었어요`, tone: 'warning' };
}

export function weatherPhrase(condition: string | null | undefined, temp: number | null | undefined): string {
  if (!condition) return '날씨 정보 없음';
  const feel = temp == null ? '' : temp <= 0 ? '추워요' : temp <= 8 ? '쌀쌀해요' : temp <= 17 ? '선선해요' : temp <= 26 ? '따뜻해요' : '더워요';
  const head = condition === '맑음' ? '맑고' : condition === '구름 많음' ? '구름 많고' : condition === '흐림' ? '흐리고' : condition;
  if (!feel) return condition;
  return /(비|눈|소나기|진눈깨비|눈날림|이슬비)/.test(condition) ? `${condition}, ${feel}` : `${head} ${feel}`;
}

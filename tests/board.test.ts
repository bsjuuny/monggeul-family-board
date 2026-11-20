import { describe, expect, it } from 'vitest';
import { callName, commuteView, greeting, nextDayLabel, periodAt, periodEndsAt, remainKo, weatherPhrase } from '../src/board/format';
import type { CommutePlan } from '../src/server/v2';

const plan = (date: string, p: Partial<CommutePlan> = {}): CommutePlan => ({
  childId: 'c1', date, attends: true, closed: false, closedNote: null, leaveHomeAt: '08:30', arriveBy: '09:00', pickupAt: '16:30',
  pickupAssignee: '엄마', needsReview: false, changes: [], ...p,
});
const at = (hm: string, d = '2026-11-20') => new Date(`${d}T${hm}:00+09:00`);
const SCREEN = { morningFrom: '05:00', afternoonFrom: '11:30', eveningFrom: '18:00' };

describe('보드 표시 규칙', () => {
  it('남은 시간 문구', () => {
    expect(remainKo(25 * 60e3)).toBe('25분');
    expect(remainKo(80 * 60e3)).toBe('1시간 20분');
    expect(remainKo(120 * 60e3)).toBe('2시간');
    expect(remainKo(13 * 3600e3)).toBeNull(); // 12시간 이상은 시각으로
    expect(remainKo(0)).toBeNull();
  });
  it('시간대와 수동 전환 유지 시각', () => {
    expect(periodAt(at('08:05'), SCREEN)).toBe('morning');
    expect(periodAt(at('11:30'), SCREEN)).toBe('afternoon');
    expect(periodAt(at('02:00'), SCREEN)).toBe('evening');
    expect(periodEndsAt(at('08:05'), SCREEN)).toBe(at('11:30').getTime());
    expect(periodEndsAt(at('19:00'), SCREEN)).toBe(at('05:00', '2026-11-21').getTime());
  });
  it('이름 부르기와 인사', () => {
    expect(callName('서윤')).toBe('서윤이');
    expect(callName('하루')).toBe('하루');
    expect(greeting('morning', ['서윤', '하루'])).toBe('좋은 아침이에요, 서윤이·하루');
  });
  it('등하원 카드: 아침 출발 전 → 하원까지 → 하원 확인', () => {
    const today = [plan('2026-11-20')];
    const tomorrow = [plan('2026-11-21')];
    expect(commuteView('morning', at('08:05'), today, tomorrow, false, '엄마')).toMatchObject({ kind: 'countdown', label: '등원 출발까지', value: '25분', pill: '08:30 출발' });
    expect(commuteView('afternoon', at('15:10'), today, tomorrow, false, '엄마')).toMatchObject({ kind: 'countdown', label: '하원까지', value: '1시간 20분', sub: '픽업 · 엄마' });
    expect(commuteView('afternoon', at('17:00'), today, tomorrow, false, '엄마')).toMatchObject({ kind: 'done', title: '하원 확인 필요' });
    expect(commuteView('afternoon', at('17:00'), today, tomorrow, true, '엄마')).toMatchObject({ kind: 'done', title: '하원 완료' });
    expect(commuteView('evening', at('20:30'), today, tomorrow, true, '엄마')).toMatchObject({ kind: 'clock', value: '08:30', sub: '내일 하원 16:30 · 엄마' });
    expect(commuteView('evening', at('21:00'), today, tomorrow, true, '엄마')).toMatchObject({ sub: '출발까지 11시간 30분 · 내일 하원 16:30 · 엄마' });
  });
  it('휴원·변경·설정 없음', () => {
    expect(commuteView('morning', at('08:05'), [], [], false, null)).toEqual({ kind: 'empty' });
    expect(commuteView('morning', at('08:05'), [plan('2026-11-20', { attends: false, closed: true, closedNote: '개원기념일' })], [], false, null))
      .toMatchObject({ kind: 'off', title: '오늘은 쉬는 날이에요', note: '개원기념일' });
    const changed = plan('2026-11-20', { pickupAt: '13:00', needsReview: true, changes: [{ kind: 'pickup_time', time: '13:00', note: '조기 하원', needsReview: true, noticeId: 'n1' }] });
    expect(commuteView('afternoon', at('12:00'), [changed], [], false, '엄마')).toMatchObject({ value: '1시간', needsReview: true, changeNote: '하원 시간이 바뀌었어요 · 13:00 (확인 필요)' });
  });
  it('날씨 문구', () => {
    expect(weatherPhrase('맑음', 3)).toBe('맑고 쌀쌀해요');
    expect(weatherPhrase('비', 4)).toBe('비가 오고 쌀쌀해요');
    expect(weatherPhrase('눈', -2)).toBe('눈이 오고 추워요');
    expect(weatherPhrase(null, 3)).toBe('날씨 정보 없음');
  });
});

describe('등원 없는 날의 다음 등원', () => {
  it('날짜를 내일·모레·요일·날짜로 부른다', () => {
    expect(nextDayLabel('2026-11-22', '2026-11-21')).toBe('내일');
    expect(nextDayLabel('2026-11-23', '2026-11-21')).toBe('모레(월요일)');
    expect(nextDayLabel('2026-11-25', '2026-11-21')).toBe('수요일');
    expect(nextDayLabel('2026-12-01', '2026-11-21')).toBe('12월 1일 화요일');
  });
  it('오늘 쉬면 오늘 다음, 저녁에는 내일 다음 등원을 보여 준다', () => {
    const sat = [plan('2026-11-21', { attends: false })];
    const sun = [plan('2026-11-22', { attends: false })];
    const mon = { date: '2026-11-23', leaveHomeAt: '08:30', arriveBy: '09:00', needsReview: false };
    const morning = commuteView('morning', at('09:00', '2026-11-21'), sat, sun, false, null, { afterToday: mon, afterTomorrow: mon, base: '2026-11-21' });
    expect(morning).toMatchObject({ kind: 'off', title: '오늘은 등원하지 않아요', next: { when: '모레(월요일)', time: '08:30' } });
    const evening = commuteView('evening', at('20:00', '2026-11-21'), sat, sun, false, null, { afterToday: mon, afterTomorrow: mon, base: '2026-11-21' });
    expect(evening).toMatchObject({ kind: 'off', title: '내일은 등원하지 않아요', next: { when: '모레(월요일)' } });
    expect(commuteView('morning', at('09:00', '2026-11-21'), sat, sun, false, null)).toMatchObject({ kind: 'off', next: null });
  });
});

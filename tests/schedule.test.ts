import { describe, expect, it } from 'vitest';
import { countdownKo, eventTimeOn, findNextEvent, pickVisibleEvents, sortEvents, sortTasks, tasksForToday } from '../src/domain/schedule';

const tz = 'Asia/Seoul';
const at = (hm: string, date = '2026-11-20') => new Date(`${date}T${hm}:00+09:00`).toISOString();
const ev = (id: string, start: string | null, end: string | null, allDay = false) => ({ id, allDay, startsAt: start, endsAt: end, startDate: allDay ? '2026-11-20' : null });

describe('오늘 일정 선택', () => {
  it('지난 일정이 많아도 다음 일정이 보이고, 종일 일정은 "다음"이 되지 않는다', () => {
    const now = new Date(at('15:00'));
    const list = sortEvents([
      ev('a', at('08:00'), at('09:00')),
      ev('b', at('09:00'), at('10:00')),
      ev('c', at('10:00'), at('11:00')),
      ev('d', at('11:00'), at('12:00')),
      ev('e', at('13:00'), at('14:00')),
      ev('next', at('16:00'), at('17:00')),
      ev('all', null, null, true),
    ]);
    expect(list[0]?.id).toBe('all');
    const next = findNextEvent(list, now);
    expect(next?.id).toBe('next');
    const visible = pickVisibleEvents(list, next, 4).map((e) => e.id);
    expect(visible).toContain('next');
    expect(visible).toHaveLength(4);
  });

  it('카운트다운은 올림, 전날부터 이어지는 일정은 "이어서"', () => {
    const now = new Date(at('15:59'));
    expect(countdownKo(at('16:00'), new Date(new Date(at('16:00')).getTime() - 29_000))).toBe('1분 후');
    expect(countdownKo(at('16:00'), now)).toBe('1분 후');
    expect(eventTimeOn(ev('x', at('23:00', '2026-11-19'), at('01:00')), '2026-11-20', tz).time).toBe('이어서');
  });
});

describe('할 일 정렬', () => {
  const t = (id: string, completedAt: string | null, dueAt: string | null, createdAt: string) => ({ id, completedAt, dueAt, createdAt });
  it('미완료 → 기한 빠른 순 → 오래된 순, 예전에 끝낸 일은 오늘 목록에서 빠진다', () => {
    const list = [
      t('done-today', at('09:00'), null, '2026-11-01'),
      t('done-old', at('09:00', '2026-11-10'), null, '2026-11-01'),
      t('no-due-old', null, null, '2026-11-01'),
      t('due-soon', null, at('18:00'), '2026-11-19'),
    ];
    expect(sortTasks(tasksForToday(list, '2026-11-20', tz)).map((x) => x.id)).toEqual(['due-soon', 'no-due-old', 'done-today']);
  });
});

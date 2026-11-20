import { describe, expect, it, vi } from 'vitest';
import { syncNoticeCalendar, toNewEvent } from '../src/pages/notices/calendarLink';
import type { CalendarEvent } from '../src/domain/types';
import type { FullRepository } from '../src/repo/repository';
import type { NoticeEventRow, V2 } from '../src/server/v2';

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

function row(p: Partial<NoticeEventRow> = {}): NoticeEventRow {
  return { id: 'nev1', noticeId: 'n1', date: today, endDate: null, time: null, title: '숲 체험', kind: 'event', needsReview: false, calendarEventId: null, calendarSnapshot: null, ...p };
}

function cal(p: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'cal1', familyId: 'f', createdBy: 'u', title: '숲 체험', allDay: true, startDate: today, endDate: today, startsAt: null, endsAt: null,
    visibility: 'family', note: '공지에서 가져온 일정', version: 3, createdAt: '', updatedAt: '', ...p };
}

function setup(events: NoticeEventRow[], calendar: CalendarEvent[]) {
  const link = vi.fn().mockResolvedValue({});
  const v2 = { noticeEvents: vi.fn().mockResolvedValue({ events }), linkNoticeEvent: link } as unknown as V2;
  const repo = {
    getEvents: vi.fn().mockResolvedValue(calendar),
    createEvent: vi.fn().mockImplementation(async (input) => cal({ ...input, id: 'cal-new' })),
    updateEvent: vi.fn().mockResolvedValue(cal()),
  } as unknown as FullRepository & { createEvent: ReturnType<typeof vi.fn>; updateEvent: ReturnType<typeof vi.fn> };
  return { v2, repo, link };
}

describe('공지 행사 ↔ 캘린더', () => {
  it('확인하면 연결 안 된 행사를 만들고 연결한다(같은 행사는 같은 중복 방지 키)', async () => {
    const { v2, repo, link } = setup([row()], []);
    const r = await syncNoticeCalendar(v2, repo, 'n1', true);
    expect(r.created).toBe(1);
    expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({ title: '숲 체험', allDay: true, visibility: 'family' }), expect.stringMatching(/^[0-9a-f-]{36}$/));
    const key1 = (repo.createEvent as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    await syncNoticeCalendar(setup([row()], []).v2, repo, 'n1', true);
    expect((repo.createEvent as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toBe(key1);
    expect(link).toHaveBeenCalledWith('nev1', 'cal-new', { title: '숲 체험', date: today, endDate: null, time: null });
  });

  it('확인 전(확인 필요) 행사는 캘린더에 넣지 않는다', async () => {
    const { v2, repo } = setup([row({ needsReview: true })], []);
    expect((await syncNoticeCalendar(v2, repo, 'n1', true)).created).toBe(0);
    expect(repo.createEvent).not.toHaveBeenCalled();
  });

  it('공지가 바뀌면 보호자가 손대지 않은 캘린더 일정을 고친다', async () => {
    const old = { title: '숲 체험', date: today, endDate: null, time: null };
    const { v2, repo } = setup([row({ title: '숲 체험(우천 시 실내)', time: '10:00', calendarEventId: 'cal1', calendarSnapshot: old })], [cal()]);
    const r = await syncNoticeCalendar(v2, repo, 'n1', false);
    expect(r.updated).toBe(1);
    expect(repo.updateEvent).toHaveBeenCalledWith('cal1', 3, expect.objectContaining({ title: '숲 체험(우천 시 실내)', allDay: false }));
  });

  it('보호자가 캘린더에서 직접 고친 일정은 덮어쓰지 않는다', async () => {
    const old = { title: '숲 체험', date: today, endDate: null, time: null };
    const { v2, repo } = setup([row({ title: '숲 체험 변경', calendarEventId: 'cal1', calendarSnapshot: old })], [cal({ title: '숲 체험 - 아빠가 데려감' })]);
    const r = await syncNoticeCalendar(v2, repo, 'n1', false);
    expect(r).toMatchObject({ updated: 0, keptUserEdits: 1 });
    expect(repo.updateEvent).not.toHaveBeenCalled();
  });

  it('캘린더에서 지운 일정은 다시 만들지 않고 연결만 끊는다', async () => {
    const { v2, repo, link } = setup([row({ calendarEventId: 'gone', calendarSnapshot: { title: '숲 체험', date: today, endDate: null, time: null } })], []);
    await syncNoticeCalendar(v2, repo, 'n1', false);
    expect(repo.createEvent).not.toHaveBeenCalled();
    expect(link).toHaveBeenCalledWith('nev1', null);
  });

  it('시각이 있으면 한 시간짜리 시간 일정으로 만든다', () => {
    const e = toNewEvent({ title: '참관 수업', date: '2026-11-21', endDate: null, time: '10:30' });
    expect(e).toMatchObject({ allDay: false, startsAt: '2026-11-21T01:30:00.000Z', endsAt: '2026-11-21T02:30:00.000Z' });
  });
});

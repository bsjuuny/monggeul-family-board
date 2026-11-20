// 공지에서 뽑은 행사 ↔ 가족 캘린더 연결.
// - 보호자가 공지를 확인(승인)하면 연결 안 된 행사를 캘린더에 만든다(날짜 범위 제한 없이 공지의 행사 전체).
// - 공지가 바뀌면 연결된 캘린더 일정도 고친다(행사 날짜를 바꿔도 같은 연결을 유지).
// - 보호자가 캘린더에서 직접 고친 일정은 덮어쓰지 않는다. 캘린더에서 지운 일정은 다시 만들지 않고 연결만 끊는다.
// - 공지에서 행사가 빠지거나 공지를 지우면, 보호자가 고치지 않은 연결 일정만 캘린더에서도 지운다.
import { zonedToIso } from '../../domain/dates';
import type { CalendarEvent, NewEvent } from '../../domain/types';
import type { FullRepository } from '../../repo/repository';
import type { NoticeEventRow, V2 } from '../../server/v2';
import { sha256Hex } from '../../notices/sha256';

const TZ = 'Asia/Seoul';
type Snap = NonNullable<NoticeEventRow['calendarSnapshot']>;

/** 같은 행사·같은 내용은 같은 중복 방지 키(UUID 형식): 두 번 눌러도 일정이 하나만 생기고, 내용이 바뀌면 새 키 */
function stableUuid(seed: string): string {
  const h = sha256Hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function toNewEvent(ev: Pick<NoticeEventRow, 'title' | 'date' | 'endDate' | 'time'>): NewEvent {
  const note = '공지에서 가져온 일정';
  if (!ev.time) return { title: ev.title, allDay: true, startDate: ev.date, endDate: ev.endDate ?? ev.date, visibility: 'family', note };
  const startsAt = zonedToIso(ev.date, ev.time, TZ);
  return { title: ev.title, allDay: false, startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(), visibility: 'family', note };
}

/** 끝 날짜가 시작일과 같으면 하루짜리로 보고 비운다(캘린더는 하루 종일 일정의 끝 날짜를 시작일로 저장한다) */
const oneDay = (date: string, end: string | null | undefined) => (end && end !== date ? end : null);
const snapOf = (ev: Pick<NoticeEventRow, 'title' | 'date' | 'endDate' | 'time'>): Snap => ({ title: ev.title, date: ev.date, endDate: oneDay(ev.date, ev.endDate), time: ev.time });
const same = (a: Snap, b: Snap) => a.title === b.title && a.date === b.date && oneDay(a.date, a.endDate) === oneDay(b.date, b.endDate) && (a.time ?? null) === (b.time ?? null);

function calSnap(e: CalendarEvent): Snap {
  if (e.allDay) return { title: e.title, date: e.startDate ?? '', endDate: oneDay(e.startDate ?? '', e.endDate), time: null };
  const d = new Date(Date.parse(e.startsAt ?? '') + 9 * 3600_000).toISOString();
  return { title: e.title, date: d.slice(0, 10), endDate: null, time: d.slice(11, 16) };
}

export interface LinkResult {
  created: number;
  updated: number;
  removed: number;
  keptUserEdits: number;
}

/** 한 공지의 행사들을 캘린더와 맞춘다. createMissing=false 이면 새로 만들지 않고 갱신·정리만 한다. */
export async function syncNoticeCalendar(v2: V2, repo: FullRepository, noticeId: string, createMissing: boolean): Promise<LinkResult> {
  const res: LinkResult = { created: 0, updated: 0, removed: 0, keptUserEdits: 0 };
  const { events } = await v2.noticeEventsOf(noticeId);
  if (!events.length) return res;
  const cal = await repo.getEvents({ from: '2000-01-01', to: '2100-12-31' });
  for (const ev of events) {
    const want = snapOf(ev);
    const linked = ev.calendarEventId ? cal.find((c) => c.id === ev.calendarEventId) : undefined;
    const userEdited = Boolean(linked && ev.calendarSnapshot && !same(calSnap(linked), ev.calendarSnapshot));
    if (ev.deleted) {
      if (!ev.calendarEventId) continue;
      if (linked && !userEdited) {
        await repo.deleteEvent(linked.id, linked.version);
        res.removed++;
      } else if (userEdited) {
        res.keptUserEdits++;
      }
      await v2.linkNoticeEvent(ev.id, null);
      continue;
    }
    if (ev.needsReview) continue; // 확인 전 행사는 캘린더에 넣지 않는다
    if (!linked) {
      if (ev.calendarEventId) {
        await v2.linkNoticeEvent(ev.id, null); // 캘린더에서 지운 일정: 되살리지 않는다
        continue;
      }
      if (!createMissing) continue;
      const created = await repo.createEvent(toNewEvent(ev), stableUuid(`notice-ev-${ev.id}-${JSON.stringify(want)}`));
      await v2.linkNoticeEvent(ev.id, created.id, want);
      res.created++;
      continue;
    }
    if (!ev.calendarSnapshot || same(ev.calendarSnapshot, want)) continue; // 바뀐 것 없음
    if (userEdited) {
      res.keptUserEdits++; // 보호자가 캘린더에서 고친 일정
      continue;
    }
    const n = toNewEvent(ev);
    await repo.updateEvent(linked.id, linked.version, n.allDay
      ? { title: n.title, allDay: true, startDate: n.startDate, endDate: n.endDate, startsAt: null, endsAt: null }
      : { title: n.title, allDay: false, startsAt: n.startsAt, endsAt: n.endsAt, startDate: null, endDate: null });
    await v2.linkNoticeEvent(ev.id, linked.id, want);
    res.updated++;
  }
  return res;
}

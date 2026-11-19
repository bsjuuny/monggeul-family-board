import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { friendlyMessage, isFamilyBoardError } from '../domain/errors';
import {
  addDays,
  addMonths,
  compareDates,
  eventCoversDate,
  formatKoreanDate,
  formatKoreanMonth,
  formatTimeRangeKo,
  isoToZoned,
  monthGrid,
  startOfMonth,
  todayIn,
  weekDays,
  weekdayKo,
  zonedToIso,
} from '../domain/dates';
import type { CalendarEvent, NewEvent, Visibility } from '../domain/types';
import { validateEventInput } from '../domain/validation';
import { newId } from '../lib/crypto';
import { dkey, useOnline, usePageTitle, useServices, useSession } from '../app/context';
import { useEvents } from '../app/queries';
import { ConfirmDialog } from '../ui/Confirm';
import { Modal } from '../ui/Modal';
import { EmptyBlock, OfflineReason, QueryView } from '../ui/States';
import { useToast } from '../ui/Toasts';

type View = 'month' | 'week';
type Filter = 'all' | Visibility;

const FIELD_LABEL: Record<string, string> = {
  title: '제목',
  allDay: '종일',
  startDate: '시작 날짜',
  endDate: '종료 날짜',
  startsAt: '시작 시각',
  endsAt: '종료 시각',
  visibility: '공개 범위',
  note: '메모',
};

function show(ev: CalendarEvent, key: string, tz: string): string {
  switch (key) {
    case 'allDay':
      return ev.allDay ? '종일' : '시간 지정';
    case 'visibility':
      return ev.visibility === 'private' ? '나만 보기' : '가족 공개';
    case 'startsAt':
    case 'endsAt': {
      const v = ev[key];
      if (!v) return '-';
      const z = isoToZoned(v, tz);
      return `${z.date} ${z.time}`;
    }
    default:
      return String((ev as unknown as Record<string, unknown>)[key] ?? '') || '-';
  }
}

/** 409 비교 화면: 내가 저장하려던 값과 서버의 최신 값을 나란히 보여 준다 */
function ConflictCompare({ mine, latest, tz, onReload }: { mine: NewEvent; latest: CalendarEvent; tz: string; onReload: () => void }) {
  const mineAsEvent = { ...latest, ...mine } as CalendarEvent;
  const keys = Object.keys(FIELD_LABEL).filter((k) => show(mineAsEvent, k, tz) !== show(latest, k, tz));
  return (
    <div className="warnbox" role="alert" data-testid="conflict">
      <strong>다른 사람이 먼저 수정했어요.</strong> 내 변경과 최신 내용을 비교해 보세요.
      <div className="compare">
        <dl>
          <h3>내가 저장하려던 내용</h3>
          {keys.map((k) => (
            <div key={k}>
              <dt>{FIELD_LABEL[k]}</dt>
              <dd className="diff">{show(mineAsEvent, k, tz)}</dd>
            </div>
          ))}
        </dl>
        <dl>
          <h3>지금 저장된 최신 내용</h3>
          {keys.map((k) => (
            <div key={k}>
              <dt>{FIELD_LABEL[k]}</dt>
              <dd className="diff">{show(latest, k, tz)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <button type="button" className="btn secondary" onClick={onReload}>
        최신 내용으로 다시 열기
      </button>
    </div>
  );
}

export function EventForm({ initial, date, onClose, onSaved }: { initial?: CalendarEvent; date: string; onClose: () => void; onSaved?: () => void }) {
  const { repo } = useServices();
  const { ns, tz, userId } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const init = initial
    ? initial.allDay
      ? { sd: initial.startDate ?? date, ed: initial.endDate ?? date, st: '09:00', et: '10:00' }
      : {
          sd: isoToZoned(initial.startsAt as string, tz).date,
          ed: isoToZoned(initial.endsAt as string, tz).date,
          st: isoToZoned(initial.startsAt as string, tz).time,
          et: isoToZoned(initial.endsAt as string, tz).time,
        }
    : { sd: date, ed: date, st: '09:00', et: '10:00' };
  const [current, setCurrent] = useState<CalendarEvent | undefined>(initial);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [allDay, setAllDay] = useState(initial?.allDay ?? true);
  const [sd, setSd] = useState(init.sd);
  const [ed, setEd] = useState(init.ed);
  const [st, setSt] = useState(init.st);
  const [et, setEt] = useState(init.et);
  const [visibility, setVisibility] = useState<Visibility>(initial?.visibility ?? 'family');
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [conflict, setConflict] = useState<{ mine: NewEvent; latest: CalendarEvent } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const inFlight = useRef(false);
  const key = useRef(newId());
  const canEditVisibility = !initial || initial.createdBy === userId;
  const readOnly = Boolean(initial) && initial?.visibility === 'private' && initial.createdBy !== userId;

  function build(): NewEvent {
    return allDay
      ? { title, allDay: true, startDate: sd, endDate: ed, visibility, note: note || null }
      : { title, allDay: false, startsAt: sd && st ? zonedToIso(sd, st, tz) : null, endsAt: ed && et ? zonedToIso(ed, et, tz) : null, visibility, note: note || null };
  }

  async function refreshAll() {
    await qc.invalidateQueries({ queryKey: dkey(ns, 'events') });
    onSaved?.();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    let input: NewEvent;
    try {
      input = build();
      validateEventInput(input);
    } catch (err) {
      setError({ field: isFamilyBoardError(err) ? (err.details.field as string | undefined) : undefined, message: friendlyMessage(err) });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      if (current) await repo.updateEvent(current.id, current.version, input);
      else await repo.createEvent(input, key.current);
      await refreshAll();
      toast.info(current ? '일정을 수정했어요.' : '일정을 추가했어요.');
      onClose();
    } catch (err) {
      if (isFamilyBoardError(err) && err.code === 'VERSION_CONFLICT' && err.details.latest) {
        setConflict({ mine: input, latest: err.details.latest as CalendarEvent });
        await refreshAll();
      } else {
        setError({ field: isFamilyBoardError(err) ? (err.details.field as string | undefined) : undefined, message: friendlyMessage(err) });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await repo.deleteEvent(current.id, current.version);
      await refreshAll();
      toast.info('일정을 삭제했어요.');
      onClose();
    } catch (err) {
      setConfirmDel(false);
      if (isFamilyBoardError(err) && err.code === 'VERSION_CONFLICT' && err.details.latest) {
        setConflict({ mine: build(), latest: err.details.latest as CalendarEvent });
        await refreshAll();
      } else setError({ message: friendlyMessage(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function reloadLatest() {
    if (!conflict) return;
    const l = conflict.latest;
    setCurrent(l);
    setTitle(l.title);
    setAllDay(l.allDay);
    if (l.allDay) {
      setSd(l.startDate ?? sd);
      setEd(l.endDate ?? ed);
    } else if (l.startsAt && l.endsAt) {
      const a = isoToZoned(l.startsAt, tz);
      const b = isoToZoned(l.endsAt, tz);
      setSd(a.date);
      setSt(a.time);
      setEd(b.date);
      setEt(b.time);
    }
    setVisibility(l.visibility);
    setNote(l.note ?? '');
    setConflict(null);
  }

  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  const gen = error && !error.field ? error.message : undefined;
  const dis = busy || readOnly;
  return (
    <Modal title={initial ? '일정 수정' : '일정 추가'} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="ev-title">제목 (1~120자)</label>
          <input id="ev-title" data-autofocus type="text" maxLength={120} value={title} disabled={dis} onChange={(e) => setTitle(e.target.value)} aria-invalid={fe('title') ? true : undefined} />
          {fe('title') && <span className="err">{fe('title')}</span>}
        </div>
        <label className="check">
          <input type="checkbox" checked={allDay} disabled={dis} onChange={(e) => setAllDay(e.target.checked)} />
          종일
        </label>
        <div className="row2">
          <div className="field">
            <label htmlFor="ev-sd">시작 날짜</label>
            <input id="ev-sd" type="date" value={sd} disabled={dis} onChange={(e) => setSd(e.target.value)} aria-invalid={fe('startDate') ? true : undefined} />
            {fe('startDate') && <span className="err">{fe('startDate')}</span>}
          </div>
          <div className="field">
            <label htmlFor="ev-ed">종료 날짜</label>
            <input id="ev-ed" type="date" value={ed} disabled={dis} onChange={(e) => setEd(e.target.value)} aria-invalid={fe('endDate') ? true : undefined} />
            {fe('endDate') && <span className="err">{fe('endDate')}</span>}
          </div>
        </div>
        {!allDay && (
          <div className="row2">
            <div className="field">
              <label htmlFor="ev-st">시작 시각</label>
              <input id="ev-st" type="time" value={st} disabled={dis} onChange={(e) => setSt(e.target.value)} aria-invalid={fe('startsAt') ? true : undefined} />
              {fe('startsAt') && <span className="err">{fe('startsAt')}</span>}
            </div>
            <div className="field">
              <label htmlFor="ev-et">종료 시각</label>
              <input id="ev-et" type="time" value={et} disabled={dis} onChange={(e) => setEt(e.target.value)} aria-invalid={fe('endsAt') ? true : undefined} />
              {fe('endsAt') && <span className="err">{fe('endsAt')}</span>}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="ev-vis">공개 범위</label>
          <select id="ev-vis" value={visibility} disabled={dis || !canEditVisibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
            <option value="family">가족 공개</option>
            <option value="private">나만 보기</option>
          </select>
          {visibility === 'private' && <span className="hint">TV 화면과 다른 가족에게는 보이지 않아요.</span>}
        </div>
        <div className="field">
          <label htmlFor="ev-note">메모 (선택, 500자)</label>
          <textarea id="ev-note" maxLength={500} value={note} disabled={dis} onChange={(e) => setNote(e.target.value)} aria-invalid={fe('note') ? true : undefined} />
          {fe('note') && <span className="err">{fe('note')}</span>}
        </div>
        {conflict && <ConflictCompare mine={conflict.mine} latest={conflict.latest} tz={tz} onReload={reloadLatest} />}
        {gen && (
          <p className="err" role="alert" style={{ color: 'var(--bad)', fontWeight: 600 }}>
            {gen}
          </p>
        )}
        <OfflineReason show={!online}>오프라인에서는 일정을 저장할 수 없어요. 연결된 뒤에 다시 시도해 주세요.</OfflineReason>
        <div className="btn-row">
          <button type="submit" className="btn" disabled={busy || !online || readOnly}>
            {busy ? '저장 중…' : '저장'}
          </button>
          {current && (
            <button type="button" className="btn danger" onClick={() => setConfirmDel(true)} disabled={busy || !online || readOnly}>
              삭제
            </button>
          )}
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
        </div>
      </form>
      {confirmDel && current && (
        <ConfirmDialog title="일정을 삭제할까요?" message={`"${current.title}" 일정을 삭제해요. 되돌릴 수 없어요.`} confirmLabel="삭제" danger busy={busy} onConfirm={() => void doDelete()} onClose={() => setConfirmDel(false)} />
      )}
    </Modal>
  );
}

function EventItem({ ev, tz, onOpen }: { ev: CalendarEvent; tz: string; onOpen: (e: CalendarEvent) => void }) {
  return (
    <button type="button" className={`evitem ${ev.visibility === 'private' ? 'private' : ''}`} onClick={() => onOpen(ev)} data-testid="event-item">
      <span className="t">
        {ev.visibility === 'private' && <span aria-label="나만 보기">🔒 </span>}
        {ev.title}
      </span>
      <span className="m">{formatTimeRangeKo(ev, tz)}</span>
    </button>
  );
}

export function CalendarPage() {
  usePageTitle('캘린더');
  const { tz } = useSession();
  const online = useOnline();
  const today = todayIn(tz);
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [filter, setFilter] = useState<Filter>('all');
  const [form, setForm] = useState<{ ev?: CalendarEvent } | null>(null);

  const cells = view === 'month' ? monthGrid(anchor) : weekDays(anchor);
  const from = cells[0] as string;
  const to = cells[cells.length - 1] as string;
  const q = useEvents(from, to);
  const evsOn = (list: CalendarEvent[], d: string) => list.filter((e) => (filter === 'all' || e.visibility === filter) && eventCoversDate(e, d, tz));

  function move(n: number) {
    const next = view === 'month' ? addMonths(anchor, n) : addDays(anchor, 7 * n);
    setAnchor(next);
    setSelected(view === 'month' ? startOfMonth(next) : next);
  }

  const heading = view === 'month' ? formatKoreanMonth(anchor) : `${formatKoreanDate(from)} – ${formatKoreanDate(to)}`;

  return (
    <div className="stack">
      <div className="cal-head">
        <h1 className="title" style={{ marginBottom: 0 }}>
          캘린더
        </h1>
        <button type="button" className="btn" onClick={() => setForm({})} disabled={!online}>
          ＋ 일정 추가
        </button>
      </div>
      <OfflineReason show={!online}>오프라인이에요. 일정은 마지막으로 불러온 내용만 볼 수 있고, 추가·수정은 연결 후에 할 수 있어요.</OfflineReason>
      <div className="cal-head">
        <button type="button" className="btn secondary small" onClick={() => move(-1)} aria-label={view === 'month' ? '이전 달' : '이전 주'}>
          ◀
        </button>
        <strong aria-live="polite" data-testid="cal-heading" style={{ minWidth: 120, textAlign: 'center' }}>
          {heading}
        </strong>
        <button type="button" className="btn secondary small" onClick={() => move(1)} aria-label={view === 'month' ? '다음 달' : '다음 주'}>
          ▶
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            setAnchor(today);
            setSelected(today);
          }}
        >
          오늘
        </button>
        <div className="seg" role="group" aria-label="보기 방식" style={{ marginLeft: 'auto' }}>
          <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>
            월
          </button>
          <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>
            주
          </button>
        </div>
        <div className="seg" role="group" aria-label="공개 범위 필터">
          {(
            [
              ['all', '전체'],
              ['family', '가족'],
              ['private', '나만'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <QueryView q={q} rows={5}>
        {(list) => (
          <>
            {view === 'month' ? (
              <div className="month" role="group" aria-label={heading}>
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="dow" aria-hidden="true">
                    {weekdayKo(addDays('2026-11-15', i))}
                  </div>
                ))}
                {cells.map((d) => {
                  const day = evsOn(list, d);
                  const other = d.slice(0, 7) !== anchor.slice(0, 7);
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`day ${other ? 'other' : ''} ${d === today ? 'today' : ''}`}
                      aria-pressed={d === selected}
                      aria-label={`${formatKoreanDate(d)}${day.length ? `, 일정 ${day.length}건` : ''}`}
                      onClick={() => setSelected(d)}
                    >
                      <span className="num">{Number(d.slice(8))}</span>
                      {day.slice(0, 2).map((e) => (
                        <span key={e.id} className={`ev ${e.visibility === 'private' ? 'private' : ''}`}>
                          {e.title}
                        </span>
                      ))}
                      {day.length > 0 && (
                        <span className="dots" aria-hidden="true">
                          {day.slice(0, 4).map((e) => (
                            <b key={e.id} />
                          ))}
                        </span>
                      )}
                      {day.length > 2 && <span className="more">+{day.length - 2}</span>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="week">
                {cells.map((d) => (
                  <div key={d} className={`col ${d === today ? 'today' : ''}`}>
                    <h3>{formatKoreanDate(d)}</h3>
                    {evsOn(list, d).length === 0 && <p className="muted">일정 없음</p>}
                    {evsOn(list, d).map((e) => (
                      <EventItem key={e.id} ev={e} tz={tz} onOpen={(x) => setForm({ ev: x })} />
                    ))}
                  </div>
                ))}
              </div>
            )}
            <section className="card" aria-label={`${formatKoreanDate(selected)} 일정`}>
              <h2>{formatKoreanDate(selected)}</h2>
              {evsOn(list, selected).length === 0 ? (
                <EmptyBlock icon="🗓️" title="이 날은 일정이 없어요" hint="＋ 일정 추가로 새 일정을 만들어 보세요." />
              ) : (
                evsOn(list, selected).map((e) => <EventItem key={e.id} ev={e} tz={tz} onOpen={(x) => setForm({ ev: x })} />)
              )}
            </section>
          </>
        )}
      </QueryView>
      {form && <EventForm initial={form.ev} date={compareDates(selected, from) >= 0 ? selected : from} onClose={() => setForm(null)} />}
    </div>
  );
}

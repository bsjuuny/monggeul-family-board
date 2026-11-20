import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import {
  addDays,
  eventCoversDate,
  formatKoreanDate,

  todayIn,
  weekdayKo,
  weekdayOf,
} from '../domain/dates';
import type { CalendarEvent, ChildProfile, HabitWithRecord, Task } from '../domain/types';
import { dkey, useNow, usePageTitle, useServices, useSession } from '../app/context';
import { useEvents, useMembers, useTasks } from '../app/queries';
import { QueryView, avatarNameOf, avatarOf, habitIconOf } from '../ui/States';
import { countdownKo, eventTimeOn, findNextEvent, isEventPast, pickVisibleEvents, sortEvents, sortTasks, tasksForToday } from '../domain/schedule';
import { habitDone } from './Kids';
import { TaskRow } from './Tasks';

function mondayOf(date: string) {
  const day = weekdayOf(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

function WeekRibbon({ today, events, tz }: { today: string; events: CalendarEvent[]; tz: string }) {
  const start = mondayOf(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <section className="week-ribbon" aria-label="이번 주">
      <div className="week-ribbon-head">
        <strong>{Number(start.slice(5, 7))}월 {Number(start.slice(8))}–{Number(days[6]?.slice(8))}일</strong>
        <span>이번 주</span>
      </div>
      <div className="week-days">
        {days.map((date) => {
          const count = events.filter((event) => eventCoversDate(event, date, tz)).length;
          return (
            <Link key={date} to="/calendar" className={`week-day${date === today ? ' is-today' : ''}${weekdayOf(date) === 0 ? ' is-sunday' : ''}`} aria-label={`${formatKoreanDate(date)}${count ? ` 일정 ${count}건` : ''}`}>
              <span>{weekdayKo(date)}</span><strong>{Number(date.slice(8))}</strong>
              {date === today ? <small>오늘</small> : count > 0 ? <i aria-hidden="true" /> : null}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function HomeTimeline({ events, tomorrowEvents, today, tz, now }: { events: CalendarEvent[]; tomorrowEvents: CalendarEvent[]; today: string; tz: string; now: Date }) {
  const ordered = sortEvents(events);
  const next = findNextEvent(ordered, now);
  const visible = pickVisibleEvents(ordered, next, 4);
  const hidden = ordered.length - visible.length;
  if (ordered.length === 0) {
    return (
      <section className="timeline-card timeline-empty card" aria-labelledby="home-events">
        <div className="section-heading"><div><span className="eyebrow">오늘 일정 0</span><h2 id="home-events">오늘은 가족 마음대로</h2></div></div>
        <div className="empty-day-hero" aria-hidden="true">{avatarOf('monggeul', 'sleepy')}</div>
        <p>정해진 일정도, 급한 약속도 없어요.<br />몽글이처럼 잠깐 쉬어 가도 좋아요.</p>
        <div className="relaxed-ideas" aria-label="느긋한 하루 아이디어">
          <span>📚 그림책 한 권</span><span>🌤 집 앞 산책</span><span>🎵 가족 노래</span>
        </div>
        <Link className="tomorrow-preview empty-tomorrow" to="/calendar"><small>내일 미리보기</small><strong>{tomorrowEvents[0]?.title ?? '내일도 아직 여유로워요'}</strong><span>{tomorrowEvents[0] ? eventTimeOn(tomorrowEvents[0], addDays(today, 1), tz).time : '천천히'}</span></Link>
      </section>
    );
  }
  return (
    <section className="timeline-card card" aria-labelledby="home-events">
      <div className="section-heading"><h2 id="home-events">오늘 타임라인</h2><span className="count-chip">일정 {ordered.length}</span></div>
      <ol className="timeline-list" aria-label="오늘 일정 목록">
        {visible.map((event) => {
          const past = isEventPast(event, now);
          const isNext = next?.id === event.id;
          const time = eventTimeOn(event, today, tz);
          return (
            <li key={event.id} data-testid="home-event" className={`timeline-item${past ? ' is-past' : ''}${isNext ? ' is-next' : ''}`}>
              <time>{time.time}<small>{time.ampm}</small></time><i className="timeline-dot" aria-hidden="true" />
              <div className="timeline-event">
                <span className="event-status">{past ? '지난 일정' : isNext ? '다음' : event.allDay ? '오늘' : '예정'}</span>
                <h3>{event.visibility === 'private' && <span aria-label="나만 보기">🔒 </span>}{event.title}</h3>
                {event.note && <p>{event.note}</p>}
                {isNext && <strong className="countdown">{countdownKo(event.startsAt, now)}</strong>}
              </div>
            </li>
          );
        })}
      </ol>
      {hidden > 0 && <Link className="more-link" to="/calendar">+{hidden}개 일정 더 보기</Link>}
      <div className="tomorrow-block">
        <div><span className="eyebrow">내일 미리보기 · {Number(addDays(today, 1).slice(5, 7))}월 {Number(addDays(today, 1).slice(8))}일</span><strong>{tomorrowEvents.length ? '내일도 가볍게 준비해요' : '내일은 아직 여유로워요'}</strong></div>
        {sortEvents(tomorrowEvents).slice(0, 2).map((event) => <Link className="tomorrow-row" to="/calendar" key={event.id}><b>{eventTimeOn(event, addDays(today, 1), tz).time}</b><span>{event.title}</span></Link>)}
      </div>
    </section>
  );
}

function HomeTaskList({ list }: { list: Task[] }) {
  const visible = sortTasks(list).slice(0, 5);
  if (!visible.length) return <div className="compact-empty"><span aria-hidden="true">✓</span><strong>오늘 할 일은 비어 있어요</strong><Link className="btn small" to="/tasks">첫 할 일 추가</Link></div>;
  return <ul className="list home-task-list" aria-label="남은 할 일 목록">{visible.map((task) => <TaskRow key={task.id} task={task} compact />)}</ul>;
}

function HomeKids({ children, date }: { children: ChildProfile[]; date: string }) {
  const { repo } = useServices();
  const { ns } = useSession();
  const results = useQueries({ queries: children.map((child) => ({ queryKey: dkey(ns, 'habits', child.id, date), queryFn: (): Promise<HabitWithRecord[]> => repo.getHabits(child.id, date) })) });
  if (!children.length) {
    return <section className="home-kids-card home-kids-empty card"><div className="widget-head"><h2>아이 습관</h2><span>설정 전</span></div><div className="compact-empty"><span className="empty-friends" aria-hidden="true">{avatarOf('bodeuli')}{avatarOf('kongkong')}</span><strong>첫 습관을 만들어 볼까요?</strong><Link className="btn small" to="/settings">첫 항목 추가</Link></div></section>;
  }
  const pending = results.flatMap((result, index) => (result.data ?? []).filter((habit) => habit.record?.state === 'pending').map((habit) => ({ habit, child: children[index] as ChildProfile })));
  const one = children.length === 1;
  return (
    <>
      <section className={`home-kids-card card${one ? ' is-single' : ''}`}>
        <div className="widget-head"><h2>아이 습관</h2><Link to="/kids">크게 보기</Link></div>
        {one ? (() => {
          const child = children[0] as ChildProfile;
          const habits = results[0]?.data ?? [];
          const done = habits.filter(habitDone).length;
          const previews = habits.filter((habit) => !habitDone(habit)).slice(0, 3);
          return <Link className="single-kid-tile" to={`/kids/${child.id}`} data-testid="habit-summary">
            <span className="single-kid-avatar" role="img" aria-label={`${child.displayName}의 ${avatarNameOf(child.avatarKey)} 캐릭터`}>{avatarOf(child.avatarKey, habits.length > 0 && done === habits.length ? 'cheer' : 'happy')}</span>
            <div className="single-kid-copy"><strong>{child.displayName}</strong><span>★ 오늘의 별 {done}개</span><div className="progress-bar"><i style={{ width: `${habits.length ? (done / habits.length) * 100 : 0}%` }} /></div><small>{done}/{habits.length} 완료</small></div>
            <div className="habit-previews">{previews.length ? previews.map((habit) => <span key={habit.id}><i aria-hidden="true">{habitIconOf(habit.iconKey)}</i>{habit.title}</span>) : <b>{habits.length ? '오늘 습관 완료!' : '첫 습관을 기다리고 있어요'}</b>}</div>
            <em>아이 화면에서 습관 체크하기</em>
          </Link>;
        })() : <div className="multi-kid-summary">{children.map((child, index) => {
          const habits = results[index]?.data ?? [];
          const done = habits.filter(habitDone).length;
          return <Link to={`/kids/${child.id}`} key={child.id} data-testid="habit-summary"><span className="kid-mini-avatar" aria-hidden="true">{avatarOf(child.avatarKey, habits.length > 0 && done === habits.length ? 'cheer' : 'happy')}</span><div><strong>{child.displayName}</strong><small>{habits.slice(0, 3).map((habit) => habit.title).join(' · ') || '습관 설정 전'}</small><div className="progress-bar"><i style={{ width: `${habits.length ? (done / habits.length) * 100 : 0}%` }} /></div></div><b>{done}/{habits.length}</b></Link>;
        })}</div>}
        <Link className="kid-screen-link" to="/kids">아이 화면에서 습관 체크하기</Link>
      </section>
      <section className="approval-card card">
        <span className="approval-mascot" aria-hidden="true">{avatarOf('pogeuni')}</span>
        <div><span>부모님 확인</span><strong>승인 대기 {pending.length}건</strong>{pending[0] && <small>{pending[0].child.displayName} · {pending[0].habit.title}</small>}</div>
        <Link className="btn small" to={pending[0] ? `/kids/${pending[0].child.id}` : '/kids'}>부모님 확인</Link>
      </section>
    </>
  );
}

function ShoppingCard({ tasks }: { tasks: Task[] }) {
  return <section className="shopping-card card"><div className="widget-head"><h2>장보기</h2><span>{tasks.length}개</span></div>{tasks.length ? <div className="shopping-items">{tasks.slice(0, 3).map((task) => <span key={task.id}>{task.title}{task.quantity != null ? ` ${task.quantity}${task.unit ?? ''}` : ''}</span>)}</div> : <div className="shopping-empty"><span>장볼 것이 아직 없어요.</span><strong>냉장고 준비 완료 ✓</strong></div>}<Link className="card-cover-link" to="/tasks" aria-label="장보기 전체 보기" /></section>;
}

export function HomePage() {
  usePageTitle('이번 주');
  const { tz, familyName } = useSession();
  const today = todayIn(tz);
  const tomorrow = addDays(today, 1);
  const weekStart = mondayOf(today);
  const weekEnd = addDays(weekStart, 6);
  const weekEvents = useEvents(weekStart, weekEnd);
  const tomorrowQuery = useEvents(tomorrow, tomorrow);
  const todos = useTasks({ kind: 'todo' }, 'home-todos');
  const shopping = useTasks({ kind: 'shopping', completed: false }, 'home-shopping');
  const members = useMembers();
  const now = useNow(60_000);
  const todayEvents = useMemo(() => (weekEvents.data ?? []).filter((event) => eventCoversDate(event, today, tz)), [weekEvents.data, today, tz]);
  const todayTodos = useMemo(() => tasksForToday(todos.data ?? [], today, tz), [todos.data, today, tz]);
  const activeKids = members.data?.children.filter((child) => child.active) ?? [];

  return (
    <div className="home concept-seven-home">
      <header className="home-title-row">
        <div><span className="eyebrow">{familyName} · 이번 주</span><h1><span>{formatKoreanDate(today)}</span> {weekdayKo(today)}요일의 흐름</h1></div>
        <p>오늘 일정·할 일·습관과 이번 주를 함께 봐요.</p>
      </header>
      <QueryView q={weekEvents} rows={2}>{(events) => <WeekRibbon today={today} events={events} tz={tz} />}</QueryView>
      <div className="home-board">
        <QueryView q={weekEvents} rows={4}>{() => <HomeTimeline events={todayEvents} tomorrowEvents={sortEvents(tomorrowQuery.data ?? [])} today={today} tz={tz} now={now} />}</QueryView>
        <aside className="home-widgets">
          <section className="tasks-card card" aria-labelledby="home-tasks"><div className="widget-head"><h2 id="home-tasks">할 일</h2><span>{todayTodos.filter((task) => task.completedAt !== null).length} / {todayTodos.length} 완료</span></div><QueryView q={todos} rows={4}>{() => <HomeTaskList list={todayTodos} />}</QueryView>{todayTodos.length > 5 && <Link className="more-link" to="/tasks">+{todayTodos.length - 5}개 더 보기</Link>}</section>
          <QueryView q={shopping} rows={2}>{(list) => <ShoppingCard tasks={list} />}</QueryView>
          <HomeKids children={activeKids} date={today} />
        </aside>
      </div>
    </div>
  );
}

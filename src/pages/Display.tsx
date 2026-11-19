import { useEffect } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, eventCoversDate, formatKoreanDate, isoToZoned, todayIn, weekdayKo, weekdayOf } from '../domain/dates';
import { isFamilyBoardError } from '../domain/errors';
import { DEFAULT_TIMEZONE, type Task, type TvDisplayData } from '../domain/types';
import { useAppCtx, useNow, useOnline, usePageTitle, useRemoteSync, useServices } from '../app/context';
import { ErrorBlock, LoadingBlock, avatarOf } from '../ui/States';
import { FullscreenButton } from '../ui/Fullscreen';
import { habitDone } from './Kids';

const REFRESH_MS = 5 * 60 * 1000;

type DisplayChild = { id: string; displayName: string; avatarKey: string; done: number; total: number; habits: string[]; pending: number };
type DisplayData = TvDisplayData & { childDetails?: DisplayChild[]; taskDetails?: Task[] };

async function previewBoard(repo: ReturnType<typeof useServices>['repo'], familyName: string, tz: string): Promise<DisplayData> {
  const today = todayIn(tz);
  const [events, tasks, members] = await Promise.all([repo.getEvents({ from: today, to: today }), repo.getTasks(), repo.getMembers()]);
  const children = members.children.filter((child) => child.active);
  const habitLists = await Promise.all(children.map((child) => repo.getHabits(child.id, today)));
  const all = habitLists.flat();
  return {
    familyName,
    today,
    serverTime: new Date().toISOString(),
    events: events.filter((event) => event.visibility === 'family').slice(0, 12).map((event) => ({ id: event.id, title: event.title, allDay: event.allDay, startDate: event.startDate, endDate: event.endDate, startsAt: event.startsAt, endsAt: event.endsAt })),
    tasks: tasks.slice(0, 12).map((task) => ({ id: task.id, title: task.title, kind: task.kind, dueAt: task.dueAt })),
    taskDetails: tasks,
    habits: { done: all.filter(habitDone).length, total: all.length },
    childDetails: children.map((child, index) => ({ id: child.id, displayName: child.displayName, avatarKey: child.avatarKey, done: (habitLists[index] ?? []).filter(habitDone).length, total: habitLists[index]?.length ?? 0, habits: (habitLists[index] ?? []).map((habit) => habit.title), pending: (habitLists[index] ?? []).filter((habit) => habit.record?.state === 'pending').length })),
  };
}

function mondayOf(date: string) {
  const day = weekdayOf(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

function DisplayWeek({ today }: { today: string }) {
  const monday = mondayOf(today);
  return <div className="display-week" aria-label="이번 주">{Array.from({ length: 7 }, (_, index) => addDays(monday, index)).map((date) => <div key={date} className={`${date === today ? 'is-today' : ''}${weekdayOf(date) === 0 ? ' is-sunday' : ''}`}><span>{weekdayKo(date)}</span><strong>{Number(date.slice(8))}</strong></div>)}</div>;
}

function displayEventTime(event: DisplayData['events'][number], tz: string) {
  if (event.allDay || !event.startsAt) return '종일';
  return isoToZoned(event.startsAt, tz).time;
}

function DisplayKids({ data }: { data: DisplayData }) {
  const children = data.childDetails;
  if (!children) {
    const percentage = data.habits.total ? Math.round((data.habits.done / data.habits.total) * 100) : 0;
    return <div className="display-kid display-kid-generic"><span className="display-character" aria-hidden="true">{avatarOf('monggeul', percentage === 100 && data.habits.total > 0 ? 'cheer' : 'happy')}</span><div><h3>오늘 습관</h3><p>TV 기기의 가족 습관 합계</p><div className="progress-bar"><i style={{ width: `${percentage}%` }} /></div></div><strong>{data.habits.done}/{data.habits.total}</strong></div>;
  }
  if (!children.length) return <div className="display-kids-empty"><span aria-hidden="true">{avatarOf('monggeul', 'sleepy')}</span><strong>첫 습관을 기다리고 있어요</strong></div>;
  if (children.length === 1) {
    const child = children[0] as DisplayChild;
    const percentage = child.total ? Math.round((child.done / child.total) * 100) : 0;
    return <div className="display-kid is-single"><span className="display-character" role="img" aria-label={`${child.displayName}의 캐릭터`}>{avatarOf(child.avatarKey, child.total > 0 && child.done === child.total ? 'cheer' : 'happy')}</span><div><span>★ 오늘의 별 {child.done}개</span><h3>{child.displayName}</h3><p>{child.habits.slice(0, 3).join(' · ') || '습관 설정 전'}</p><div className="progress-bar"><i style={{ width: `${percentage}%` }} /></div>{child.pending > 0 && <small>부모님 확인 대기 {child.pending}건</small>}</div><strong>{child.done}/{child.total}</strong></div>;
  }
  return <div className={`display-kid-list${children.length > 2 ? ' is-grid' : ''}`}>{children.map((child) => { const percentage = child.total ? Math.round((child.done / child.total) * 100) : 0; return <div className="display-kid" key={child.id}><span className="display-character" role="img" aria-label={`${child.displayName}의 캐릭터`}>{avatarOf(child.avatarKey, child.total > 0 && child.done === child.total ? 'cheer' : 'happy')}</span><div><h3>{child.displayName}</h3><p>{child.habits.slice(0, 3).join(' · ')}</p><div className="progress-bar"><i style={{ width: `${percentage}%` }} /></div></div><strong>{child.done}/{child.total}</strong></div>; })}</div>;
}

export function DisplayPage() {
  usePageTitle('TV 화면');
  const { repo, deviceStore, queryClient } = useServices();
  const navigate = useNavigate();
  const online = useOnline();
  const context = useAppCtx();
  useRemoteSync(true);
  const now = useNow(1000);
  const tv = deviceStore.get('tv');
  const adult = context.data?.kind === 'adult' && context.data.family ? context.data : null;
  const enabled = Boolean(tv) || Boolean(adult);
  const query = useQuery<DisplayData>({
    queryKey: ['display', tv ? 'device' : 'adult', adult?.family?.id ?? ''],
    queryFn: () => (tv ? repo.getTvBoardData(tv.token) : previewBoard(repo, adult?.family?.name ?? '', adult?.family?.timezone ?? DEFAULT_TIMEZONE)),
    enabled,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (tv && isFamilyBoardError(query.error) && query.error.code === 'TOKEN_REVOKED') {
      deviceStore.clear('tv');
      void queryClient.invalidateQueries({ queryKey: ['ctx'] });
      navigate('/login', { replace: true });
    }
  }, [query.error, tv, deviceStore, queryClient, navigate]);

  if (!tv && context.isPending) return <div className="center"><LoadingBlock label="확인하는 중이에요…" /></div>;
  if (!tv && !adult) {
    if (context.data?.kind === 'device') return <Navigate to="/kids" replace />;
    return <Navigate to={context.data?.kind === 'adult' ? '/setup' : '/login'} state={{ next: '/display' }} replace />;
  }

  const tz = adult?.family?.timezone ?? DEFAULT_TIMEZONE;
  const time = isoToZoned(now.toISOString(), tz).time;
  const data = query.data;
  const today = data?.today ?? todayIn(tz, now);
  const events = (data?.events ?? []).filter((event) => eventCoversDate(event, today, tz)).sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? '')).slice(0, 3);
  const next = events.find((event) => !event.endsAt || new Date(event.endsAt).getTime() > now.getTime());
  const details = data?.taskDetails;
  const todo = (details ?? data?.tasks ?? []).filter((task) => task.kind === 'todo').slice(0, 5);
  const shopping = (details ?? data?.tasks ?? []).filter((task) => task.kind === 'shopping' && !('completedAt' in task && task.completedAt)).slice(0, 3);

  return (
    <div className="tv concept-seven-display" data-testid="tv-display">
      <header className="display-head"><div className="display-brand"><span>MONGGEUL FAMILY</span><h1>{weekdayKo(today)}요일의 흐름</h1></div><DisplayWeek today={today} /><div className="display-clock"><strong>{time}</strong><span>{formatKoreanDate(today)}</span></div><div className="display-tools no-print"><FullscreenButton className="btn secondary small" />{adult && <Link className="btn secondary small" to="/">앱으로 돌아가기</Link>}</div></header>
      <main className="display-grid" id="main">
        {query.isPending && !data ? <LoadingBlock label="오늘 정보를 불러오는 중이에요…" rows={4} /> : !data ? <ErrorBlock error={query.error} onRetry={() => void query.refetch()} /> : <>
          <section className="display-card display-timeline" aria-labelledby="tv-events"><div className="display-section-head"><h2 id="tv-events">오늘 타임라인</h2><span>일정 {events.length}</span></div>{events.length ? <ol>{events.map((event) => { const past = Boolean(event.endsAt && new Date(event.endsAt).getTime() <= now.getTime()); const isNext = next?.id === event.id; return <li key={event.id} data-testid="tv-event" className={`${past ? 'is-past' : ''}${isNext ? ' is-next' : ''}`}><time>{displayEventTime(event, tz)}<small>{past ? '지난 일정' : isNext ? 'NEXT' : '예정'}</small></time><i aria-hidden="true" /><div><span>{isNext ? '다음' : past ? '완료' : '오늘'}</span><h3>{event.title}</h3>{isNext && event.startsAt && <strong>{Math.max(0, Math.round((new Date(event.startsAt).getTime() - now.getTime()) / 60_000))}분 후</strong>}</div></li>; })}</ol> : <div className="display-empty"><span aria-hidden="true">{avatarOf('monggeul', 'sleepy')}</span><h3>오늘은 가족 마음대로</h3><p>정해진 일정 없이 천천히 쉬어 가요.</p></div>}</section>
          <div className="display-middle"><section className="display-card display-tasks" aria-labelledby="tv-tasks"><div className="display-section-head"><h2 id="tv-tasks">할 일</h2><span>{todo.filter((task) => 'completedAt' in task && task.completedAt).length} / {todo.length} 완료</span></div><ul aria-label="남은 할 일">{todo.map((task) => { const done = 'completedAt' in task && Boolean(task.completedAt); return <li key={task.id} data-testid="tv-task" className={done ? 'is-done' : ''}><i>{done ? '✓' : ''}</i><span>{task.title}</span></li>; })}</ul>{todo.length === 0 && <p className="display-compact-empty">오늘 할 일은 비어 있어요 ✓</p>}</section><section className="display-card display-shopping"><div className="display-section-head"><h2>장보기</h2><span>{shopping.length}개</span></div>{shopping.map((task) => <div className="display-shopping-row" key={task.id}>{task.title}<b>{'quantity' in task && task.quantity != null ? `${String(task.quantity)}${'unit' in task ? String(task.unit ?? '') : ''}` : ''}</b></div>)}{shopping.length === 0 && <p>냉장고 준비 완료 ✓</p>}</section></div>
          <section className="display-card display-kids" aria-labelledby="tv-habits"><div className="display-section-head"><h2 id="tv-habits">아이 습관</h2><span>오늘</span></div><DisplayKids data={data} /></section>
        </>}
      </main>
      <footer className="display-foot">{!online ? '오프라인 · 마지막으로 받은 내용이에요' : `${data?.familyName ?? ''} · 5분마다 새로고침해요`}</footer>
    </div>
  );
}

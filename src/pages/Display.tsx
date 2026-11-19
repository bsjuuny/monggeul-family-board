import { useEffect } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, formatKoreanDate, formatTimeRangeKo, isoToZoned, todayIn } from '../domain/dates';
import { isFamilyBoardError } from '../domain/errors';
import { DEFAULT_TIMEZONE, type TvDisplayData } from '../domain/types';
import { useAppCtx, useNow, useOnline, usePageTitle, useRemoteSync, useServices } from '../app/context';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../ui/States';

const REFRESH_MS = 5 * 60 * 1000;

/** 어른 로그인 상태의 미리보기: TV와 같은 allowlist(가족 공개 일정, 미완료 할 일, 습관 개수)만 만든다. */
async function previewBoard(repo: ReturnType<typeof useServices>['repo'], familyName: string, tz: string): Promise<TvDisplayData> {
  const today = todayIn(tz);
  const [events, tasks, members] = await Promise.all([repo.getEvents({ from: today, to: addDays(today, 2) }), repo.getTasks({ completed: false }), repo.getMembers()]);
  const kids = members.children.filter((c) => c.active);
  const habitLists = await Promise.all(kids.map((c) => repo.getHabits(c.id, today)));
  const all = habitLists.flat();
  return {
    familyName,
    today,
    serverTime: new Date().toISOString(),
    events: events
      .filter((e) => e.visibility === 'family')
      .slice(0, 12)
      .map((e) => ({ id: e.id, title: e.title, allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, startsAt: e.startsAt, endsAt: e.endsAt })),
    tasks: tasks.slice(0, 12).map((t) => ({ id: t.id, title: t.title, kind: t.kind, dueAt: t.dueAt })),
    habits: { done: all.filter((h) => h.record && h.record.state !== 'rejected').length, total: all.length },
  };
}

/** F-06: TV 화면은 로그인 세션이 필요한 읽기 전용 전체 화면이다. 서버 문서의 변경은 5초 내 자동 반영한다. */
export function DisplayPage() {
  usePageTitle('TV 화면');
  const { repo, deviceStore, queryClient } = useServices();
  const navigate = useNavigate();
  const online = useOnline();
  const ctx = useAppCtx();
  useRemoteSync(true); // 읽기 전용 화면: 다른 기기의 변경을 자동 반영
  const now = useNow(1000);
  const tv = deviceStore.get('tv');
  const adult = ctx.data?.kind === 'adult' && ctx.data.family ? ctx.data : null;
  const enabled = Boolean(tv) || Boolean(adult);
  const q = useQuery<TvDisplayData>({
    queryKey: ['display', tv ? 'device' : 'adult', adult?.family?.id ?? ''],
    queryFn: () => (tv ? repo.getTvBoardData(tv.token) : previewBoard(repo, adult?.family?.name ?? '', adult?.family?.timezone ?? DEFAULT_TIMEZONE)),
    enabled,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  // 기기 철회/만료 → token 삭제 후 페어링 화면
  useEffect(() => {
    if (tv && isFamilyBoardError(q.error) && q.error.code === 'TOKEN_REVOKED') {
      deviceStore.clear('tv');
      void queryClient.invalidateQueries({ queryKey: ['ctx'] });
      navigate('/login', { replace: true });
    }
  }, [q.error, tv, deviceStore, queryClient, navigate]);

  if (!tv && ctx.isPending) {
    return (
      <div className="center">
        <LoadingBlock label="확인하는 중이에요…" />
      </div>
    );
  }
  if (!tv && !adult) {
    if (ctx.data?.kind === 'device') return <Navigate to="/kids" replace />;
    return <Navigate to={ctx.data?.kind === 'adult' ? '/setup' : '/login'} state={{ next: '/display' }} replace />;
  }

  const tz = adult?.family?.timezone ?? DEFAULT_TIMEZONE;
  const time = isoToZoned(now.toISOString(), tz).time;
  const d = q.data;
  const today = d?.today ?? todayIn(tz, now);
  return (
    <div className="tv" data-testid="tv-display">
      <header className="tv-head">
        <div>
          <div className="tv-date">{formatKoreanDate(today)}</div>
          <div className="tv-clock" aria-label={`현재 시각 ${time}`}>
            {time}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <strong style={{ fontSize: 'clamp(1.2rem, 2.6vw, 2.4rem)' }}>🫧 {d?.familyName ?? ''}</strong>
          {!online && <div className="chip warn">📴 오프라인 · 마지막 내용이에요</div>}
          {adult && (
            <div className="no-print">
              <Link className="btn secondary small" to="/">
                ← 앱으로 돌아가기
              </Link>
            </div>
          )}
        </div>
      </header>
      <main className="tv-body" id="main">
        {q.isPending && !d ? (
          <LoadingBlock label="오늘 정보를 불러오는 중이에요…" rows={4} />
        ) : !d ? (
          <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <section className="card mint" aria-labelledby="tv-events">
              <h2 id="tv-events">📅 앞으로 일정</h2>
              {d.events.length === 0 ? (
                <EmptyBlock icon="🌤️" title="오늘은 일정이 없어요" />
              ) : (
                <ul className="list" aria-label="가족 일정">
                  {d.events.map((e) => (
                    <li key={e.id} data-testid="tv-event">
                      <span className="grow">{e.title}</span>
                      <span className="chip">
                        {e.allDay && e.startDate && e.startDate !== d.today ? `${e.startDate.slice(5).replace('-', '/')} ` : ''}
                        {formatTimeRangeKo(e, tz)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div className="stack">
              <section className="card pink" aria-labelledby="tv-tasks">
                <h2 id="tv-tasks">✅ 남은 할 일</h2>
                {d.tasks.length === 0 ? (
                  <EmptyBlock icon="🎉" title="모두 끝냈어요!" />
                ) : (
                  <ul className="list" aria-label="남은 할 일">
                    {d.tasks.map((t) => (
                      <li key={t.id} data-testid="tv-task">
                        <span className="grow">
                          {t.kind === 'shopping' ? '🛒 ' : ''}
                          {t.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="card peach" aria-labelledby="tv-habits">
                <h2 id="tv-habits">🧸 오늘 습관</h2>
                <p style={{ fontSize: 'clamp(1.2rem, 2.4vw, 2.2rem)', marginBottom: 0 }}>
                  {d.habits.total === 0 ? '등록된 습관이 없어요' : `${d.habits.done} / ${d.habits.total} 했어요`}
                </p>
              </section>
            </div>
          </>
        )}
      </main>
      <footer className="tv-foot">
        {q.dataUpdatedAt ? `${isoToZoned(new Date(q.dataUpdatedAt).toISOString(), tz).time} 기준 · 5분마다 새로고침해요` : '불러오는 중…'}
      </footer>
    </div>
  );
}

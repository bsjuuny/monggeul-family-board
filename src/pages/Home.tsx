import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { formatKoreanDate, formatTimeRangeKo, todayIn } from '../domain/dates';
import type { HabitWithRecord, TaskKind } from '../domain/types';
import { dkey, useOnline, usePageTitle, useServices, useSession } from '../app/context';
import { useEvents, useMembers, useTasks } from '../app/queries';
import { EmptyBlock, OfflineReason, QueryView, avatarOf } from '../ui/States';
import { EventForm } from './Calendar';
import { habitDone } from './Kids';
import { TaskForm, TaskRow } from './Tasks';

function HabitSummary() {
  const { repo } = useServices();
  const { ns, tz } = useSession();
  const date = todayIn(tz);
  const members = useMembers();
  const kids = members.data?.children.filter((c) => c.active) ?? [];
  const results = useQueries({
    queries: kids.map((c) => ({ queryKey: dkey(ns, 'habits', c.id, date), queryFn: (): Promise<HabitWithRecord[]> => repo.getHabits(c.id, date) })),
  });
  return (
    <QueryView
      q={members}
      isEmpty={(d) => d.children.filter((c) => c.active).length === 0}
      empty={<EmptyBlock icon="🧸" title="아직 아이가 없어요" hint="설정에서 아이를 추가하면 여기에 습관 현황이 보여요." />}
    >
      {() => (
        <ul className="list" aria-label="아이 습관 현황">
          {kids.map((c, i) => {
            const r = results[i];
            const list = r?.data ?? [];
            const done = list.filter(habitDone).length;
            const waiting = list.filter((h) => h.record?.state === 'pending').length;
            return (
              <li key={c.id} data-testid="habit-summary">
                <span aria-hidden="true">{avatarOf(c.avatarKey)}</span>
                <Link to={`/kids/${c.id}`} className="grow">
                  {c.displayName}
                </Link>
                {r?.isError ? (
                  <span className="chip bad">불러오지 못했어요</span>
                ) : r?.data ? (
                  <>
                    <span className="chip ok">
                      {done}/{list.length} 완료
                    </span>
                    {waiting > 0 && <span className="chip warn">승인 대기 {waiting}</span>}
                  </>
                ) : (
                  <span className="chip">확인 중…</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </QueryView>
  );
}

export function HomePage() {
  usePageTitle('홈');
  const { tz, familyName } = useSession();
  const online = useOnline();
  const today = todayIn(tz);
  const events = useEvents(today, today);
  const tasks = useTasks({ completed: false }, 'home');
  const [add, setAdd] = useState<null | { type: 'event' } | { type: 'task'; kind: TaskKind }>(null);

  return (
    <div className="stack">
      <div>
        <h1 style={{ marginBottom: 2 }}>{formatKoreanDate(today)}</h1>
        <p className="muted">{familyName} 가족의 오늘이에요.</p>
      </div>
      <div className="btn-row" aria-label="빠른 추가">
        <button type="button" className="btn" disabled={!online} onClick={() => setAdd({ type: 'event' })}>
          ＋ 일정
        </button>
        <button type="button" className="btn" disabled={!online} onClick={() => setAdd({ type: 'task', kind: 'todo' })}>
          ＋ 할 일
        </button>
        <button type="button" className="btn secondary" disabled={!online} onClick={() => setAdd({ type: 'task', kind: 'shopping' })}>
          ＋ 장보기
        </button>
        <Link className="btn ghost" to="/display">
          📺 TV 화면 미리보기
        </Link>
      </div>
      <OfflineReason show={!online}>오프라인이에요. 서버에 연결되어야 저장할 수 있어요.</OfflineReason>
      <div className="grid2">
        <section className="card mint" aria-labelledby="home-events">
          <h2 id="home-events">📅 오늘 일정</h2>
          <QueryView q={events} isEmpty={(d) => d.length === 0} empty={<EmptyBlock icon="🌤️" title="오늘은 일정이 없어요" hint="여유로운 하루를 보내요." />}>
            {(list) => (
              <ul className="list" aria-label="오늘 일정">
                {list.map((e) => (
                  <li key={e.id} data-testid="home-event">
                    <span className="grow">
                      {e.visibility === 'private' && <span aria-label="나만 보기">🔒 </span>}
                      {e.title}
                    </span>
                    <span className="chip">{formatTimeRangeKo(e, tz)}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            <Link to="/calendar">캘린더 전체 보기 →</Link>
          </p>
        </section>
        <section className="card pink" aria-labelledby="home-tasks">
          <h2 id="home-tasks">✅ 남은 할 일</h2>
          <QueryView q={tasks} isEmpty={(d) => d.length === 0} empty={<EmptyBlock icon="🎉" title="남은 할 일이 없어요" hint="모두 끝냈어요. 정말 잘했어요!" />}>
            {(list) => (
              <ul className="list" aria-label="남은 할 일">
                {list.slice(0, 6).map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </ul>
            )}
          </QueryView>
          <p style={{ marginTop: 12, marginBottom: 0 }}>
            <Link to="/tasks">할 일 전체 보기 →</Link>
          </p>
        </section>
      </div>
      <section className="card peach" aria-labelledby="home-habits">
        <h2 id="home-habits">🧸 아이 습관</h2>
        <HabitSummary />
      </section>
      <section className="card" aria-labelledby="home-more">
        <h2 id="home-more">🌱 곧 만나요 (P1)</h2>
        <div className="btn-row">
          <Link className="btn secondary small" to="/memories">
            📸 추억
          </Link>
          <Link className="btn secondary small" to="/play">
            🎲 놀이
          </Link>
          <Link className="btn secondary small" to="/family">
            💌 가족 소통
          </Link>
        </div>
      </section>
      {add?.type === 'event' && <EventForm date={today} onClose={() => setAdd(null)} />}
      {add?.type === 'task' && <TaskForm kind={add.kind} onClose={() => setAdd(null)} />}
    </div>
  );
}

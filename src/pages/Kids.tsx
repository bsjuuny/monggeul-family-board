import { Link, Navigate, useParams } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { friendlyMessage } from '../domain/errors';
import { formatKoreanDate, todayIn } from '../domain/dates';
import type { ChildProfile, HabitState, HabitWithRecord } from '../domain/types';
import { dkey, usePageTitle, useServices, useSession } from '../app/context';
import { useCheckHabit } from '../app/offlineHooks';
import { useEvents, useHabits, useMembers, useTasks } from '../app/queries';
import { avatarNameOf, avatarOf, EmptyBlock, habitIconOf, LoadingBlock, QueryView } from '../ui/States';
import { useToast } from '../ui/Toasts';

const CHEERS = ['오늘도 멋지게 해내 볼까요?', '하나씩 천천히 해요. 잘하고 있어요!', '해낸 만큼 반짝반짝 빛나요 ✨', '작은 습관이 큰 힘이 돼요.'];

const STATE_LABEL: Record<HabitState | 'none', string> = {
  none: '아직 안 했어요',
  pending: '부모님 확인 대기',
  approved: '승인됐어요',
  done: '완료!',
  rejected: '한 번 더 해 볼까요?',
};

export function habitDone(habit: HabitWithRecord): boolean {
  return habit.record?.state === 'done' || habit.record?.state === 'approved';
}

function HabitCard({ habit, date, isAdult, compact = false }: { habit: HabitWithRecord; date: string; isAdult: boolean; compact?: boolean }) {
  const { repo } = useServices();
  const { ns } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { check, busy } = useCheckHabit();
  const state: HabitState | 'none' = habit.record?.state ?? 'none';
  const finished = state === 'done' || state === 'approved';
  const waiting = state === 'pending';

  async function decide(kind: 'approve' | 'reject') {
    if (!habit.record) return;
    try {
      if (kind === 'approve') await repo.approveHabit(habit.record.id);
      else await repo.rejectHabit(habit.record.id);
      await queryClient.invalidateQueries({ queryKey: dkey(ns, 'habits') });
      toast.info(kind === 'approve' ? '승인했어요.' : '다시 해 보자고 전했어요.');
    } catch (error) {
      toast.error(friendlyMessage(error));
    }
  }

  return (
    <li className={`habit kid-habit${compact ? ' is-compact' : ''}${finished ? ' done' : waiting ? ' pending' : state === 'rejected' ? ' rejected' : ''}`} data-testid="habit" data-state={state}>
      <span className="icon" aria-hidden="true">{habitIconOf(habit.iconKey)}</span>
      <div className="grow"><div className="title">{habit.title}</div><div className="muted">{STATE_LABEL[state]}{habit.approvalRequired && !finished && !waiting ? ' · 부모님 확인 필요' : ''}</div></div>
      {isAdult && waiting && habit.record ? (
        <div className="habit-decisions">
          <span>부모님 확인 대기</span>
          <button type="button" className="btn small" onClick={() => void decide('approve')} aria-label={`${habit.title} 승인`}>승인</button>
          <button type="button" className="btn secondary small" onClick={() => void decide('reject')} aria-label={`${habit.title} 반려`}>반려</button>
        </div>
      ) : waiting ? <span className="pending-state">부모님 확인 대기</span> : finished ? <span className="habit-check" aria-label="완료">✓</span> : (
        <button type="button" className="habit-action" onClick={() => void check(habit.id, date)} disabled={busy.has(`${habit.id}:${date}`)} aria-label={`${habit.title} 했어요`}>했어요!</button>
      )}
    </li>
  );
}

function ProgressRing({ done, total, sea = false }: { done: number; total: number; sea?: boolean }) {
  const percentage = total ? Math.round((done / total) * 100) : 0;
  return <div className={`kid-progress-ring${sea ? ' is-sea' : ''}`} style={{ '--progress': `${percentage}%` } as React.CSSProperties}><div><strong>{done}/{total}</strong><span>{percentage}%</span></div></div>;
}

function SingleKidScreen({ child, showBack = false }: { child: ChildProfile; showBack?: boolean }) {
  const { tz, kind } = useSession();
  const date = todayIn(tz);
  const habits = useHabits(child.id, date);
  const list = habits.data ?? [];
  const done = list.filter(habitDone).length;
  const pending = list.filter((habit) => habit.record?.state === 'pending');
  const allDone = list.length > 0 && done === list.length;
  const cheer = CHEERS[(Number(date.slice(8)) + child.id.length) % CHEERS.length];
  return (
    <div className="single-kid-screen">
      <header className="kids-screen-title">
        <div>{showBack && <Link className="back-button" to="/kids" aria-label="아이 목록">‹</Link>}<div><span className="eyebrow">{avatarNameOf(child.avatarKey)}와 함께</span><h1>{child.displayName}의 오늘</h1></div></div>
        <span>{formatKoreanDate(date)}</span>
      </header>
      <section className={`single-kid-hero card${allDone ? ' is-complete' : ''}`}>
        <span className={`single-kid-character character-float${allDone ? ' is-cheering' : ''}`} role="img" aria-label={`${child.displayName}의 ${avatarNameOf(child.avatarKey)} 캐릭터`}>{avatarOf(child.avatarKey, allDone ? 'cheer' : 'happy')}</span>
        <div className="single-kid-hero-copy"><span className="star-chip">★ 오늘의 별 {done}개</span><small>{avatarNameOf(child.avatarKey)}와 함께</small><h2>{child.displayName}</h2><p>{allDone ? '오늘 습관을 모두 해냈어요! 정말 멋져요 ✨' : pending.length ? `${pending[0]?.title}는 부모님이 확인하고 있어요.` : cheer}</p><ProgressRing done={done} total={list.length} /></div>
      </section>
      <section className="single-habit-card card">
        <div className="section-heading"><div><h2>내가 할 습관</h2><span>큰 버튼을 눌러 체크해요</span></div><strong>{done}/{list.length}</strong></div>
        {habits.isPending ? <LoadingBlock rows={4} /> : habits.isError ? <QueryView q={habits}>{() => null}</QueryView> : list.length === 0 ? <EmptyBlock mood="sleepy" title="오늘 할 습관이 없어요" hint={kind === 'adult' ? '설정에서 첫 습관을 추가해 보세요.' : '부모님께 습관 추가를 부탁해요.'}>{kind === 'adult' && <Link className="btn" to="/settings">첫 항목 추가</Link>}</EmptyBlock> : <ul className="list single-habit-list" aria-label="오늘의 습관">{list.slice(0, 5).map((habit) => <HabitCard key={habit.id} habit={habit} date={date} isAdult={kind === 'adult'} />)}</ul>}
        <div className="kid-reward-row"><div><span>★</span><p><strong>오늘의 별 {done}개</strong><small>완료한 습관만큼 반짝여요</small></p></div><div className="parent-note"><small>부모님 확인</small><strong>대기 중 {pending.length}건</strong><span>{pending[0] ? `${pending[0].title} 완료를 확인해 주세요.` : '확인할 습관이 없어요.'}</span></div></div>
        <div className={`celebration-line${allDone ? ' is-done' : ''}`}>{allDone ? `${child.displayName}아, 오늘 습관을 모두 해냈어!` : `${list.length} / ${list.length}가 되면 ${avatarNameOf(child.avatarKey)}가 신나게 축하해요!`}</div>
      </section>
    </div>
  );
}

function ParentStrip({ pendingCount }: { pendingCount: number }) {
  const { tz } = useSession();
  const today = todayIn(tz);
  const events = useEvents(today, today);
  const tasks = useTasks({ kind: 'todo' }, 'kids-parent');
  const next = (events.data ?? []).find((event) => !event.endsAt || new Date(event.endsAt).getTime() > Date.now());
  return <section className="parent-strip"><div><small>부모님 한눈 요약</small><strong>오늘 일정 {events.data?.length ?? 0} · 할 일 {(tasks.data ?? []).filter((task) => !task.completedAt).length}</strong></div><div><small>다음 일정</small><strong>{next?.title ?? '여유로운 하루'}</strong></div><div><small>부모님 확인</small><strong>승인 대기 {pendingCount}건</strong></div></section>;
}

function TwoKidBoard({ children }: { children: ChildProfile[] }) {
  const { repo } = useServices();
  const { ns, tz, kind } = useSession();
  const date = todayIn(tz);
  const results = useQueries({ queries: children.map((child) => ({ queryKey: dkey(ns, 'habits', child.id, date), queryFn: (): Promise<HabitWithRecord[]> => repo.getHabits(child.id, date) })) });
  const pendingCount = results.reduce((sum, result) => sum + (result.data ?? []).filter((habit) => habit.record?.state === 'pending').length, 0);
  return <div className="multi-kids-screen"><header className="kids-screen-title"><div><div><span className="eyebrow">KIDS HABIT PLAY</span><h1>오늘도 한 칸씩!</h1></div></div><span>{formatKoreanDate(date)}</span></header><ParentStrip pendingCount={pendingCount} /><section className="two-kid-board">{children.map((child, index) => {
    const list = results[index]?.data ?? [];
    const done = list.filter(habitDone).length;
    const allDone = list.length > 0 && done === list.length;
    const sea = index % 2 === 1;
    return <article className={`kid-zone${sea ? ' is-sea' : ''}`} key={child.id}><header><div><small>{avatarNameOf(child.avatarKey)}와 함께</small><h2>{child.displayName}</h2></div><span>★ {done}</span></header><div className="kid-zone-hero"><span className={`character-float${allDone ? ' is-cheering' : ''}`} role="img" aria-label={`${child.displayName}의 ${avatarNameOf(child.avatarKey)} 캐릭터`}>{avatarOf(child.avatarKey, allDone ? 'cheer' : 'happy')}</span><ProgressRing done={done} total={list.length} sea={sea} /></div><div className="kid-zone-heading"><strong>오늘 습관</strong><span>{allDone ? '모두 해냈어요!' : `${Math.max(list.length - done, 0)}개 남았어요`}</span></div>{results[index]?.isPending ? <LoadingBlock rows={4} /> : list.length ? <ul className="list zone-habit-list" aria-label={`${child.displayName}의 오늘 습관`}>{list.slice(0, 4).map((habit) => <HabitCard compact key={habit.id} habit={habit} date={date} isAdult={kind === 'adult'} />)}</ul> : <EmptyBlock mood="sleepy" title="첫 습관을 기다리고 있어요" />}<div className="zone-reward">★ <span><strong>오늘의 별 {done}개</strong><small>{allDone ? '오늘 미션 달성!' : '오늘도 차곡차곡!'}</small></span></div><Link className="zone-detail-link" to={`/kids/${child.id}`}>{allDone ? `${child.displayName}아, 정말 멋져!` : `${child.displayName}의 큰 화면 보기`}</Link></article>;
  })}</section></div>;
}

function ManyKidsBoard({ children }: { children: ChildProfile[] }) {
  const { repo } = useServices();
  const { ns, tz } = useSession();
  const date = todayIn(tz);
  const results = useQueries({ queries: children.map((child) => ({ queryKey: dkey(ns, 'habits', child.id, date), queryFn: (): Promise<HabitWithRecord[]> => repo.getHabits(child.id, date) })) });
  return <div className="many-kids-screen"><header className="kids-screen-title"><div><div><span className="eyebrow">KIDS HABIT PLAY</span><h1>우리 아이들의 오늘</h1></div></div><span>{formatKoreanDate(date)}</span></header><div className={`many-kids-grid count-${Math.min(children.length, 7)}`}>{children.map((child, index) => { const list = results[index]?.data ?? []; const done = list.filter(habitDone).length; const allDone = list.length > 0 && done === list.length; return <Link to={`/kids/${child.id}`} className="many-kid-card" key={child.id} data-testid="kid-card"><span role="img" aria-label={`${child.displayName}의 ${avatarNameOf(child.avatarKey)} 캐릭터`}>{avatarOf(child.avatarKey, allDone ? 'cheer' : 'happy')}</span><div><h2>{child.displayName}</h2><p>★ 오늘의 별 {done}개</p><div className="progress-bar"><i style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></div><strong>{done}/{list.length} 완료</strong></div></Link>; })}</div></div>;
}

function KidPicker({ children }: { children: ChildProfile[] }) {
  return <div className="kid-picker"><h1>누구예요?</h1><p>내 캐릭터를 골라 주세요.</p><div className="kidcards">{children.map((child) => <Link key={child.id} to={`/kids/${child.id}`} className="kidcard" data-testid="kid-card"><span className="picker-character character-float" role="img" aria-label={`${child.displayName}의 ${avatarNameOf(child.avatarKey)} 캐릭터`}>{avatarOf(child.avatarKey)}</span><strong>{child.displayName}</strong><span className="muted">오늘 습관 보기</span></Link>)}</div></div>;
}

export function KidsPage() {
  usePageTitle('아이');
  const { kind } = useSession();
  const members = useMembers();
  return <QueryView q={members} isEmpty={(data) => data.children.filter((child) => child.active).length === 0} empty={<div className="kids-empty"><h1>아이</h1><EmptyBlock title="아직 아이가 없어요" hint={kind === 'adult' ? '설정에서 아이를 추가해 보세요.' : '부모님께 아이 추가를 부탁해요.'}>{kind === 'adult' && <Link className="btn" to="/settings">첫 아이 추가</Link>}</EmptyBlock></div>}>{(data) => {
    const children = data.children.filter((child) => child.active);
    if (children.length === 1) return <SingleKidScreen child={children[0] as ChildProfile} />;
    if (kind === 'device') return <KidPicker children={children} />;
    if (children.length === 2) return <TwoKidBoard children={children} />;
    return <ManyKidsBoard children={children} />;
  }}</QueryView>;
}

export function KidDetailPage() {
  const { id = '' } = useParams();
  const members = useMembers();
  const child = members.data?.children.find((candidate) => candidate.id === id && candidate.active);
  usePageTitle(child ? `${child.displayName}의 오늘` : '아이');
  if (members.data && !child) return <Navigate to="/kids" replace />;
  return <QueryView q={members}>{() => child ? <SingleKidScreen child={child} showBack /> : null}</QueryView>;
}

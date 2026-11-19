import { Link, Navigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { friendlyMessage } from '../domain/errors';
import { todayIn } from '../domain/dates';
import type { HabitState, HabitWithRecord } from '../domain/types';
import { dkey, usePageTitle, useServices, useSession } from '../app/context';
import { useCheckHabit } from '../app/offlineHooks';
import { useHabits, useMembers } from '../app/queries';
import { avatarOf, EmptyBlock, habitIconOf, QueryView } from '../ui/States';
import { useToast } from '../ui/Toasts';

const CHEERS = ['오늘도 멋지게 해내 볼까요?', '하나씩 천천히 해요. 잘하고 있어요!', '해낸 만큼 반짝반짝 빛나요 ✨', '작은 습관이 큰 힘이 돼요.'];

const STATE_LABEL: Record<HabitState | 'none', string> = {
  none: '아직 안 했어요',
  pending: '부모님 확인을 기다려요',
  approved: '승인됐어요',
  done: '완료!',
  rejected: '한 번 더 해 볼까요?',
};

export function habitDone(h: HabitWithRecord): boolean {
  return h.record?.state === 'done' || h.record?.state === 'approved';
}

export function KidsPage() {
  usePageTitle('아이');
  const { kind } = useSession();
  const members = useMembers();
  return (
    <div className="stack">
      <h1>{kind === 'device' ? '누구예요?' : '아이'}</h1>
      <QueryView
        q={members}
        isEmpty={(d) => d.children.filter((c) => c.active).length === 0}
        empty={
          <EmptyBlock icon="🧸" title="아직 아이가 없어요" hint={kind === 'adult' ? '설정에서 아이를 추가해 보세요.' : '부모님께 아이 추가를 부탁해요.'}>
            {kind === 'adult' && (
              <Link className="btn" to="/settings">
                설정으로 가기
              </Link>
            )}
          </EmptyBlock>
        }
      >
        {(d) => (
          <div className="kidcards">
            {d.children
              .filter((c) => c.active)
              .map((c) => (
                <Link key={c.id} to={`/kids/${c.id}`} className="kidcard" data-testid="kid-card">
                  <span className="avatar lg" aria-hidden="true">
                    {avatarOf(c.avatarKey)}
                  </span>
                  <strong>{c.displayName}</strong>
                  <span className="muted">오늘 습관 보기</span>
                </Link>
              ))}
          </div>
        )}
      </QueryView>
    </div>
  );
}

function HabitCard({ h, date, isAdult }: { h: HabitWithRecord; date: string; isAdult: boolean }) {
  const { repo } = useServices();
  const { ns } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const { check, busy } = useCheckHabit();
  const state: HabitState | 'none' = h.record?.state ?? 'none';
  const finished = state === 'done' || state === 'approved';
  const waiting = state === 'pending';

  async function decide(kind: 'approve' | 'reject') {
    if (!h.record) return;
    try {
      if (kind === 'approve') await repo.approveHabit(h.record.id);
      else await repo.rejectHabit(h.record.id);
      await qc.invalidateQueries({ queryKey: dkey(ns, 'habits') });
      toast.info(kind === 'approve' ? '승인했어요.' : '다시 해 보자고 전했어요.');
    } catch (e) {
      toast.error(friendlyMessage(e));
    }
  }

  return (
    <li className={`habit ${finished ? 'done' : waiting ? 'pending' : state === 'rejected' ? 'rejected' : ''}`} data-testid="habit" data-state={state}>
      <span className="icon" aria-hidden="true">
        {habitIconOf(h.iconKey)}
      </span>
      <div className="grow">
        <div className="title">{h.title}</div>
        <div className="muted">
          {finished ? '✔ ' : waiting ? '⏳ ' : ''}
          {STATE_LABEL[state]}
          {h.approvalRequired && !finished && !waiting ? ' · 부모님 확인이 필요해요' : ''}
        </div>
      </div>
      {isAdult && waiting && h.record ? (
        <>
          <button type="button" className="btn small" onClick={() => void decide('approve')} aria-label={`${h.title} 승인`}>
            승인
          </button>
          <button type="button" className="btn secondary small" onClick={() => void decide('reject')} aria-label={`${h.title} 반려`}>
            반려
          </button>
        </>
      ) : (
        !finished &&
        !waiting && (
          <button type="button" className="btn" onClick={() => void check(h.id, date)} disabled={busy.has(`${h.id}:${date}`)} aria-label={`${h.title} 했어요`}>
            했어요!
          </button>
        )
      )}
    </li>
  );
}

export function KidDetailPage() {
  const { id = '' } = useParams();
  const { tz, kind } = useSession();
  const members = useMembers();
  const date = todayIn(tz);
  const child = members.data?.children.find((c) => c.id === id);
  usePageTitle(child ? `${child.displayName}의 오늘` : '아이');
  const habits = useHabits(id, date, Boolean(child));
  const cheer = CHEERS[(Number(date.slice(8)) + id.length) % CHEERS.length];

  if (members.data && !child) return <Navigate to="/kids" replace />;
  return (
    <div className="stack">
      <Link to="/kids">← 아이 목록</Link>
      <QueryView q={members}>
        {() =>
          child ? (
            <>
              <div className="card peach" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <span className="avatar lg" aria-hidden="true">
                  {avatarOf(child.avatarKey)}
                </span>
                <div>
                  <h1 style={{ marginBottom: 4 }}>{child.displayName}의 오늘</h1>
                  <p className="cheer" style={{ marginBottom: 0 }}>
                    {cheer}
                  </p>
                </div>
              </div>
              <QueryView
                q={habits}
                isEmpty={(d) => d.length === 0}
                empty={<EmptyBlock icon="🌱" title="오늘 할 습관이 없어요" hint={kind === 'adult' ? '설정에서 습관을 추가해 보세요.' : '부모님께 습관 추가를 부탁해요.'} />}
              >
                {(list) => (
                  <ul className="list" aria-label="오늘의 습관" style={{ gap: 12 }}>
                    {list.map((h) => (
                      <HabitCard key={h.id} h={h} date={date} isAdult={kind === 'adult'} />
                    ))}
                  </ul>
                )}
              </QueryView>
            </>
          ) : null
        }
      </QueryView>
    </div>
  );
}

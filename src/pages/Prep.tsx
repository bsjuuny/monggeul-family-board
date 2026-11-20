// 준비물·내일 준비·픽업 담당·등하원 예외 (가족 기기 사이에 서버로 공유)
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePageTitle, useServices } from '../app/context';
import { useMembers } from '../app/queries';
import { addDays } from '../domain/dates';
import { isFamilyBoardError } from '../domain/errors';
import { shortDateKo } from '../board/format';
import type { PrepItem } from '../server/v2';
import { ErrorBlock, LoadingBlock } from '../ui/States';
import { useToast } from '../ui/Toasts';

const KIND_LABEL: Record<PrepItem['kind'], string> = { dropoff: '등원 준비물', pickup: '하원 준비물', event: '행사 준비물', document: '제출 서류', parent_task: '보호자 할 일' };
const todayKst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export function PrepPage() {
  usePageTitle('준비물·픽업');
  const { v2 } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const members = useMembers();
  const today = todayKst();
  const end = addDays(today, 6);
  const prep = useQuery({ queryKey: ['prep', today], queryFn: () => v2.prep(today, end) });
  const pickups = useQuery({ queryKey: ['pickups', today], queryFn: () => v2.pickups(today, end) });
  const commute = useQuery({ queryKey: ['commute', today], queryFn: () => v2.commute(today, addDays(today, 30)) });
  const refresh = () => Promise.all(['prep', 'pickups', 'commute', 'board'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  const onErr = (e: unknown) => toast.error(isFamilyBoardError(e) ? e.message : '저장하지 못했어요.');
  const toggle = useMutation({ mutationFn: (p: PrepItem) => v2.patchPrep(p.id, { done: !p.doneAt }), onSuccess: refresh, onError: onErr });
  const remove = useMutation({ mutationFn: (p: PrepItem) => v2.patchPrep(p.id, { deleted: true }), onSuccess: refresh, onError: onErr });
  const setPickup = useMutation({ mutationFn: (b: Parameters<typeof v2.setPickup>[0]) => v2.setPickup(b), onSuccess: refresh, onError: onErr });
  const delExc = useMutation({ mutationFn: (id: string) => v2.deleteException(id), onSuccess: refresh, onError: onErr });

  const [form, setForm] = useState({ date: addDays(today, 1), kind: 'dropoff' as PrepItem['kind'], text: '' });
  const add = useMutation({ mutationFn: () => v2.addPrep(form), onSuccess: async () => { setForm({ ...form, text: '' }); await refresh(); }, onError: onErr });
  const [exc, setExc] = useState({ kind: 'closed' as 'closed' | 'dropoff_time' | 'pickup_time', date: addDays(today, 1), endDate: '', time: '', note: '' });
  const addExc = useMutation({
    mutationFn: () => v2.addException({ kind: exc.kind, date: exc.date, endDate: exc.endDate || undefined, time: exc.kind === 'closed' ? undefined : exc.time, note: exc.note || undefined }),
    onSuccess: async () => { setExc({ ...exc, note: '', time: '', endDate: '' }); await refresh(); }, onError: onErr,
  });

  const kidName = (id: string) => members.data?.children.find((c) => c.id === id)?.displayName ?? '아이';
  const byDate = new Map<string, PrepItem[]>();
  const undated: PrepItem[] = [];
  for (const p of prep.data?.items ?? []) {
    if (!p.date) undated.push(p);
    else byDate.set(p.date, [...(byDate.get(p.date) ?? []), p]);
  }
  const Item = ({ p }: { p: PrepItem }) => (
    <li className={`prep-row${p.doneAt ? ' is-done' : ''}`}>
      <label className="check"><input type="checkbox" checked={Boolean(p.doneAt)} onChange={() => toggle.mutate(p)} aria-label={`${p.text} 챙김`} /> {p.text}</label>
      <small className="muted">{KIND_LABEL[p.kind]}{p.needsReview ? ' · 확인 필요' : ''}{p.noticeId ? <> · <Link to={`/notices/${p.noticeId}`}>{p.noticeTitle ?? '공지'}</Link></> : ''}{p.doneBy ? ` · ${p.doneBy} 확인` : ''}</small>
      <button type="button" className="btn ghost small" onClick={() => remove.mutate(p)} aria-label={`${p.text} 지우기`}>✕</button>
    </li>
  );
  return (
    <div className="stack" data-testid="prep-page">
      <h1>준비물·픽업</h1>
      <section className="card" aria-labelledby="prep-week">
        <h2 id="prep-week">이번 주 준비물</h2>
        {prep.isPending ? <LoadingBlock rows={2} /> : prep.isError ? <ErrorBlock error={prep.error} onRetry={() => void prep.refetch()} /> : (
          <>
            {[...byDate.entries()].map(([d, list]) => (
              <div key={d} className="prep-day"><h3>{shortDateKo(d, today)} <small className="muted">{d}</small></h3><ul className="list">{list.map((p) => <Item key={p.id} p={p} />)}</ul></div>
            ))}
            {undated.length > 0 && <div className="prep-day"><h3>날짜 미정</h3><ul className="list">{undated.map((p) => <Item key={p.id} p={p} />)}</ul></div>}
            {!byDate.size && !undated.length && <p className="muted">이번 주에 챙길 준비물이 없어요.</p>}
          </>
        )}
        <form className="row-form" onSubmit={(e: FormEvent) => { e.preventDefault(); if (form.text.trim()) add.mutate(); }} aria-label="준비물 추가">
          <input type="date" aria-label="날짜" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <select aria-label="종류" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PrepItem['kind'] })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input aria-label="내용" placeholder="예: 여벌옷" maxLength={120} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          <button type="submit" className="btn" disabled={!form.text.trim() || add.isPending}>추가</button>
        </form>
      </section>

      <section className="card" aria-labelledby="prep-pickup">
        <h2 id="prep-pickup">픽업 담당</h2>
        {pickups.isPending ? <LoadingBlock rows={2} /> : pickups.isError ? <ErrorBlock error={pickups.error} /> : !pickups.data.pickups.length ? (
          <p className="muted">등하원 시간을 먼저 정해 주세요. <Link to="/settings#set-commute">설정에서 정하기</Link></p>
        ) : (
          <ul className="list">
            {pickups.data.pickups.filter((p) => p.attends).map((p) => (
              <li key={`${p.date}-${p.childId}`} className="pickup-row" data-testid="pickup-row">
                <strong>{shortDateKo(p.date, today)}</strong> <span>{kidName(p.childId)} · {p.pickupAt} 하원</span>
                <select aria-label={`${p.date} 픽업 담당자`} value={p.assignee ?? ''} onChange={(e) => setPickup.mutate({ date: p.date, childId: p.childId, assignee: e.target.value })}>
                  <option value="">담당자 미정</option>
                  {[...new Set([...(pickups.data.adults ?? []), ...(p.assignee ? [p.assignee] : []), '할머니', '할아버지'])].map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                {!p.assignee && <span className="chip warn">담당자 확인 필요</span>}
                <label className="check"><input type="checkbox" checked={Boolean(p.doneAt)} onChange={(e) => setPickup.mutate({ date: p.date, childId: p.childId, done: e.target.checked })} /> 픽업 완료</label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="prep-exc">
        <h2 id="prep-exc">휴원·시간 변경</h2>
        {commute.data && (
          <ul className="list">
            {commute.data.exceptions.map((e) => (
              <li key={e.id} className="prep-row">
                <span>{e.date}{e.endDate ? `~${e.endDate}` : ''} · {e.kind === 'closed' ? '휴원' : e.kind === 'dropoff_time' ? `등원 ${e.time}` : `하원 ${e.time}`}{e.note ? ` · ${e.note}` : ''}{e.needsReview ? ' · 확인 필요' : ''}</span>
                {e.noticeId ? <Link to={`/notices/${e.noticeId}`}>공지</Link> : <button type="button" className="btn ghost small" onClick={() => delExc.mutate(e.id)} aria-label="변경 지우기">✕</button>}
              </li>
            ))}
            {!commute.data.exceptions.length && <li className="muted">앞으로 한 달 동안 바뀐 일정이 없어요.</li>}
          </ul>
        )}
        <form className="row-form" onSubmit={(e: FormEvent) => { e.preventDefault(); addExc.mutate(); }} aria-label="휴원·시간 변경 추가">
          <select aria-label="변경 종류" value={exc.kind} onChange={(e) => setExc({ ...exc, kind: e.target.value as typeof exc.kind })}>
            <option value="closed">휴원</option><option value="dropoff_time">등원 시간 변경</option><option value="pickup_time">하원 시간 변경</option>
          </select>
          <input type="date" aria-label="날짜" value={exc.date} onChange={(e) => setExc({ ...exc, date: e.target.value })} />
          {exc.kind === 'closed' ? <input type="date" aria-label="끝 날짜(선택)" value={exc.endDate} onChange={(e) => setExc({ ...exc, endDate: e.target.value })} />
            : <input type="time" aria-label="시각" value={exc.time} onChange={(e) => setExc({ ...exc, time: e.target.value })} required />}
          <input aria-label="메모" placeholder="예: 개원기념일" maxLength={120} value={exc.note} onChange={(e) => setExc({ ...exc, note: e.target.value })} />
          <button type="submit" className="btn" disabled={addExc.isPending || (exc.kind !== 'closed' && !exc.time)}>추가</button>
        </form>
      </section>
    </div>
  );
}

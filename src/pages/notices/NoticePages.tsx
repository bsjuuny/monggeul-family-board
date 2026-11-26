// 공지 정리: 목록, 붙여넣기·분석, 상세(확인·수정·삭제·캘린더), 공지톡 가져오기
import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePageTitle, useServices, useSession } from '../../app/context';
import { isFamilyBoardError } from '../../domain/errors';
import { buildDigest, fromGongjitalk } from '../../notices/digest';
import type { NoticeDigest } from '../../notices/types';
import type { Notice, NoticeStatus } from '../../server/v2';
import { ConfirmDialog } from '../../ui/Confirm';
import { ErrorBlock, LoadingBlock } from '../../ui/States';
import { useToast } from '../../ui/Toasts';
import { syncNoticeCalendar } from './calendarLink';
import { usePendingAnalysis } from './usePendingAnalysis';

const STATUS_LABEL: Record<NoticeStatus, string> = {
  needs_review: '확인 필요', pending_analysis: '분석 대기', auto: '자동 표시', confirmed: '확인함', dismissed: '숨김',
};
const SOURCE_LABEL: Record<string, string> = { manual: '붙여넣기', gongjitalk: '공지톡', kidsnote: '키즈노트', mock: '모의 수집' };
const todayKst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const errMsg = (e: unknown, fallback: string) => (isFamilyBoardError(e) ? e.message : fallback);

function useNotices() {
  const { v2 } = useServices();
  return useQuery({ queryKey: ['notices'], queryFn: () => v2.notices() });
}

function StatusChip({ status }: { status: NoticeStatus }) {
  return <span className={`chip notice-status notice-status--${status}`}>{STATUS_LABEL[status]}</span>;
}

// ───────────── 목록 ─────────────
export function NoticesPage() {
  usePageTitle('공지 정리');
  const { v2 } = useServices();
  const q = useNotices();
  const sync = useQuery({ queryKey: ['notice-sync'], queryFn: () => v2.syncStatus() });
  usePendingAnalysis(Boolean(q.data?.notices.some((n) => n.status === 'pending_analysis')));
  const groups = useMemo(() => {
    const all = q.data?.notices ?? [];
    const today = todayKst();
    return {
      review: all.filter((n) => n.status === 'needs_review' || n.status === 'pending_analysis'),
      upcoming: all.filter((n) => (n.status === 'auto' || n.status === 'confirmed') && (n.digest.eventDate ?? '') >= today),
      rest: all.filter((n) => (n.status === 'auto' || n.status === 'confirmed') && (n.digest.eventDate ?? '') < today),
      hidden: all.filter((n) => n.status === 'dismissed'),
    };
  }, [q.data]);
  const section = (title: string, list: Notice[], testid: string) => list.length > 0 && (
    <section className="card" aria-label={title} data-testid={testid}>
      <h2>{title} <span className="count-chip">{list.length}</span></h2>
      <ul className="list notice-list">
        {list.map((n) => (
          <li key={n.id}>
            <Link to={`/notices/${n.id}`} className="notice-row">
              <span className="notice-row__top"><StatusChip status={n.status} />{n.digest.needsReply && <span className="chip">답장 필요</span>}<small>{SOURCE_LABEL[n.source]} · {n.receivedOn} 받음</small></span>
              <strong>{n.title}</strong>
              {n.reviewReasons.length > 0 && <small className="muted">확인할 것: {n.reviewReasons.join(', ')}</small>}
              {n.digest.eventDate && <small className="muted">행사 {n.digest.eventDate}{n.digest.eventTime ? ` ${n.digest.eventTime}` : ''}</small>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <div className="stack" data-testid="notices-page">
      <h1>공지 정리</h1>
      <div className="btn-row">
        <Link className="btn" to="/notices/new">공지 붙여넣기</Link>
        <Link className="btn secondary" to="/notices/import">공지톡에서 가져오기</Link>
      </div>
      {sync.data && (
        <p className="banner sync" data-testid="sync-status">
          {sync.data.adapter.available
            ? `${sync.data.adapter.name} 자동 수집 ${sync.data.settings.enabled ? '켜짐' : '꺼짐'}${sync.data.state.lastOkAt ? ` · 마지막 ${new Date(sync.data.state.lastOkAt).toLocaleString('ko-KR')}` : ''}`
            : sync.data.adapter.reason}
        </p>
      )}
      {q.isPending ? <LoadingBlock /> : q.isError ? <ErrorBlock error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          {!q.data.notices.length && <p className="muted">아직 정리한 공지가 없어요. 어린이집 공지를 붙여넣어 보세요.</p>}
          {section('확인이 필요한 공지', groups.review, 'notices-review')}
          {section('다가오는 공지', groups.upcoming, 'notices-upcoming')}
          {section('지난 공지', groups.rest, 'notices-rest')}
          {section('숨긴 공지', groups.hidden, 'notices-hidden')}
        </>
      )}
    </div>
  );
}

// ───────────── 요약 편집 ─────────────
type Lines<T> = T[];
function ListEditor<T extends { text: string; date: string | null }>({ label, items, onChange, extra, make, dateLabel = '날짜' }: {
  label: string; items: Lines<T>; onChange: (v: Lines<T>) => void; extra?: (it: T, set: (p: Partial<T>) => void) => ReactNode; make: () => T; dateLabel?: string;
}) {
  return (
    <fieldset className="digest-list">
      <legend>{label}</legend>
      {items.map((it, i) => {
        const set = (p: Partial<T>) => onChange(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
        return (
          <div key={i} className="digest-line">
            <input aria-label={`${label} ${i + 1} 내용`} value={it.text} maxLength={120} onChange={(e) => set({ text: e.target.value } as Partial<T>)} />
            <input aria-label={`${label} ${i + 1} ${dateLabel}`} type="date" value={it.date ?? ''} onChange={(e) => set({ date: e.target.value || null } as Partial<T>)} />
            {extra?.(it, set)}
            <button type="button" className="btn ghost small" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`${label} ${i + 1} 지우기`}>✕</button>
          </div>
        );
      })}
      <button type="button" className="btn ghost small" onClick={() => onChange([...items, make()])}>+ {label} 추가</button>
    </fieldset>
  );
}

function ChangeEditor({ label, value, onChange, withEnd, withTime = true }: { label: string; value: NoticeDigest['dropoffChange']; onChange: (v: NoticeDigest['dropoffChange']) => void; withEnd?: boolean; withTime?: boolean }) {
  const on = value !== null;
  return (
    <fieldset className="digest-list">
      <legend>{label}</legend>
      <label className="check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? { date: todayKst(), time: withTime ? '09:00' : null, text: label } : null)} /> {label} 있음</label>
      {value && (
        <div className="digest-line">
          <input aria-label={`${label} 날짜`} type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />
          {withEnd && <input aria-label={`${label} 끝 날짜`} type="date" value={value.endDate ?? ''} onChange={(e) => onChange({ ...value, endDate: e.target.value || null })} />}
          {withTime && <input aria-label={`${label} 시각`} type="time" value={value.time ?? ''} onChange={(e) => onChange({ ...value, time: e.target.value || null })} />}
          <input aria-label={`${label} 설명`} value={value.text} maxLength={120} onChange={(e) => onChange({ ...value, text: e.target.value })} />
        </div>
      )}
    </fieldset>
  );
}

export function DigestEditor({ value, onChange }: { value: NoticeDigest; onChange: (d: NoticeDigest) => void }) {
  const set = (p: Partial<NoticeDigest>) => onChange({ ...value, ...p });
  return (
    <div className="stack digest-editor" data-testid="digest-editor">
      <div className="field"><label htmlFor="dg-title">제목</label><input id="dg-title" value={value.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} /></div>
      <div className="row2">
        <div className="field"><label htmlFor="dg-date">행사 날짜</label><input id="dg-date" type="date" value={value.eventDate ?? ''} onChange={(e) => set({ eventDate: e.target.value || null, dateConfidence: e.target.value ? 'exact' : 'unknown' })} /></div>
        <div className="field"><label htmlFor="dg-time">행사 시각</label><input id="dg-time" type="time" value={value.eventTime ?? ''} onChange={(e) => set({ eventTime: e.target.value || null })} /></div>
      </div>
      {value.dateConfidence === 'inferred' && <p className="banner warn" role="note">날짜가 확실하지 않아요(요일이 맞지 않거나 요일만 적혀 있어요). 확인해 주세요.</p>}
      <ListEditor label="준비물" items={value.supplies} onChange={(supplies) => set({ supplies })} make={() => ({ text: '', date: value.eventDate, for: 'dropoff' as const })}
        extra={(it, s) => (
          <select aria-label="언제 챙기나요" value={it.for} onChange={(e) => s({ for: e.target.value as typeof it.for })}>
            <option value="dropoff">등원 때</option><option value="pickup">하원 때</option><option value="event">행사 때</option><option value="unspecified">미정</option>
          </select>
        )} />
      <ListEditor label="복장" items={value.clothing} onChange={(clothing) => set({ clothing })} make={() => ({ text: '', date: value.eventDate })} />
      <ListEditor label="제출 서류" dateLabel="기한" items={value.documents} onChange={(documents) => set({ documents })} make={() => ({ text: '', date: null })} />
      <ListEditor label="보호자 할 일" dateLabel="기한" items={value.parentTasks} onChange={(parentTasks) => set({ parentTasks })} make={() => ({ text: '', date: null })} />
      <ChangeEditor label="등원 시간 변경" value={value.dropoffChange} onChange={(dropoffChange) => set({ dropoffChange })} />
      <ChangeEditor label="하원 시간 변경" value={value.pickupChange} onChange={(pickupChange) => set({ pickupChange: pickupChange ? { ...pickupChange, early: pickupChange.early ?? true } : null })} />
      <ChangeEditor label="휴원" value={value.closure} withEnd withTime={false} onChange={(closure) => set({ closure })} />
      <label className="check"><input type="checkbox" checked={value.needsReply} onChange={(e) => set({ needsReply: e.target.checked, replyText: e.target.checked ? value.replyText || '선생님께 답장하기' : '' })} /> 선생님께 답장 필요</label>
      {value.needsReply && <div className="field"><label htmlFor="dg-reply">답장 내용</label><input id="dg-reply" value={value.replyText} maxLength={120} onChange={(e) => set({ replyText: e.target.value })} /></div>}
    </div>
  );
}

function DigestView({ d }: { d: NoticeDigest }) {
  const rows: Array<[string, ReactNode]> = [];
  if (d.eventDate) rows.push(['행사', `${d.eventDate}${d.eventEndDate ? ` ~ ${d.eventEndDate}` : ''}${d.eventTime ? ` ${d.eventTime}` : ''}`]);
  if (d.supplies.length) rows.push(['준비물', d.supplies.map((s) => `${s.text}${s.date ? `(${s.date.slice(5)})` : ''}`).join(', ')]);
  if (d.clothing.length) rows.push(['복장', d.clothing.map((s) => s.text).join(', ')]);
  if (d.documents.length) rows.push(['제출', d.documents.map((s) => `${s.text}${s.date ? ` (~${s.date.slice(5)})` : ''}`).join(' / ')]);
  if (d.parentTasks.length) rows.push(['할 일', d.parentTasks.map((s) => `${s.text}${s.date ? ` (~${s.date.slice(5)})` : ''}`).join(' / ')]);
  if (d.fees.length) rows.push(['비용', d.fees.join(', ')]);
  if (d.dropoffChange) rows.push(['등원 변경', `${d.dropoffChange.date} ${d.dropoffChange.time ?? ''}`]);
  if (d.pickupChange) rows.push(['하원 변경', `${d.pickupChange.date} ${d.pickupChange.time ?? ''}${d.pickupChange.early ? ' (조기)' : ''}`]);
  if (d.closure) rows.push(['휴원', `${d.closure.date}${d.closure.endDate ? ` ~ ${d.closure.endDate}` : ''}`]);
  if (d.needsReply) rows.push(['답장', d.replyText]);
  if (d.needsConfirmation.length) rows.push(['다시 볼 것', d.needsConfirmation.join(' / ')]);
  return (
    <dl className="kv digest-view">
      {rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
      {!rows.length && <><dt>내용</dt><dd className="muted">뽑아낸 항목이 없어요. 수정해서 직접 넣어 주세요.</dd></>}
    </dl>
  );
}

// ───────────── 붙여넣기 ─────────────
export function NoticeNewPage() {
  usePageTitle('공지 붙여넣기');
  const { v2 } = useServices();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [received, setReceived] = useState(todayKst());
  const [draft, setDraft] = useState<{ digest: NoticeDigest; hash: string } | null>(null);
  const save = useMutation({
    mutationFn: () => v2.createNotice({ source: 'manual', receivedOn: received, contentHash: draft!.hash, digest: draft!.digest, originalText: text }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['notices'] });
      await qc.invalidateQueries({ queryKey: ['board'] });
      toast.info(r.duplicate ? '이미 저장된 공지예요. 저장된 공지를 열게요.' : r.masked ? `공지를 저장했어요. 개인정보 ${r.masked}곳을 ○○로 가렸어요.` : '공지를 저장했어요.');
      navigate(`/notices/${r.notice.id}`, { replace: true });
    },
    onError: (e) => toast.error(errMsg(e, '저장하지 못했어요.')),
  });
  return (
    <div className="stack" data-testid="notice-new">
      <h1>공지 붙여넣기</h1>
      <p className="muted">어린이집 공지·알림장 글을 붙여넣으면 날짜·준비물·등하원 변경을 정리해요. 분석은 이 기기에서 하고, 원문은 설정에서 켠 경우에만 저장해요. 저장할 때 전화번호·이메일과 설정의 '가릴 이름'은 ○○로 바꿔요.</p>
      <div className="field"><label htmlFor="nt-text">공지 내용</label><textarea id="nt-text" rows={8} value={text} onChange={(e) => { setText(e.target.value); setDraft(null); }} /></div>
      <div className="field"><label htmlFor="nt-recv">공지를 받은 날 ("내일" 같은 말의 기준)</label><input id="nt-recv" type="date" value={received} onChange={(e) => { setReceived(e.target.value); setDraft(null); }} /></div>
      <div className="btn-row">
        <button type="button" className="btn" disabled={text.trim().length < 5} onClick={() => { const r = buildDigest(text, received); setDraft({ digest: r.digest, hash: r.contentHash }); }}>분석하기</button>
        <Link className="btn ghost" to="/notices">취소</Link>
      </div>
      {draft && (
        <section className="card" aria-label="분석 결과">
          <h2>분석 결과 확인</h2>
          <p className="muted">틀린 곳은 고친 뒤 저장해 주세요. 시간 변경·휴원·제출·납부·애매한 날짜가 있으면 저장 후에도 '확인 필요'로 남아요.</p>
          <DigestEditor value={draft.digest} onChange={(digest) => setDraft({ ...draft, digest })} />
          <button type="button" className="btn" disabled={save.isPending || !draft.digest.title.trim()} onClick={() => save.mutate()}>{save.isPending ? '저장 중…' : '저장'}</button>
        </section>
      )}
    </div>
  );
}

// ───────────── 상세 ─────────────
export function NoticeDetailPage() {
  const { id = '' } = useParams();
  const { v2, repo } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['notices', id], queryFn: () => v2.notice(id) });
  usePageTitle(q.data?.title ?? '공지');
  const [editing, setEditing] = useState<NoticeDigest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState<Array<{ at: string; actor: string; action: string }> | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['notices'] });
    await qc.invalidateQueries({ queryKey: ['board'] });
    await qc.invalidateQueries({ queryKey: ['data'] });
  };
  const calendar = async (createMissing: boolean, summary = '') => {
    try {
      const r = await syncNoticeCalendar(v2, repo, id, createMissing);
      const parts = [r.created && `${r.created}개 추가`, r.updated && `${r.updated}개 갱신`, r.removed && `${r.removed}개 삭제`].filter(Boolean);
      const message = [summary, parts.length ? `캘린더 일정을 ${parts.join(', ')}했어요.` : '', r.keptUserEdits ? '직접 고친 일정은 그대로 두었어요.' : ''].filter(Boolean).join(' ');
      if (message) toast.info(message);
    } catch (e) {
      toast.error([summary, errMsg(e, '캘린더에 반영하지 못했어요.')].filter(Boolean).join(' '));
    }
  };
  const act = useMutation({
    mutationFn: async (kind: 'confirm' | 'dismiss' | 'save' | 'delete') => {
      const n = q.data as Notice;
      if (kind === 'confirm') return v2.confirmNotice(n.id, n.version);
      if (kind === 'dismiss') return v2.confirmNotice(n.id, n.version, true);
      if (kind === 'save') return v2.updateNotice(n.id, n.version, editing as NoticeDigest);
      // 캘린더 정리를 먼저 한다. 실패하면 공지를 지우지 않는다(연결 일정이 고아로 남지 않게)
      try {
        await syncNoticeCalendar(v2, repo, n.id, false, true);
      } catch {
        throw new Error('CALENDAR_CLEANUP');
      }
      await v2.deleteNotice(n.id);
      return null;
    },
    onSuccess: async (_r, kind) => {
      await refresh();
      if (kind === 'delete') { toast.info('공지를 지웠어요.'); navigate('/notices', { replace: true }); return; }
      if (kind === 'save') { setEditing(null); await calendar(true, '고친 내용을 저장했어요.'); }
      if (kind === 'confirm') await calendar(true, '공지를 확인했어요.');
      if (kind === 'dismiss') await calendar(false);
    },
    onError: async (e) => {
      if (e instanceof Error && e.message === 'CALENDAR_CLEANUP') {
        toast.error('캘린더 일정을 정리하지 못해 공지를 지우지 않았어요. 연결 상태를 확인한 뒤 다시 시도해 주세요.');
        return;
      }
      if (isFamilyBoardError(e) && e.code === 'VERSION_CONFLICT') {
        // 다른 기기가 먼저 바꿨다: 내 편집안으로 덮어쓰지 않도록 편집을 닫고 최신 내용을 다시 보여 준다
        setEditing(null);
        await q.refetch();
        toast.error('다른 기기에서 이 공지를 먼저 바꿨어요. 바뀐 내용을 확인한 뒤 다시 고쳐 주세요.');
        return;
      }
      toast.error(errMsg(e, '처리하지 못했어요.'));
    },
  });
  if (q.isPending) return <LoadingBlock />;
  if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
  const n = q.data;
  return (
    <div className="stack" data-testid="notice-detail">
      <Link className="back-link" to="/notices">← 공지 목록</Link>
      <h1>{n.title}</h1>
      <p className="notice-row__top"><StatusChip status={n.status} /><small>{SOURCE_LABEL[n.source]} · {n.receivedOn} 받음{n.editedByUser ? ' · 보호자가 고침' : ''}</small></p>
      {n.reviewReasons.length > 0 && n.status === 'needs_review' && <p className="banner warn" role="note">확인할 것: {n.reviewReasons.join(', ')}. 내용을 보고 '확인'을 눌러 주세요.</p>}
      {editing ? (
        <section className="card">
          <DigestEditor value={editing} onChange={setEditing} />
          <div className="btn-row">
            <button type="button" className="btn" disabled={act.isPending || !editing.title.trim()} onClick={() => act.mutate('save')}>저장</button>
            <button type="button" className="btn ghost" onClick={() => setEditing(null)}>취소</button>
          </div>
        </section>
      ) : (
        <section className="card"><DigestView d={n.digest} /></section>
      )}
      {!editing && (
        <>
        <div className="btn-row">
          {(n.status === 'needs_review' || n.status === 'auto') && <button type="button" className="btn" disabled={act.isPending} onClick={() => act.mutate('confirm')} data-testid="notice-confirm">확인</button>}
          {n.status !== 'pending_analysis' && <button type="button" className="btn secondary" onClick={() => setEditing(structuredClone(n.digest))}>수정</button>}
          {n.status !== 'dismissed' && n.status !== 'pending_analysis' && <button type="button" className="btn ghost" disabled={act.isPending} onClick={() => act.mutate('dismiss')}>보드에서 숨기기</button>}
          {n.status === 'confirmed' && <button type="button" className="btn ghost" onClick={() => void calendar(true)}>캘린더에 반영</button>}
          <button type="button" className="btn ghost" onClick={() => void v2.noticeHistory(n.id).then((h) => setHistory(h.history))}>기록</button>
          {n.hasOriginal && <button type="button" className="btn ghost" onClick={() => void v2.notice(n.id, true).then((x) => setOriginal(x.originalText ?? ''))}>원문</button>}
        </div>
        <div className="notice-detail__delete">
          <button type="button" className="btn ghost" disabled={act.isPending} onClick={() => setConfirmDelete(true)}>삭제</button>
        </div>
        </>
      )}
      {original !== null && <section className="card"><h2>원문</h2><p style={{ whiteSpace: 'pre-wrap' }}>{original}</p></section>}
      {history && (
        <section className="card"><h2>기록</h2>
          <ul className="list">{history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString('ko-KR')} · {h.actor} · {({ create: '저장', edit: '수정', edit_before: '수정 전', confirmed: '확인', dismissed: '숨김', delete: '삭제', analyzed: '분석', source_update: '원본 갱신', source_changed: '원본 바뀜(보호자 수정 유지)' } as Record<string, string>)[h.action] ?? h.action}</li>)}</ul>
        </section>
      )}
      {confirmDelete && <ConfirmDialog title="공지를 지울까요?" message="공지와 여기서 만든 준비물·등하원 변경이 보드에서 사라져요. 이 공지로 캘린더에 넣은 일정도 지워요(캘린더에서 직접 고친 일정은 남겨요)." confirmLabel="지우기" danger busy={act.isPending}
        onConfirm={() => act.mutate('delete')} onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}

// ───────────── 공지톡 가져오기 ─────────────
export function NoticeImportPage() {
  usePageTitle('공지톡에서 가져오기');
  const { v2 } = useServices();
  const { isOwner } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [bad, setBad] = useState(0);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [raw, setRaw] = useState<unknown[] | null>(null);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof v2.importNotices>> | null>(null);
  const [done, setDone] = useState<Awaited<ReturnType<typeof v2.importNotices>> | null>(null);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const request = useRef(0);

  const resetPreview = () => {
    setError('');
    setPreview(null);
    setDone(null);
    setItems([]);
    setBad(0);
    setPreviewing(true);
  };
  const prepare = async (list: unknown[], keep: boolean, id: number) => {
    try {
      const conv = list.map((x) => fromGongjitalk(x, keep));
      const ok = conv.filter((c): c is { ok: true; body: Record<string, unknown> } => c.ok).map((c) => c.body);
      const next = ok.length ? await v2.importNotices(ok, true) : null;
      if (request.current !== id) return;
      setPreview(next);
      setItems(ok);
      setBad(conv.length - ok.length);
    } catch (e) {
      if (request.current === id) setError(errMsg(e, '미리보기를 만들지 못했어요.'));
    } finally {
      if (request.current === id) setPreviewing(false);
    }
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    e.target.value = '';
    const id = ++request.current;
    setFileName(f.name);
    setRaw(null);
    resetPreview();
    try {
      const data = JSON.parse(await f.text()) as unknown;
      if (request.current !== id) return;
      const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { notices?: unknown }).notices) ? (data as { notices: unknown[] }).notices : null;
      if (!list) throw new Error('shape');
      if (!list.length) {
        setError('파일에 옮길 공지가 없어요. 공지톡 저장함에서 다시 내보내 주세요.');
        setPreviewing(false);
        return;
      }
      setRaw(list);
      await prepare(list, keepOriginal, id);
    } catch {
      if (request.current !== id) return;
      setError('공지톡 저장함에서 받은 JSON 파일을 다시 골라 주세요.');
      setPreviewing(false);
    }
  };
  const commit = useMutation({
    mutationFn: () => v2.importNotices(items, false),
    onSuccess: async (r) => {
      setDone(r);
      await qc.invalidateQueries({ queryKey: ['notices'] });
      await qc.invalidateQueries({ queryKey: ['board'] });
      toast.info(`${r.summary.created ?? 0}건을 가져왔어요.`);
    },
    onError: (e) => toast.error(errMsg(e, '가져오지 못했어요. 원래 데이터는 그대로예요.')),
  });
  const result = done ?? preview;
  return (
    <div className="stack" data-testid="notice-import">
      <Link className="back-link" to="/notices">← 공지 목록</Link>
      <header className="notice-import-intro">
        <h1>공지톡에서 가져오기</h1>
        <p>공지톡 <strong>저장함 → 내보내기</strong>에서 받은 파일을 골라 주세요.</p>
      </header>
      <div className="notice-import-file">
        <label className="btn secondary notice-import-file__button" htmlFor="imp-file">
          {fileName ? '다른 파일 선택' : '공지톡 파일 선택'}
          <input id="imp-file" type="file" aria-label="내보내기 파일" accept="application/json,.json" disabled={commit.isPending} onChange={(e) => void onFile(e)} />
        </label>
        <span className="notice-import-file__name" aria-live="polite">{fileName || '선택한 파일이 없어요'}</span>
      </div>
      {isOwner && <label className="check"><input type="checkbox" checked={keepOriginal} disabled={previewing || commit.isPending} onChange={(e) => {
        const keep = e.target.checked;
        setKeepOriginal(keep);
        if (raw) {
          resetPreview();
          void prepare(raw, keep, ++request.current);
        }
      }} /> 공지 원문도 저장하기</label>}
      <p className="muted">기본으로 요약만 가져와요. ‘내일’ 같은 날짜는 공지톡에서 분석한 날을 기준으로 계산하니 미리보기에서 확인해 주세요.</p>
      {previewing && <p role="status">미리보기를 만드는 중이에요…</p>}
      {!result && bad > 0 && <p className="err" role="alert">가져올 수 있는 공지가 없어요. 형식 오류 {bad}건이에요.</p>}
      {error && <p className="err" role="alert">{error}</p>}
      {result && (
        <section className="card notice-import-preview" aria-label="가져오기 미리보기">
          <h2>{done ? '가져오기 결과' : '미리보기'}</h2>
          <p className="notice-import-summary">{done ? `새로 ${done.summary.created ?? 0}건` : `새 공지 ${result.summary.new ?? 0}건`} · 이미 있음 {result.summary.duplicate ?? 0}건 · 형식 오류 {(result.summary.invalid ?? 0) + bad}건</p>
          <ul className="list">{result.results.map((r) => {
            const digest = items[r.index]?.digest as NoticeDigest | undefined;
            return <li key={r.index} className="notice-import-result">
              <span className="chip">{({ new: '새 공지', created: '가져옴', duplicate: '이미 있음', invalid: '건너뜀' } as Record<string, string>)[r.status]}</span>
              <span>{r.title ?? r.error}{r.status !== 'invalid' && digest?.eventDate && <small className="muted">{digest.eventDate}{digest.eventTime ? ` ${digest.eventTime}` : ''}</small>}</span>
            </li>;
          })}</ul>
          <div className="notice-import-actions">
            {done ? <Link className="btn secondary" to="/notices">가져온 공지 보기</Link> : <button type="button" className="btn" disabled={commit.isPending || !(result.summary.new ?? 0)} onClick={() => commit.mutate()}>{commit.isPending ? '가져오는 중…' : `${result.summary.new ?? 0}건 가져오기`}</button>}
          </div>
        </section>
      )}
    </div>
  );
}

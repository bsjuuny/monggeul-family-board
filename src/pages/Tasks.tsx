import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { friendlyMessage, isFamilyBoardError } from '../domain/errors';
import { isoToZoned, todayIn, zonedToIso } from '../domain/dates';
import type { AssigneeType, Task, TaskKind } from '../domain/types';
import { validateTaskInput } from '../domain/validation';
import { newId } from '../lib/crypto';
import { dkey, useOnline, usePageTitle, useServices, useSession } from '../app/context';
import { useToggleTask } from '../app/offlineHooks';
import { nameOf, useMembers, useTasks } from '../app/queries';
import { ConfirmDialog } from '../ui/Confirm';
import { Modal } from '../ui/Modal';
import { EmptyBlock, OfflineReason, QueryView } from '../ui/States';
import { useToast } from '../ui/Toasts';

type Assignee = { id: string; type: AssigneeType } | null;

function parseAssignee(v: string): Assignee {
  if (!v) return null;
  const [type, id] = v.split(':') as [AssigneeType, string];
  return { type, id };
}

export function TaskForm({ initial, kind, onClose }: { initial?: Task; kind: TaskKind; onClose: () => void }) {
  const { repo } = useServices();
  const { ns, tz } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const members = useMembers();
  const [k, setK] = useState<TaskKind>(initial?.kind ?? kind);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [assignee, setAssignee] = useState(initial?.assigneeId ? `${initial.assigneeType}:${initial.assigneeId}` : '');
  const [due, setDue] = useState(initial?.dueAt ? isoToZoned(initial.dueAt, tz).date : '');
  const [quantity, setQuantity] = useState(initial?.quantity != null ? String(initial.quantity) : '');
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const key = useRef(newId()); // 같은 폼에서 두 번 눌러도 같은 key → 중복 생성 없음

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const a = parseAssignee(assignee);
    const input = {
      kind: k,
      title,
      assigneeId: a?.id ?? null,
      assigneeType: a?.type ?? null,
      quantity: k === 'shopping' && quantity.trim() !== '' ? Number(quantity) : null,
      unit: k === 'shopping' && unit.trim() !== '' ? unit : null,
      dueAt: k === 'todo' && due ? zonedToIso(due, '23:59', tz) : null,
    };
    try {
      validateTaskInput(input);
    } catch (err) {
      setError({ field: isFamilyBoardError(err) ? (err.details.field as string | undefined) : undefined, message: friendlyMessage(err) });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (initial) await repo.updateTask(initial.id, initial.version, input);
      else await repo.createTask(input, key.current);
      await qc.invalidateQueries({ queryKey: dkey(ns, 'tasks') });
      toast.info(initial ? '할 일을 수정했어요.' : k === 'shopping' ? '장보기 항목을 추가했어요.' : '할 일을 추가했어요.');
      onClose();
    } catch (err) {
      if (isFamilyBoardError(err) && err.code === 'VERSION_CONFLICT') {
        await qc.invalidateQueries({ queryKey: dkey(ns, 'tasks') });
        setError({ message: '다른 사람이 먼저 수정했어요. 목록을 새로 불러왔으니 닫고 다시 열어 주세요.' });
      } else setError({ message: friendlyMessage(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const fe = (f: string) => (error?.field === f ? error.message : undefined);
  const gen = error && !error.field ? error.message : undefined;
  return (
    <Modal title={initial ? '할 일 수정' : k === 'shopping' ? '장보기 추가' : '할 일 추가'} onClose={onClose} busy={busy}>
      <form onSubmit={submit} noValidate>
        {!initial && (
          <fieldset>
            <legend>종류</legend>
            <div className="seg" role="group" aria-label="종류">
              <button type="button" aria-pressed={k === 'todo'} onClick={() => setK('todo')}>
                할 일
              </button>
              <button type="button" aria-pressed={k === 'shopping'} onClick={() => setK('shopping')}>
                장보기
              </button>
            </div>
          </fieldset>
        )}
        <div className="field">
          <label htmlFor="task-title">제목 (1~120자)</label>
          <input id="task-title" data-autofocus type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={fe('title') ? true : undefined} aria-describedby={fe('title') ? 'task-title-err' : undefined} />
          {fe('title') && <span id="task-title-err" className="err">{fe('title')}</span>}
        </div>
        <div className="field">
          <label htmlFor="task-assignee">담당</label>
          <select id="task-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">정하지 않음</option>
            {members.data?.adults.map((a) => (
              <option key={a.userId} value={`adult:${a.userId}`}>
                {a.displayName} (성인)
              </option>
            ))}
            {members.data?.children
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={`child:${c.id}`}>
                  {c.displayName} (아이)
                </option>
              ))}
          </select>
        </div>
        {k === 'todo' ? (
          <div className="field">
            <label htmlFor="task-due">마감일 (선택)</label>
            <input id="task-due" type="date" value={due} min={todayIn(tz)} onChange={(e) => setDue(e.target.value)} aria-invalid={fe('dueAt') ? true : undefined} />
            {fe('dueAt') && <span className="err">{fe('dueAt')}</span>}
          </div>
        ) : (
          <div className="row2">
            <div className="field">
              <label htmlFor="task-qty">수량</label>
              <input id="task-qty" type="number" inputMode="decimal" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-invalid={fe('quantity') ? true : undefined} />
              {fe('quantity') && <span className="err">{fe('quantity')}</span>}
            </div>
            <div className="field">
              <label htmlFor="task-unit">단위</label>
              <input id="task-unit" type="text" maxLength={10} placeholder="개, 팩…" value={unit} onChange={(e) => setUnit(e.target.value)} aria-invalid={fe('unit') ? true : undefined} />
              {fe('unit') && <span className="err">{fe('unit')}</span>}
            </div>
          </div>
        )}
        {gen && (
          <p className="err" role="alert" style={{ color: 'var(--bad)', fontWeight: 600 }}>
            {gen}
          </p>
        )}
        <OfflineReason show={!online}>오프라인이에요. 서버에 연결되어야 저장할 수 있어요.</OfflineReason>
        <div className="btn-row">
          <button type="submit" className="btn" disabled={busy || !online}>
            {busy ? '저장 중…' : '저장'}
          </button>
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TaskRow({ task, onEdit, onDelete, compact = false }: { task: Task; onEdit?: (t: Task) => void; onDelete?: (t: Task) => void; compact?: boolean }) {
  const { tz } = useSession();
  const { toggle, busy } = useToggleTask();
  const members = useMembers();
  const online = useOnline();
  const done = task.completedAt !== null;
  const who = nameOf(members.data, task.assigneeId, task.assigneeType);
  return (
    <li data-testid="task-row">
      <label className="check grow">
        <input type="checkbox" checked={done} disabled={busy.has(task.id)} onChange={(e) => void toggle(task, e.target.checked)} />
        <span style={done ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>
          {task.title}
          {task.kind === 'shopping' && task.quantity != null && (
            <span className="muted">
              {' '}
              · {task.quantity}
              {task.unit ?? ''}
            </span>
          )}
        </span>
      </label>
      {compact ? (
        // 홈 카드: 담당자(없으면 기한) 하나만 작게
        !done && (who || task.dueAt) && <span className="chip mini">{who ? who : `~${isoToZoned(task.dueAt as string, tz).date.slice(5).replace('-', '/')}`}</span>
      ) : (
        <>
          {who && <span className="chip">👤 {who}</span>}
          {task.dueAt && <span className="chip">⏰ {isoToZoned(task.dueAt, tz).date.slice(5).replace('-', '/')}까지</span>}
          {done && <span className="chip ok">✔ 완료</span>}
        </>
      )}
      {onEdit && (
        <button type="button" className="btn ghost small" onClick={() => onEdit(task)} disabled={!online} aria-label={`${task.title} 수정`}>
          수정
        </button>
      )}
      {onDelete && (
        <button type="button" className="btn ghost small" onClick={() => onDelete(task)} disabled={!online} aria-label={`${task.title} 삭제`}>
          삭제
        </button>
      )}
    </li>
  );
}

export function TasksPage() {
  usePageTitle('할 일 · 장보기');
  const { repo } = useServices();
  const { ns } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const members = useMembers();
  const [kind, setKind] = useState<TaskKind>('todo');
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open');
  const [who, setWho] = useState('');
  const [form, setForm] = useState<{ task?: Task } | null>(null);
  const [del, setDel] = useState<Task | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const q = useTasks({ kind }, `page-${kind}`);

  async function doDelete() {
    if (!del) return;
    setDelBusy(true);
    try {
      await repo.deleteTask(del.id, del.version);
      await qc.invalidateQueries({ queryKey: dkey(ns, 'tasks') });
      toast.info('삭제했어요.');
      setDel(null);
    } catch (e) {
      toast.error(friendlyMessage(e));
      await qc.invalidateQueries({ queryKey: dkey(ns, 'tasks') });
      setDel(null);
    } finally {
      setDelBusy(false);
    }
  }

  const filter = (list: Task[]) =>
    list
      .filter((t) => (status === 'all' ? true : status === 'done' ? t.completedAt !== null : t.completedAt === null))
      .filter((t) => (who ? t.assigneeId === who : true))
      .sort((a, b) => Number(a.completedAt !== null) - Number(b.completedAt !== null));

  return (
    <div className="stack">
      <div className="cal-head">
        <h1 className="title" style={{ marginBottom: 0, marginRight: 'auto' }}>
          할 일 · 장보기
        </h1>
        <button type="button" className="btn" onClick={() => setForm({})} disabled={!online} aria-disabled={!online}>
          ＋ {kind === 'shopping' ? '장보기 추가' : '할 일 추가'}
        </button>
      </div>
      <OfflineReason show={!online}>오프라인이에요. 서버에 연결되어야 저장할 수 있어요.</OfflineReason>
      <div className="btn-row">
        <div className="seg" role="group" aria-label="종류">
          <button type="button" aria-pressed={kind === 'todo'} onClick={() => setKind('todo')}>
            할 일
          </button>
          <button type="button" aria-pressed={kind === 'shopping'} onClick={() => setKind('shopping')}>
            장보기
          </button>
        </div>
        <div className="seg" role="group" aria-label="상태">
          {(
            [
              ['open', '미완료'],
              ['done', '완료'],
              ['all', '전체'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={status === v} onClick={() => setStatus(v)}>
              {l}
            </button>
          ))}
        </div>
        <div className="field" style={{ margin: 0, minWidth: 160 }}>
          <label htmlFor="who-filter" className="sr-only">
            담당 필터
          </label>
          <select id="who-filter" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">담당 전체</option>
            {members.data?.adults.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.displayName}
              </option>
            ))}
            {members.data?.children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <QueryView
        q={q}
        isEmpty={(d) => filter(d).length === 0}
        empty={
          <EmptyBlock icon={kind === 'shopping' ? '🛒' : '📝'} title={kind === 'shopping' ? '장볼 것이 없어요' : '할 일이 없어요'} hint={status === 'open' ? '새 항목을 추가해 보세요.' : '조건에 맞는 항목이 없어요.'} />
        }
      >
        {(d) => (
          <ul className="list" aria-label={kind === 'shopping' ? '장보기 목록' : '할 일 목록'}>
            {filter(d).map((t) => (
              <TaskRow key={t.id} task={t} onEdit={(x) => setForm({ task: x })} onDelete={setDel} />
            ))}
          </ul>
        )}
      </QueryView>
      {form && <TaskForm initial={form.task} kind={kind} onClose={() => setForm(null)} />}
      {del && <ConfirmDialog title="삭제할까요?" message={`"${del.title}" 항목을 삭제해요. 되돌릴 수 없어요.`} confirmLabel="삭제" danger busy={delBusy} onConfirm={() => void doDelete()} onClose={() => setDel(null)} />}
    </div>
  );
}

import { useCallback, useRef, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { FamilyBoardError, friendlyMessage } from '../domain/errors';
import type { HabitRecord, HabitWithRecord, Task } from '../domain/types';
import { newId } from '../lib/crypto';
import { useToast } from '../ui/Toasts';
import { dkey, useOnline, useServices, useSession } from './context';

function patchTask(qc: QueryClient, ns: string, id: string, completed: boolean, ts: string) {
  qc.setQueriesData<Task[]>({ queryKey: dkey(ns, 'tasks') }, (old) =>
    Array.isArray(old) ? old.map((t) => (t.id === id ? { ...t, completedAt: completed ? ts : null, clientTimestamp: ts } : t)) : old,
  );
}

type Snapshot = Array<[readonly unknown[], unknown]>;
const snap = (qc: QueryClient, key: readonly unknown[]): Snapshot => qc.getQueriesData({ queryKey: key }) as Snapshot;
const restore = (qc: QueryClient, s: Snapshot) => s.forEach(([k, v]) => qc.setQueryData(k, v));

/** 할 일 완료/취소: 낙관적 갱신 → 실패 롤백 (서버에 저장되지 않으면 되돌리고 알린다) */
export function useToggleTask() {
  const { repo, queryClient: qc } = useServices();
  const { ns } = useSession();
  const online = useOnline();
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const inflight = useRef(new Set<string>());

  const toggle = useCallback(
    async (task: Task, completed: boolean) => {
      if (inflight.current.has(task.id)) return;
      inflight.current.add(task.id);
      setBusy(new Set(inflight.current));
      const ts = new Date().toISOString();
      const key = newId();
      const before = snap(qc, dkey(ns, 'tasks'));
      patchTask(qc, ns, task.id, completed, ts);
      try {
        // 서버가 없으면 저장하지 않고 오류를 보여 준다 (로컬 대기열/조용한 fallback 없음)
        if (!online) throw new FamilyBoardError('NETWORK_ERROR', '네트워크에 연결되어 있지 않아요.');
        await repo.setTaskCompleted(task.id, completed, ts, key);
        void qc.invalidateQueries({ queryKey: dkey(ns, 'tasks') });
      } catch (e) {
        restore(qc, before);
        toast.error(`변경하지 못해 되돌렸어요. ${friendlyMessage(e)}`);
      } finally {
        inflight.current.delete(task.id);
        setBusy(new Set(inflight.current));
      }
    },
    [repo, qc, ns, online, toast],
  );
  return { toggle, busy };
}

function patchHabit(qc: QueryClient, ns: string, habitId: string, date: string, ts: string) {
  qc.setQueriesData<HabitWithRecord[]>({ queryKey: dkey(ns, 'habits') }, (old) =>
    Array.isArray(old)
      ? old.map((h) => {
          if (h.id !== habitId) return h;
          const rec: HabitRecord = h.record ?? { id: `local-${habitId}-${date}`, habitId, localDate: date, state: 'pending', approvedBy: null, clientTimestamp: ts, version: 0 };
          return { ...h, record: { ...rec, state: h.approvalRequired ? 'pending' : 'done', clientTimestamp: ts } };
        })
      : old,
  );
}

/** 습관 체크: 낙관적 갱신 → 실패 롤백 */
export function useCheckHabit() {
  const { repo, queryClient: qc } = useServices();
  const { ns } = useSession();
  const online = useOnline();
  const toast = useToast();
  const inflight = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const check = useCallback(
    async (habitId: string, localDate: string) => {
      const id = `${habitId}:${localDate}`;
      if (inflight.current.has(id)) return;
      inflight.current.add(id);
      setBusy(new Set(inflight.current));
      const ts = new Date().toISOString();
      const key = newId();
      const before = snap(qc, dkey(ns, 'habits'));
      patchHabit(qc, ns, habitId, localDate, ts);
      try {
        if (!online) throw new FamilyBoardError('NETWORK_ERROR', '네트워크에 연결되어 있지 않아요.');
        await repo.checkHabit(habitId, localDate, ts, key);
        void qc.invalidateQueries({ queryKey: dkey(ns, 'habits') });
        void qc.invalidateQueries({ queryKey: dkey(ns, 'habit-summary') });
      } catch (e) {
        restore(qc, before);
        toast.error(`체크하지 못했어요. ${friendlyMessage(e)}`);
      } finally {
        inflight.current.delete(id);
        setBusy(new Set(inflight.current));
      }
    },
    [repo, qc, ns, online, toast],
  );
  return { check, busy };
}

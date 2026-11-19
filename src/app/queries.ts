import { useQuery } from '@tanstack/react-query';
import type { CalendarEvent, ChildProfile, FamilyMember, HabitWithRecord, Task } from '../domain/types';
import { dkey, useServices, useSession } from './context';

export function useMembers() {
  const { repo } = useServices();
  const { ns } = useSession();
  return useQuery<{ adults: FamilyMember[]; children: ChildProfile[] }>({ queryKey: dkey(ns, 'members'), queryFn: () => repo.getMembers() });
}

export function useEvents(from: string, to: string) {
  const { repo } = useServices();
  const { ns } = useSession();
  return useQuery<CalendarEvent[]>({ queryKey: dkey(ns, 'events', from, to), queryFn: () => repo.getEvents({ from, to }) });
}

export function useTasks(filter: { kind?: 'todo' | 'shopping'; completed?: boolean } = {}, key = 'list') {
  const { repo } = useServices();
  const { ns } = useSession();
  return useQuery<Task[]>({ queryKey: dkey(ns, 'tasks', key, filter), queryFn: () => repo.getTasks(filter) });
}

export function useHabits(childId: string, date: string, enabled = true) {
  const { repo } = useServices();
  const { ns } = useSession();
  return useQuery<HabitWithRecord[]>({ queryKey: dkey(ns, 'habits', childId, date), queryFn: () => repo.getHabits(childId, date), enabled });
}

/** 이름 찾기 도우미 */
export function nameOf(members: { adults: FamilyMember[]; children: ChildProfile[] } | undefined, id: string | null, type: 'adult' | 'child' | null): string {
  if (!id || !members) return '';
  if (type === 'child') return members.children.find((c) => c.id === id)?.displayName ?? '';
  return members.adults.find((a) => a.userId === id)?.displayName ?? '';
}

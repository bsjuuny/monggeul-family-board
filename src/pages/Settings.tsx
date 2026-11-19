import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { todayIn } from '../domain/dates';
import { friendlyMessage } from '../domain/errors';
import type { HabitTemplate } from '../domain/types';
import { validateChildName, validateHabit } from '../domain/validation';
import { downloadJson } from '../lib/download';
import { newId } from '../lib/crypto';
import { parseBackupFile } from '../server/api';
import { dkey, useOnline, usePageTitle, useServices, useSession, useSyncSnapshot, useUnlocked } from '../app/context';
import { useMembers } from '../app/queries';
import { useLogout } from '../app/Shell';
import { ConfirmDialog } from '../ui/Confirm';
import { PinDialog } from '../ui/PinDialog';
import { AVATARS, avatarOf, EmptyBlock, HABIT_ICONS, habitIconOf, OfflineReason, QueryView } from '../ui/States';
import { useToast } from '../ui/Toasts';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

export function SettingsPage() {
  usePageTitle('설정');
  const { repo, api, server, unlockStore, outbox, cache } = useServices();
  const snap = useSyncSnapshot();
  const s = useSession();
  const { ns, tz, isOwner } = s;
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const unlocked = useUnlocked();
  const logout = useLogout();
  const members = useMembers();

  const [pinFor, setPinFor] = useState<null | (() => void)>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label: string; run: () => Promise<void> }>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [childName, setChildName] = useState('');
  const [avatar, setAvatar] = useState('bear');
  const [childErr, setChildErr] = useState<string | null>(null);
  const [habitChild, setHabitChild] = useState('');
  const [habitTitle, setHabitTitle] = useState('');
  const [habitIcon, setHabitIcon] = useState('star');
  const [habitApproval, setHabitApproval] = useState(true);
  const [habitErr, setHabitErr] = useState<string | null>(null);
  const [habitList, setHabitList] = useState<Record<string, HabitTemplate[]>>({});
  const childKey = useRef(newId());
  const habitKey = useRef(newId());

  const refresh = (k: string) => qc.invalidateQueries({ queryKey: dkey(ns, k) });
  async function attempt(fn: () => Promise<void>, ok?: string) {
    try {
      await fn();
      if (ok) toast.info(ok);
    } catch (e) {
      toast.error(friendlyMessage(e));
    }
  }
  /** PIN이 이미 해제돼 있으면 바로, 아니면 PIN 확인 후 실행 */
  const withPin = (fn: () => void) => (unlockStore.isUnlocked() ? fn() : setPinFor(() => fn));
  const ask = (c: NonNullable<typeof confirm>) => setConfirm(c);

  async function runConfirm() {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      await confirm.run();
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
    }
  }

  async function addChild(e: FormEvent) {
    e.preventDefault();
    setChildErr(null);
    try {
      validateChildName(childName);
    } catch (err) {
      setChildErr(friendlyMessage(err));
      return;
    }
    await attempt(async () => {
      await repo.addChild({ displayName: childName, avatarKey: avatar }, childKey.current);
      childKey.current = newId();
      setChildName('');
      await refresh('members');
    }, '아이를 추가했어요.');
  }

  async function addHabit(e: FormEvent) {
    e.preventDefault();
    setHabitErr(null);
    const input = { childId: habitChild || (members.data?.children.find((c) => c.active)?.id ?? ''), title: habitTitle, iconKey: habitIcon, approvalRequired: habitApproval };
    if (!input.childId) {
      setHabitErr('먼저 아이를 선택해 주세요.');
      return;
    }
    try {
      validateHabit(input);
    } catch (err) {
      setHabitErr(friendlyMessage(err));
      return;
    }
    await attempt(async () => {
      await repo.addHabitTemplate(input, habitKey.current);
      habitKey.current = newId();
      setHabitTitle('');
      await loadHabits(input.childId);
    }, '습관을 추가했어요.');
  }

  async function loadHabits(childId: string) {
    const list = await repo.getHabits(childId, todayIn(tz));
    setHabitList((h) => ({ ...h, [childId]: list }));
  }

  async function downloadBackup() {
    const file = await api.backup();
    downloadJson(file, `monggeul-backup-${file.exportedAt.slice(0, 19).replace(/[:T-]/g, '')}.json`);
  }

  async function onPickRestore(e: ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    let file;
    try {
      file = parseBackupFile(await f.text());
    } catch (err) {
      toast.error(friendlyMessage(err));
      return;
    }
    ask({
      title: '백업으로 복원할까요?',
      message: `서버의 현재 가족 데이터가 "${f.name}"(${file.exportedAt.slice(0, 10)} 백업) 내용으로 바뀌어요. 복원 전 현재 내용은 서버에 자동 백업돼요.`,
      label: '복원',
      run: async () => {
        await api.restore(file);
        await server.afterRestore();
        await qc.invalidateQueries();
        toast.info('백업을 복원했어요.');
      },
    });
  }

  async function clearLocalCache() {
    await Promise.allSettled([outbox.clearAll(), cache.clearAll()]);
    qc.clear();
    await qc.invalidateQueries();
  }

  return (
    <div className="stack">
      <h1>설정</h1>
      <OfflineReason show={!online}>오프라인이에요. 설정은 연결된 뒤에 바꿀 수 있어요.</OfflineReason>

      <Section id="set-account" title="👤 내 계정">
        <dl className="kv">
          <dt>가족</dt>
          <dd>{s.familyName}</dd>
          <dt>ID</dt>
          <dd>{s.email}</dd>
          <dt>이름</dt>
          <dd>{s.displayName}</dd>
          <dt>권한</dt>
          <dd>{isOwner ? 'owner' : '성인'}</dd>
          <dt>부모 PIN</dt>
          <dd>{unlocked ? '🔓 확인됨 (15분간 유지)' : '🔒 잠김'}</dd>
        </dl>
        <div className="btn-row" style={{ marginTop: 12 }}>
          {unlocked ? (
            <button type="button" className="btn secondary small" onClick={() => unlockStore.clear()}>
              PIN 다시 잠그기
            </button>
          ) : (
            <button type="button" className="btn secondary small" onClick={() => setPinFor(() => () => undefined)} disabled={!online}>
              부모 PIN 확인{isOwner ? ' / 만들기' : ''}
            </button>
          )}
          <button type="button" className="btn secondary small" onClick={() => void logout().catch(() => toast.error('로그아웃하지 못했어요.'))}>
            로그아웃
          </button>
        </div>
      </Section>

      <Section id="set-members" title="👨‍👩‍👧 구성원">
        <QueryView q={members}>
          {(d) => (
            <ul className="list" aria-label="성인 구성원">
              {d.adults.map((a) => (
                <li key={a.userId} data-testid="member-row">
                  <span className="grow">{a.displayName}</span>
                  <span className="chip">{a.role === 'owner' ? 'owner' : '성인'}</span>
                  {isOwner && a.userId !== s.userId && (
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={!online}
                      onClick={() =>
                        ask({
                          title: '구성원을 내보낼까요?',
                          message: `${a.displayName}님이 이 가족에서 빠지고 데이터에 접근할 수 없게 돼요.`,
                          label: '내보내기',
                          run: async () => {
                            await repo.removeMember(a.userId);
                            await refresh('members');
                            toast.info('구성원을 내보냈어요.');
                          },
                        })
                      }
                    >
                      내보내기
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Section>

      <Section id="set-kids" title="🧸 아이와 습관">
        <p className="muted">아이 추가·습관 변경은 부모 PIN 확인 후 할 수 있어요.</p>
        <QueryView q={members} isEmpty={(d) => d.children.length === 0} empty={<EmptyBlock icon="🧸" title="아직 아이가 없어요" hint="아래에서 별칭으로 추가해 보세요." />}>
          {(d) => (
            <ul className="list" aria-label="아이 목록">
              {d.children.map((c) => (
                <li key={c.id} data-testid="child-row">
                  <span aria-hidden="true">{avatarOf(c.avatarKey)}</span>
                  <span className="grow">
                    {c.displayName}
                    {!c.active && <span className="chip"> 사용 안 함</span>}
                  </span>
                  <button type="button" className="btn ghost small" onClick={() => void loadHabits(c.id)}>
                    습관 보기
                  </button>
                  <button type="button" className="btn ghost small" disabled={!online} onClick={() => withPin(() => void attempt(async () => { await repo.setChildActive(c.id, !c.active); await refresh('members'); }))}>
                    {c.active ? '사용 안 함' : '다시 사용'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
        {Object.entries(habitList).map(([cid, list]) => (
          <div key={cid} style={{ marginTop: 12 }}>
            <h3>{members.data?.children.find((c) => c.id === cid)?.displayName}의 습관</h3>
            {list.length === 0 ? (
              <p className="muted">등록된 습관이 없어요.</p>
            ) : (
              <ul className="list" aria-label="습관 목록">
                {list.map((h) => (
                  <li key={h.id}>
                    <span aria-hidden="true">{habitIconOf(h.iconKey)}</span>
                    <span className="grow">{h.title}</span>
                    <span className="chip">{h.approvalRequired ? '승인 필요' : '바로 완료'}</span>
                    <button type="button" className="btn ghost small" disabled={!online} onClick={() => withPin(() => void attempt(async () => { await repo.setHabitActive(h.id, false); await loadHabits(cid); }, '습관을 껐어요.'))}>
                      끄기
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <form onSubmit={(e) => { e.preventDefault(); withPin(() => void addChild(e)); }} noValidate aria-label="아이 추가" style={{ marginTop: 16 }}>
          <h3>아이 추가</h3>
          <div className="row2">
            <div className="field">
              <label htmlFor="set-child-name">별칭 (20자 이하)</label>
              <input id="set-child-name" type="text" maxLength={20} value={childName} onChange={(e) => setChildName(e.target.value)} aria-invalid={childErr ? true : undefined} />
              {childErr && <span className="err">{childErr}</span>}
            </div>
            <div className="field">
              <label htmlFor="set-child-avatar">아바타</label>
              <select id="set-child-avatar" value={avatar} onChange={(e) => setAvatar(e.target.value)}>
                {Object.entries(AVATARS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v} {k}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className="btn" disabled={!online}>
            아이 추가
          </button>
        </form>
        <form onSubmit={(e) => { e.preventDefault(); withPin(() => void addHabit(e)); }} noValidate aria-label="습관 추가" style={{ marginTop: 16 }}>
          <h3>습관 추가</h3>
          <div className="row2">
            <div className="field">
              <label htmlFor="set-habit-child">아이</label>
              <select id="set-habit-child" value={habitChild} onChange={(e) => setHabitChild(e.target.value)}>
                {members.data?.children.filter((c) => c.active).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="set-habit-icon">아이콘</label>
              <select id="set-habit-icon" value={habitIcon} onChange={(e) => setHabitIcon(e.target.value)}>
                {Object.entries(HABIT_ICONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v} {k}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="set-habit-title">습관 이름 (40자 이하)</label>
            <input id="set-habit-title" type="text" maxLength={40} value={habitTitle} onChange={(e) => setHabitTitle(e.target.value)} aria-invalid={habitErr ? true : undefined} />
            {habitErr && <span className="err">{habitErr}</span>}
          </div>
          <label className="check">
            <input type="checkbox" checked={habitApproval} onChange={(e) => setHabitApproval(e.target.checked)} />
            부모 승인이 필요해요
          </label>
          <button type="submit" className="btn" disabled={!online}>
            습관 추가
          </button>
        </form>
      </Section>

      <Section id="set-server" title="🖥️ 서버와 백업">
        <dl className="kv">
          <dt>서버</dt>
          <dd data-testid="server-status">{snap.unreachable ? '❌ 연결 안 됨' : `✔ 연결됨 · 문서 v${snap.version}`}</dd>
          <dt>서버 권한</dt>
          <dd>{snap.role === 'owner' ? 'owner' : '성인'}</dd>
        </dl>
        <p className="muted">모든 변경은 태블릿 서버의 SQLite에 저장돼요. 정기적으로 JSON 백업을 내려받아 보관해 주세요.</p>
        <div className="btn-row">
          <button type="button" className="btn" disabled={!online || snap.role !== 'owner'} onClick={() => void attempt(downloadBackup, '백업 파일을 내려받았어요.')}>
            JSON 백업 내려받기
          </button>
          <button type="button" className="btn secondary" disabled={!online || snap.role !== 'owner'} onClick={() => fileRef.current?.click()}>
            JSON 복원…
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="복원할 백업 파일" onChange={(e) => void onPickRestore(e)} />
        </div>
        {snap.role !== 'owner' && <p className="muted">백업과 복원은 서버 owner 계정만 할 수 있어요.</p>}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn ghost small" onClick={() => void attempt(clearLocalCache, '이 브라우저의 로컬 캐시를 지웠어요.')}>
            로컬 캐시 초기화
          </button>
        </div>
      </Section>

      {pinFor && (
        <PinDialog
          canCreate={isOwner}
          onClose={() => setPinFor(null)}
          onUnlocked={() => {
            const run = pinFor;
            setPinFor(null);
            run();
          }}
        />
      )}
      {confirm && <ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.label} danger busy={confirmBusy} onConfirm={() => void runConfirm()} onClose={() => setConfirm(null)} />}
    </div>
  );
}

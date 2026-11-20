import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { friendlyMessage, isFamilyBoardError } from '../domain/errors';
import { downloadJson } from '../lib/download';
import { PinDialog } from '../ui/PinDialog';
import { LoadingBlock } from '../ui/States';
import { Monggeul } from '../ui/characters';
import { FullscreenButton } from '../ui/Fullscreen';
import { SessionProvider, useAppCtx, useOnline, useReloadFromServer, useRemoteSync, useServices, useSession } from './context';
import { useToast } from '../ui/Toasts';
import { todayIn } from '../domain/dates';
import type { TaskKind } from '../domain/types';
import { EventForm } from '../pages/Calendar';
import { TaskForm } from '../pages/Tasks';

/** 연결·동기화 상태 배너: 서버 끊김, 409 충돌(덮어쓰지 않음), 다른 기기 변경 */
function StatusBanner() {
  const online = useOnline();
  const snap = useRemoteSync(false);
  const reload = useReloadFromServer();
  const { server } = useServices();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function doReload() {
    setBusy(true);
    try {
      await reload();
      toast.info('서버의 최신 내용을 불러왔어요.');
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function downloadMine() {
    const file = server.myBackup();
    downloadJson(file, `monggeul-my-changes-${file.exportedAt.slice(0, 19).replace(/[:T]/g, '')}.json`);
  }

  if (snap.conflict) {
    return (
      <div className="banner offline" role="alert" data-testid="conflict-banner">
        <span aria-hidden="true">⚠️</span> 다른 기기가 먼저 저장해서(서버 v{snap.conflict.serverVersion}) 방금 변경은 저장되지 않았어요. 서버 내용을 덮어쓰지 않았어요.
        <button type="button" className="btn small" disabled={busy} onClick={() => void doReload()}>
          서버 값 다시 불러오기
        </button>
        <button type="button" className="btn secondary small" onClick={downloadMine}>
          내 JSON 백업
        </button>
      </div>
    );
  }
  if (!online || snap.unreachable) {
    return (
      <div className="banner offline" role="status" data-testid="status-banner">
        <span aria-hidden="true">📴</span> 태블릿 서버에 연결할 수 없어요. 연결이 돌아올 때까지 변경은 저장되지 않아요.
      </div>
    );
  }
  if (snap.remoteVersion !== null) {
    return (
      <div className="banner sync" role="status" data-testid="remote-banner">
        <span aria-hidden="true">🔄</span> 다른 기기에서 내용이 바뀌었어요(v{snap.remoteVersion}). 편집 중이면 저장 후 불러오세요.
        <button type="button" className="btn small" disabled={busy} onClick={() => void doReload()}>
          새로 불러오기
        </button>
      </div>
    );
  }
  return null;
}

export function useLogout() {
  const { repo, outbox, cache, queryClient, deviceStore } = useServices();
  const navigate = useNavigate();
  return async () => {
    try {
      await repo.signOut();
    } finally {
      deviceStore.clear('child');
      await Promise.allSettled([outbox.clearAll(), cache.clearAll()]);
      queryClient.clear();
      navigate('/login', { replace: true });
    }
  };
}

const NAV = [
  { to: '/', label: '보드', ariaLabel: '오늘 보드', ico: '⌂', end: true },
  { to: '/calendar', label: '주간', ariaLabel: '캘린더', ico: '▦', end: false },
  { to: '/notices', label: '공지', ariaLabel: '공지', ico: '✉', end: false },
  { to: '/prep', label: '준비', ariaLabel: '준비물·픽업', ico: '✓', end: false },
];

function AdultShell() {
  const s = useSession();
  const logout = useLogout();
  const toast = useToast();
  const location = useLocation();
  const isHome = location.pathname === '/overview';
  const isKids = location.pathname.startsWith('/kids');
  const [add, setAdd] = useState<null | 'sheet' | { type: 'event' } | { type: 'task'; kind: TaskKind }>(null);
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <div className="brand">
          <Monggeul className="brand-mascot" decorative /> 몽글 패밀리보드 <small>{s.familyName}</small>
        </div>
        <span className="chip" title="로그인한 계정">
          {s.displayName}
          {s.isOwner ? ' · owner' : ' · 성인'}
        </span>
        <Link className="btn ghost small topbar-link" to="/" aria-label="한눈에 보는 오늘 보드">
          <span aria-hidden="true">☺</span><span className="topbar-label">한눈에</span>
        </Link>
        <Link className="btn ghost small topbar-link" to="/overview" aria-label="이번 주 흐름">
          <span aria-hidden="true">▦</span><span className="topbar-label">이번 주</span>
        </Link>
        <Link className="btn ghost small topbar-link" to="/display" aria-label="TV 화면 미리보기">
          <span aria-hidden="true">📺</span><span className="topbar-label">TV 화면</span>
        </Link>
        <Link className="btn ghost small topbar-link" to="/settings" aria-label="설정">
          <span aria-hidden="true">⚙</span><span className="topbar-label">설정</span>
        </Link>
        <FullscreenButton className="btn ghost small topbar-link" />
        <button
          type="button"
          className="btn secondary small"
          onClick={() => void logout().catch(() => toast.error('로그아웃하지 못했어요. 다시 시도해 주세요.'))}
        >
          로그아웃
        </button>
      </header>
      <nav className="nav" aria-label="주요 메뉴">
        <NavLink to={NAV[0]!.to} end={NAV[0]!.end} aria-label={NAV[0]!.ariaLabel}>
          <span className="ico" aria-hidden="true">{NAV[0]!.ico}</span>{NAV[0]!.label}
        </NavLink>
        <NavLink to={NAV[1]!.to} end={NAV[1]!.end} aria-label={NAV[1]!.ariaLabel}>
          <span className="ico" aria-hidden="true">{NAV[1]!.ico}</span>{NAV[1]!.label}
        </NavLink>
        <button type="button" className="nav-add" onClick={() => setAdd('sheet')} aria-label="추가">
          <span className="ico" aria-hidden="true">＋</span>추가
        </button>
        <NavLink to={NAV[2]!.to} end={NAV[2]!.end} aria-label={NAV[2]!.ariaLabel}>
          <span className="ico" aria-hidden="true">{NAV[2]!.ico}</span>{NAV[2]!.label}
        </NavLink>
        <NavLink to={NAV[3]!.to} end={NAV[3]!.end} aria-label={NAV[3]!.ariaLabel}>
          <span className="ico" aria-hidden="true">{NAV[3]!.ico}</span>{NAV[3]!.label}
        </NavLink>
      </nav>
      <div className="shell-content">
        <StatusBanner />
        <main id="main" className={`main${isHome ? ' main-home' : ''}${isKids ? ' main-kids' : ''}`} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {add === 'sheet' && (
        <div className="quick-add-choice" role="dialog" aria-modal="true" aria-label="빠른 추가">
          <button type="button" className="quick-add-backdrop" onClick={() => setAdd(null)} aria-label="빠른 추가 닫기" />
          <section className="quick-add-sheet">
            <div className="quick-add-head"><strong>무엇을 추가할까요?</strong><button type="button" className="btn ghost small" onClick={() => setAdd(null)} aria-label="닫기">✕</button></div>
            <div className="quick-add-grid">
              <button type="button" onClick={() => setAdd({ type: 'event' })}><span aria-hidden="true">📅</span>일정</button>
              <button type="button" onClick={() => setAdd({ type: 'task', kind: 'todo' })}><span aria-hidden="true">✓</span>할 일</button>
              <button type="button" onClick={() => setAdd({ type: 'task', kind: 'shopping' })}><span aria-hidden="true">🛒</span>장보기</button>
            </div>
          </section>
        </div>
      )}
      {typeof add === 'object' && add?.type === 'event' && <EventForm date={todayIn(s.tz)} onClose={() => setAdd(null)} />}
      {typeof add === 'object' && add?.type === 'task' && <TaskForm kind={add.kind} onClose={() => setAdd(null)} />}
    </div>
  );
}

/** 공유 태블릿: 아이 전용 셸. 종료는 부모 PIN 재확인 */
function KidShell() {
  const { deviceStore, unlockStore, outbox, cache, queryClient } = useServices();
  const s = useSession();
  const navigate = useNavigate();
  const [askPin, setAskPin] = useState(false);
  useEffect(() => {
    document.body.classList.add('child-mode');
    return () => document.body.classList.remove('child-mode');
  }, []);
  async function exitKidMode() {
    deviceStore.clear('child');
    unlockStore.clear();
    await Promise.allSettled([outbox.clearAll(), cache.clearAll()]);
    queryClient.clear();
    navigate('/login', { replace: true });
  }
  return (
    <div className="app kid-shell" style={{ gridTemplateColumns: '1fr' }}>
      <a className="skip-link" href="#main">
        본문으로 건너뛰기
      </a>
      <header className="topbar">
        <div className="brand">
          <Monggeul className="brand-mascot" decorative /> {s.familyName} 아이 모드
        </div>
        <FullscreenButton />
        <button type="button" className="btn secondary small" onClick={() => setAskPin(true)}>
          부모 확인 후 종료
        </button>
      </header>
      <div className="shell-content">
        <StatusBanner />
        <main id="main" className="main main-kids" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {askPin && (
        <PinDialog
          title="부모 PIN으로 아이 모드 종료"
          onClose={() => setAskPin(false)}
          onUnlocked={() => {
            setAskPin(false);
            void exitKidMode();
          }}
        />
      )}
    </div>
  );
}

/** 로그인/가족/기기 상태에 따라 알맞은 셸 또는 이동 */
export function AppGate() {
  const q = useAppCtx();
  const loc = useLocation();
  if (q.isPending) {
    return (
      <div className="center">
        <LoadingBlock label="앱을 준비하는 중이에요…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="center">
        <div className="state error" role="alert">
          <strong>{isFamilyBoardError(q.error) && q.error.code === 'NETWORK_ERROR' ? '태블릿 서버에 연결할 수 없어요' : '앱 상태를 확인하지 못했어요'}</strong>
          <p>{isFamilyBoardError(q.error) && q.error.code === 'NETWORK_ERROR' ? '서버가 켜져 있고 같은 Wi-Fi인지 확인한 뒤 다시 시도해 주세요. 서버 없이는 사용할 수 없어요.' : '잠시 뒤 다시 시도해 주세요.'}</p>
          <button type="button" className="btn" onClick={() => void q.refetch()}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }
  const ctx = q.data;
  if (ctx.kind === 'anonymous') return <Navigate to="/login" replace state={{ next: loc.pathname }} />;
  if (ctx.kind === 'adult' && !ctx.family) return <Navigate to="/setup" replace />;
  if (ctx.kind === 'device') {
    if (ctx.mode === 'tv') return <Navigate to="/display" replace />;
    if (!loc.pathname.startsWith('/kids')) return <Navigate to="/kids" replace />;
    return (
      <SessionProvider ctx={ctx}>
        <KidShell />
      </SessionProvider>
    );
  }
  return (
    <SessionProvider ctx={ctx}>
      {/* 메인 보드는 전체 화면(셸 없이). 상세 메뉴는 보드의 메뉴 버튼으로 연다 */}
      {loc.pathname === '/' ? <Outlet /> : <AdultShell />}
    </SessionProvider>
  );
}

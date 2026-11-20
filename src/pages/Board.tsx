// 메인 보드(홈, 성인)와 TV 화면(/display). 같은 BoardScreen 을 쓴다.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BoardScreen } from '../board/BoardScreen';
import { Icon } from '../board/icons';
import { useNow, useOnline, usePageTitle, useServices } from '../app/context';
import { useLogout } from '../app/Shell';
import { isFamilyBoardError } from '../domain/errors';
import type { Board, PrepItem } from '../server/v2';
import { FullscreenButton } from '../ui/Fullscreen';
import { useToast } from '../ui/Toasts';
import { usePendingAnalysis } from './notices/usePendingAnalysis';
import '../board/board.css';

const BOARD_REFRESH_MS = 60_000;

export function useBoard(enabled = true) {
  const { v2 } = useServices();
  return useQuery<Board>({
    queryKey: ['board'],
    queryFn: () => v2.board(),
    enabled,
    refetchInterval: BOARD_REFRESH_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    retry: (n, e) => isFamilyBoardError(e) && e.code === 'NETWORK_ERROR' && n < 2,
  });
}

function useBodyClass(name: string) {
  useEffect(() => {
    document.body.classList.add(name);
    return () => document.body.classList.remove(name);
  }, [name]);
}

function BoardLoading({ label }: { label: string }) {
  return (
    <div className="v2-board" data-period="morning">
      <div className="v2-board__inner" style={{ display: 'grid', placeItems: 'center' }}>
        <p role="status" className="v2-empty" style={{ alignItems: 'center' }}><strong>{label}</strong></p>
      </div>
    </div>
  );
}

const MENU = [
  { to: '/overview', label: '가족 한눈에', icon: 'home' as const },
  { to: '/notices', label: '공지 정리', icon: 'bell' as const },
  { to: '/prep', label: '준비물·픽업', icon: 'bag' as const },
  { to: '/calendar', label: '캘린더', icon: 'calendar' as const },
  { to: '/tasks', label: '할 일', icon: 'check' as const },
  { to: '/kids', label: '아이', icon: 'person' as const },
  { to: '/display', label: 'TV 화면', icon: 'tv' as const },
  { to: '/settings', label: '설정', icon: 'menu' as const },
];

function HomeMenu() {
  const [open, setOpen] = useState(false);
  const logout = useLogout();
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <button type="button" className="v2-menu-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} data-testid="board-menu">
        <Icon name="menu" />메뉴
      </button>
      {open && (
        <div className="v2-menu" role="dialog" aria-modal="true" aria-label="메뉴">
          <button type="button" className="v2-menu__backdrop" aria-label="메뉴 닫기" onClick={() => setOpen(false)} />
          <nav className="v2-menu__panel" aria-label="상세 메뉴">
            <h2>메뉴<button type="button" className="v2-menu__close" onClick={() => setOpen(false)} aria-label="닫기"><Icon name="close" /></button></h2>
            {MENU.map((m) => <Link key={m.to} to={m.to} onClick={() => setOpen(false)}><Icon name={m.icon} />{m.label}</Link>)}
            <FullscreenButton className="v2-menu__item" />
            <button type="button" className="v2-menu__item" onClick={() => void logout().catch(() => toast.error('로그아웃하지 못했어요.'))}><Icon name="close" />로그아웃</button>
          </nav>
        </div>
      )}
    </>
  );
}

/** 성인 홈 '/' */
export function BoardHomePage() {
  usePageTitle('오늘');
  useBodyClass('v2-on');
  const { v2 } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useBoard();
  const now = useNow(1000);
  const online = useOnline();
  usePendingAnalysis(Boolean(q.data?.notices.top.some((n) => n.status === 'pending_analysis')));
  const toggle = useMutation({
    mutationFn: (p: PrepItem) => v2.patchPrep(p.id, { done: !p.doneAt }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['board'] }),
    onError: () => toast.error('준비물 상태를 바꾸지 못했어요.'),
  });
  const pickupDone = useMutation({
    mutationFn: async () => {
      const b = q.data;
      if (!b) return;
      await Promise.all(b.commute.today.filter((p) => p.attends).map((p) => v2.setPickup({ date: b.today, childId: p.childId, done: true })));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['board'] }),
  });
  if (!q.data) {
    if (q.isError) return <BoardLoading label="태블릿 서버에 연결할 수 없어요. 같은 Wi-Fi인지 확인해 주세요." />;
    return <BoardLoading label="오늘 정보를 불러오는 중이에요…" />;
  }
  return (
    <BoardScreen board={q.data} now={now} variant="home" online={online && !q.isError} menu={<HomeMenu />}
      onTogglePrep={(p) => toggle.mutate(p)} onPickupDone={() => pickupDone.mutate()} />
  );
}

function PairForm({ onPaired }: { onPaired: () => void }) {
  const { v2 } = useServices();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('거실 TV');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await v2.pair(code.trim(), label.trim());
      onPaired();
    } catch (err) {
      setError(isFamilyBoardError(err) ? err.message : '연결하지 못했어요.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="v2-card v2-pair" onSubmit={(e) => void submit(e)} aria-labelledby="pair-title">
      <h1 id="pair-title" className="v2-card__title"><Icon name="tv" />이 화면을 TV로 연결해요</h1>
      <p className="v2-muted">보호자 휴대폰의 <strong>설정 → TV 연결</strong>에서 6자리 코드를 만든 뒤 입력해 주세요. 연결한 TV는 로그인 없이 오늘 정보만 볼 수 있어요.</p>
      <label className="v2-field">연결 코드
        <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required aria-describedby="pair-error" />
      </label>
      <label className="v2-field">화면 이름
        <input value={label} maxLength={30} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {error && <p id="pair-error" role="alert" className="v2-count">{error}</p>}
      <button type="submit" className="v2-btn" disabled={busy || code.length !== 6}>{busy ? '연결하는 중…' : 'TV로 연결'}</button>
      <Link className="v2-more" to="/login" state={{ next: '/display' }}>보호자 계정으로 로그인하기</Link>
    </form>
  );
}

function TvCorner({ viewer, onUnpaired }: { viewer: Board['viewer']; onUnpaired: () => void }) {
  const { v2 } = useServices();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="v2-menu-btn v2-menu-btn--quiet" onClick={() => setOpen(true)} aria-label="화면 메뉴"><Icon name="menu" /></button>
      {open && (
        <div className="v2-menu" role="dialog" aria-modal="true" aria-label="화면 메뉴">
          <button type="button" className="v2-menu__backdrop" aria-label="닫기" onClick={() => setOpen(false)} />
          <div className="v2-menu__panel">
            <h2>{viewer.kind === 'device' ? viewer.label ?? 'TV' : 'TV 화면'}<button type="button" className="v2-menu__close" onClick={() => setOpen(false)} aria-label="닫기"><Icon name="close" /></button></h2>
            <FullscreenButton className="v2-menu__item" />
            {viewer.kind === 'user'
              ? <button type="button" className="v2-menu__item" onClick={() => navigate('/')}><Icon name="home" />앱으로 돌아가기</button>
              : <button type="button" className="v2-menu__item" onClick={() => void v2.unpair().then(onUnpaired)}><Icon name="close" />이 TV 연결 해제</button>}
          </div>
        </div>
      )}
    </>
  );
}

/** TV 화면 '/display': 연결된 TV 기기 또는 로그인한 성인 */
export function DisplayPage() {
  usePageTitle('TV 화면');
  useBodyClass('v2-on');
  const qc = useQueryClient();
  const q = useBoard();
  const now = useNow(1000);
  const online = useOnline();
  const unauth = isFamilyBoardError(q.error) && q.error.code === 'UNAUTHENTICATED';
  if (unauth) {
    return (
      <div className="v2-board" data-period="morning" data-testid="tv-pair">
        <div className="v2-board__inner v2-board__inner--center"><PairForm onPaired={() => void qc.invalidateQueries({ queryKey: ['board'] })} /></div>
      </div>
    );
  }
  if (!q.data) return <BoardLoading label={q.isError ? '태블릿 서버에 연결할 수 없어요. 다시 연결되면 자동으로 보여드려요.' : '오늘 정보를 불러오는 중이에요…'} />;
  return (
    <BoardScreen testId="tv-display" board={q.data} now={now} variant="tv" online={online && !q.isError}
        menu={<TvCorner viewer={q.data.viewer} onUnpaired={() => { qc.removeQueries({ queryKey: ['board'] }); void qc.invalidateQueries({ queryKey: ['board'] }); }} />} />
  );
}

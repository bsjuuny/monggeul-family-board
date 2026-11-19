import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { friendlyMessage } from '../domain/errors';
import { useAppCtx, usePageTitle, useServices } from '../app/context';
import { LoadingBlock } from '../ui/States';

type ServerStatus = { state: 'checking' } | { state: 'ok'; schemaVersion: number } | { state: 'down'; message: string };

/** ID/PW 로그인. 서버 주소는 현재 origin이며, 서버가 없으면 로컬 모드로 넘어가지 않고 오류를 안내한다. */
export function LoginPage() {
  usePageTitle('로그인');
  const { server, api, queryClient } = useServices();
  const navigate = useNavigate();
  const loc = useLocation();
  const ctx = useAppCtx();
  const next = (loc.state as { next?: string } | null)?.next ?? '/';
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ServerStatus>({ state: 'checking' });
  const inFlight = useRef(false);

  async function checkServer() {
    setStatus({ state: 'checking' });
    try {
      const h = await api.health();
      setStatus({ state: 'ok', schemaVersion: h.schemaVersion });
    } catch (e) {
      setStatus({ state: 'down', message: friendlyMessage(e) });
    }
  }
  useEffect(() => {
    void checkServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (ctx.isPending) return <div className="center"><LoadingBlock label="확인하는 중이에요…" /></div>;
  if (ctx.data && ctx.data.kind !== 'anonymous') return <Navigate to={next === '/login' ? '/' : next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setError(null);
    if (!id.trim() || !password) {
      setError('ID와 비밀번호를 입력해 주세요.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await server.login(id, password);
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['ctx'] });
      navigate(next, { replace: true });
    } catch (err) {
      setError(friendlyMessage(err));
      setPassword('');
      void checkServer();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const down = status.state === 'down';
  return (
    <div className="center">
      <main className="card auth-card stack" id="main">
        <h1>
          <span aria-hidden="true">🫧</span> 몽글 패밀리보드
        </h1>
        <p className="muted">우리 집 태블릿 서버에 로그인해 가족의 일정, 할 일, 아이 습관을 함께 봐요.</p>
        {status.state === 'checking' && (
          <p className="chip" role="status">
            서버 확인 중…
          </p>
        )}
        {status.state === 'ok' && (
          <p className="chip ok" role="status" data-testid="server-ok">
            ✔ 태블릿 서버에 연결됐어요
          </p>
        )}
        {down && (
          <div className="state error" role="alert" data-testid="server-down">
            <strong>태블릿 서버에 연결할 수 없어요</strong>
            <p>{status.message}</p>
            <button type="button" className="btn secondary small" onClick={() => void checkServer()}>
              다시 확인
            </button>
          </div>
        )}
        <form onSubmit={submit} noValidate aria-label="로그인">
          <div className="field">
            <label htmlFor="login-id">ID</label>
            <input id="login-id" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={id} onChange={(e) => setId(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? 'login-error' : undefined} />
          </div>
          <div className="field">
            <label htmlFor="login-pw">비밀번호</label>
            <input id="login-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} />
          </div>
          {error && (
            <p id="login-error" className="err" role="alert" style={{ color: 'var(--bad)', fontWeight: 600 }}>
              {error}
            </p>
          )}
          <button type="submit" className="btn block" disabled={busy || down}>
            {busy ? '로그인 중…' : '로그인'}
          </button>
        </form>
        <p className="hint">같은 Wi-Fi의 기기에서만 접속할 수 있어요. 계정은 태블릿 관리자가 만들어요.</p>
      </main>
    </div>
  );
}

import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { friendlyMessage, isFamilyBoardError } from '../domain/errors';
import { useOnline } from '../app/context';

export function LoadingBlock({ label = '불러오는 중이에요…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <i key={i} aria-hidden="true" />
      ))}
    </div>
  );
}

export function EmptyBlock({ icon = '🌱', title, hint, children }: { icon?: string; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="state" data-state="empty">
      <span className="big" aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const offlineErr = isFamilyBoardError(error) && error.code === 'NETWORK_ERROR';
  const forbidden = isFamilyBoardError(error) && error.code === 'FORBIDDEN';
  return (
    <div className={`state ${offlineErr ? 'offline' : 'error'}`} role="alert" data-state={offlineErr ? 'offline' : forbidden ? 'forbidden' : 'error'}>
      <span className="big" aria-hidden="true">
        {offlineErr ? '📴' : forbidden ? '🔒' : '⚠️'}
      </span>
      <strong>{offlineErr ? '오프라인이에요' : forbidden ? '권한이 없어요' : '불러오지 못했어요'}</strong>
      <p>{friendlyMessage(error)}</p>
      {onRetry && !forbidden && (
        <button type="button" className="btn secondary" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}

/**
 * 조회 결과를 loading / error / offline / empty / data 상태로 나눠 보여 준다.
 * 이미 받은 데이터가 있으면 오류가 나도 지우지 않고 "마지막으로 불러온 내용"으로 표시한다.
 */
export function QueryView<T>({
  q,
  isEmpty,
  empty,
  children,
  rows,
}: {
  q: UseQueryResult<T>;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (d: T) => ReactNode;
  rows?: number;
}) {
  const online = useOnline();
  if (q.data === undefined) {
    if (q.isError) return <ErrorBlock error={q.error} onRetry={() => void q.refetch()} />;
    return <LoadingBlock rows={rows} />;
  }
  const stale = q.isError || !online;
  return (
    <>
      {stale && (
        <p className="chip warn" role="status" data-state="stale">
          📴 마지막으로 불러온 내용이에요
          {q.isError && (
            <>
              {' · '}
              <button type="button" className="btn ghost small" onClick={() => void q.refetch()}>
                다시 시도
              </button>
            </>
          )}
        </p>
      )}
      {isEmpty?.(q.data) ? (empty ?? <EmptyBlock title="아직 아무것도 없어요" />) : children(q.data)}
    </>
  );
}

export function OfflineReason({ show, children }: { show: boolean; children?: ReactNode }) {
  if (!show) return null;
  return (
    <p className="muted" role="note" data-testid="offline-reason">
      📴 {children ?? '오프라인에서는 저장할 수 없어요. 연결되면 다시 시도해 주세요.'}
    </p>
  );
}

export const AVATARS: Record<string, string> = {
  bear: '🐻',
  rabbit: '🐰',
  cat: '🐱',
  dog: '🐶',
  fox: '🦊',
  panda: '🐼',
  chick: '🐥',
};
export const HABIT_ICONS: Record<string, string> = {
  tooth: '🪥',
  book: '📚',
  toy: '🧸',
  water: '🥛',
  star: '⭐',
  bed: '🛏️',
  shirt: '👕',
};
export const avatarOf = (k: string) => AVATARS[k] ?? '🙂';
export const habitIconOf = (k: string) => HABIT_ICONS[k] ?? '⭐';

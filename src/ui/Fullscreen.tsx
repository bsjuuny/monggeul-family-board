import { useEffect, useState, useSyncExternalStore } from 'react';

// 거실 태블릿용 전체 화면.
// 브라우저는 사용자 터치(제스처) 없이 전체 화면에 들어가지 못하므로,
// "항상 전체 화면" 설정이 켜져 있으면 다음 터치 때 자동으로 다시 들어간다.

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const KEEP_KEY = 'mgfb.keepFullscreen';

function fsElement(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as FsElement;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
}

export async function enterFullscreen(): Promise<void> {
  if (fsElement()) return;
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    // 제스처 밖에서 호출되었거나 브라우저가 거부함: 조용히 무시
  }
}

export async function exitFullscreen(): Promise<void> {
  if (!fsElement()) return;
  const d = document as FsDocument;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else await d.webkitExitFullscreen?.();
  } catch {
    /* noop */
  }
}

function subscribeFs(cb: () => void) {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
  };
}

export function useIsFullscreen(): boolean {
  return useSyncExternalStore(subscribeFs, () => fsElement() !== null, () => false);
}

// ---- "항상 전체 화면" 설정 (기기별, localStorage) ----
const keepListeners = new Set<() => void>();

function readKeep(): boolean {
  try {
    return localStorage.getItem(KEEP_KEY) === '1';
  } catch {
    return false;
  }
}

export function setKeepFullscreen(on: boolean) {
  try {
    if (on) localStorage.setItem(KEEP_KEY, '1');
    else localStorage.removeItem(KEEP_KEY);
  } catch {
    /* 저장소를 못 쓰면 이번 세션만 */
  }
  keepListeners.forEach((l) => l());
}

export function useKeepFullscreen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      keepListeners.add(cb);
      return () => keepListeners.delete(cb);
    },
    readKeep,
    () => false,
  );
}

/** 앱 루트에 한 번 둔다: "항상 전체 화면"이면 다음 터치/클릭/키 입력 때 다시 전체 화면으로 */
export function FullscreenKeeper() {
  const keep = useKeepFullscreen();
  const isFs = useIsFullscreen();
  useEffect(() => {
    if (!keep || isFs || !fullscreenSupported()) return;
    const go = () => void enterFullscreen();
    window.addEventListener('pointerup', go, { once: true });
    window.addEventListener('keydown', go, { once: true });
    return () => {
      window.removeEventListener('pointerup', go);
      window.removeEventListener('keydown', go);
    };
  }, [keep, isFs]);
  return null;
}

/** 상단바용 토글 버튼. 지원하지 않는 브라우저(iPhone Safari 등)에서는 숨긴다. */
export function FullscreenButton({ className = 'btn secondary small' }: { className?: string }) {
  const isFs = useIsFullscreen();
  const [supported] = useState(fullscreenSupported);
  if (!supported) return null;
  return (
    <button
      type="button"
      className={className}
      aria-pressed={isFs}
      data-testid="fullscreen-toggle"
      onClick={() => {
        if (isFs) {
          // 직접 빠져나오면 자동 재진입도 끈다
          setKeepFullscreen(false);
          void exitFullscreen();
        } else {
          void enterFullscreen();
        }
      }}
    >
      <span aria-hidden="true">{isFs ? '🗗' : '⛶'}</span> {isFs ? '창 모드' : '전체 화면'}
    </button>
  );
}

// 서비스 워커 등록과 새 버전 적용.
// 새 버전이 활성화되면(controllerchange) 보드·TV 화면은 바로 새로고침하고,
// 입력 중일 수 있는 다른 화면은 보드로 돌아갈 때 새로고침한다.
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

let registration: ServiceWorkerRegistration | null = null;
let pendingReload = false;

const onBoard = () => {
  const h = window.location.hash.replace(/^#/, '') || '/';
  return h === '/' || h.startsWith('/display');
};

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  let hasController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hasController) {
      hasController = true; // 첫 설치는 새로고침할 필요가 없다(다음 업데이트부터는 새로고침)
      return;
    }
    if (onBoard()) window.location.reload();
    else pendingReload = true;
  });
  window.addEventListener('hashchange', () => {
    if (pendingReload && onBoard()) window.location.reload();
  });
  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
    .then((reg) => {
      registration = reg;
      // 거실 화면은 며칠씩 켜져 있으므로 1시간마다 새 버전을 확인한다.
      setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    })
    .catch(() => undefined);
}

/** 설정 화면의 '새 버전 확인': 서버의 sw.js 빌드 ID가 지금 화면과 다르면 새 버전을 적용하고 true */
export async function checkForUpdate(): Promise<boolean> {
  let latest: string | null = null;
  try {
    const text = await (await fetch(`${import.meta.env.BASE_URL}sw.js`, { cache: 'no-store' })).text();
    latest = text.match(/mgfb-shell-(\d+)/)?.[1] ?? null;
  } catch {
    return false;
  }
  if (!latest || latest === BUILD_ID) return false;
  await registration?.update().catch(() => undefined);
  (registration?.waiting ?? registration?.installing)?.postMessage('SKIP_WAITING');
  // 서비스 워커 교체가 오래 걸리면 직접 새로고침한다
  setTimeout(() => window.location.reload(), 4000);
  return true;
}

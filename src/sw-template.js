// 몽글 패밀리보드 서비스 워커: 앱 셸 + 같은 출처 정적 파일만 캐시한다.
// 다른 출처와 POST는 가로채지 않으며, /api 응답(로그인·가족 데이터)은 캐시하지 않는다.
const VERSION = 'mgfb-shell-__BUILD_ID__'; // 빌드마다 바뀐다(vite.config.ts swPlugin)
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/\/api(\/|$)/.test(url.pathname)) return; // API(로그인·가족 데이터)는 절대 캐시하지 않는다
  if (req.mode === 'navigate') {
    // 네트워크 우선, 실패하면 캐시된 앱 셸
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }
  // 정적 파일: 캐시 우선 + 백그라운드 갱신
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});

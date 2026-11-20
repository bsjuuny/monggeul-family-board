/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const BUILD_ID = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

/** 서비스 워커를 빌드 ID와 함께 dist/sw.js 로 내보낸다(캐시 이름이 빌드마다 바뀌어 새 버전이 확실히 적용된다). */
function swPlugin(): Plugin {
  return {
    name: 'mgfb-sw',
    apply: 'build',
    generateBundle() {
      const src = readFileSync(new URL('./src/sw-template.js', import.meta.url), 'utf8').replace('__BUILD_ID__', BUILD_ID);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

/** 빌드 결과 index.html에 CSP를 넣는다. 같은 origin(태블릿 서버)에만 연결한다. */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return {
    name: 'mgfb-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
  };
}

// 태블릿 서버(tablet_server/app.py)가 dist/ 를 루트(/)에서 제공한다. 상대 base라 어느 LAN 주소에서도 동작한다.
// 개발 중에는 `npm run dev`가 /api 를 태블릿 서버(8787)로 프록시한다.
export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin(), swPlugin()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { sourcemap: false, target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    testTimeout: 30000,
    css: false,
  },
});

// 서버 자동 수집용 공지 분석기 번들: dist-server/analyze.mjs (node 로 실행)
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node18',
    sourcemap: false,
    minify: false,
    lib: { entry: 'src/notices/node-entry.ts', formats: ['es'], fileName: () => 'analyze.mjs' },
  },
});

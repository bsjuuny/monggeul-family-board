import { defineConfig, devices } from '@playwright/test';

// 실제 태블릿 서버(Python)가 dist를 서빙한다. 임시 DB + 테스트 계정은 tablet_server/tools/e2e_server.py
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: process.env.MGFB_E2E_EXTERNAL
    ? undefined
    : {
        command: 'python tablet_server/tools/e2e_server.py',
        url: 'http://127.0.0.1:4173/api/health',
        reuseExistingServer: false,
        timeout: 30_000,
      },
  projects: [
    { name: 'mobile-360', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 800 } } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1024', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 900 } } },
    { name: 'tv-1920', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
  ],
});

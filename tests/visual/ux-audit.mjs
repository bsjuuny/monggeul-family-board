// UI 점검용 전체 페이지 캡처: node tests/visual/ux-audit.mjs <baseURL> <outDir>
import { chromium } from '@playwright/test';
const [BASE, OUT] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 }, baseURL: BASE });
const page = await ctx.newPage();
await page.goto('./#/login');
await page.getByLabel('ID', { exact: true }).fill('owner');
await page.getByLabel('비밀번호').fill('qa-owner-pass');
await page.getByRole('button', { name: '로그인', exact: true }).click();
await page.getByTestId('v2-board').waitFor();
const notices = await (await page.request.get('/api/notices')).json();
const id = notices.notices[0]?.id;
for (const [name, path] of [['settings', '/settings'], ['notices', '/notices'], ['notice-new', '/notices/new'], ['notice-detail', `/notices/${id}`], ['notice-import', '/notices/import'], ['prep', '/prep'], ['calendar', '/calendar'], ['tasks', '/tasks'], ['kids', '/kids'], ['overview', '/overview']]) {
  await page.evaluate((p) => { window.location.hash = p; }, path);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}
await browser.close();
console.log('ok');

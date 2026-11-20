// 상세 화면 캡처(qa_server 예시 데이터): node tests/visual/pages.mjs <baseURL> [outDir]
import { chromium } from '@playwright/test';
const [BASE = 'http://127.0.0.1:4174/', OUT = 'docs/v2/screenshots'] = process.argv.slice(2);
const browser = await chromium.launch();
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto('./#/login');
  await page.getByLabel('ID', { exact: true }).fill('owner');
  await page.getByLabel('비밀번호').fill('qa-owner-pass');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByTestId('v2-board').waitFor();
  const notices = await (await page.request.get('/api/notices')).json();
  const id = notices.notices[0]?.id;
  for (const [name, path] of [['notices', '/notices'], ['notice-detail', `/notices/${id}`], ['prep', '/prep'], ['settings', '/settings'], ['overview', '/overview'], ['calendar', '/calendar']]) {
    await page.evaluate((p) => { window.location.hash = p; }, path);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/page-${name}-${w}x${h}.png` });
  }
  await ctx.close();
}
await browser.close();
console.log('ok');

// 상태 화면 캡처: 빈 상태(qa_server --empty) · 오프라인(seed 서버에서 네트워크 끊기)
//   node tests/visual/states.mjs <emptyBaseURL> <seededBaseURL> [outDir]
import { chromium } from '@playwright/test';
const [EMPTY, SEEDED, OUT = 'docs/v2/screenshots'] = process.argv.slice(2);
const browser = await chromium.launch();
async function open(base, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, baseURL: base });
  const page = await ctx.newPage();
  await page.goto('./#/login');
  await page.getByLabel('ID', { exact: true }).fill('owner');
  await page.getByLabel('비밀번호').fill('qa-owner-pass');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  return { ctx, page };
}
// 빈 서버는 가족이 없으므로 먼저 만든다
{
  const { ctx, page } = await open(EMPTY, 1280, 800);
  const setup = page.getByRole('heading', { name: '가족을 만들어 볼까요?' });
  await setup.or(page.getByTestId('v2-board')).waitFor();
  if (await setup.isVisible()) {
    await page.getByLabel('가족 이름 (필수)').fill('몽글네');
    await page.getByRole('button', { name: '가족 만들기', exact: true }).click();
  }
  await page.getByTestId('v2-board').waitFor();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/state-empty-1280x800.png` });
  await ctx.close();
}
{
  const { ctx, page } = await open(SEEDED, 1280, 800);
  await page.getByTestId('v2-board').waitFor();
  await ctx.setOffline(true);
  await page.getByTestId('v2-banner').waitFor();
  await page.waitForTimeout(500);
  console.log('offline overflow:', await page.evaluate(() => [...document.querySelectorAll('.v2-card')].filter((c) => c.scrollHeight > c.clientHeight + 2).map((c) => c.className)));
  await page.screenshot({ path: `${OUT}/state-offline-1280x800.png` });
  await ctx.close();
}
{
  const { ctx, page } = await open(SEEDED, 1920, 1080);
  await page.goto('./#/notices');
  await page.getByTestId('notices-page').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/page-notices-1920x1080.png` });
  await ctx.close();
}
await browser.close();
console.log('ok');

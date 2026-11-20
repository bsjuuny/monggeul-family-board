// 보드 검수 캡처(시간대 3개 × 크기): node tests/visual/ux-board.mjs <baseURL> <outDir> [WxH ...]
import { chromium } from '@playwright/test';
const [BASE, OUT, ...sizes] = process.argv.slice(2);
const browser = await chromium.launch();
for (const sz of sizes.length ? sizes : ['1000x640']) {
  const [w, h] = sz.split('x').map(Number);
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, baseURL: BASE })).newPage();
  await page.goto('./#/login');
  await page.getByLabel('ID', { exact: true }).fill('owner');
  await page.getByLabel('비밀번호').fill('qa-owner-pass');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByTestId('v2-board').waitFor();
  await page.waitForTimeout(1200);
  for (const [p, id] of [['아침', 'morning'], ['오후', 'afternoon'], ['저녁', 'evening']]) {
    await page.getByTestId(`period-${id}`).click();
    await page.waitForTimeout(500);
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.v2-card')].map((c) => {
      const r = c.getBoundingClientRect();
      const over = [...c.querySelectorAll('*')].filter((e) => { const q = e.getBoundingClientRect(); return q.height > 0 && q.bottom > r.bottom + 1 && getComputedStyle(e).position !== 'absolute'; }).map((e) => e.className || e.tagName).slice(0, 3);
      return over.length ? `${c.className.split(' ')[1]}: ${over.join(',')}` : null;
    }).filter(Boolean));
    console.log(sz, p, clipped.length ? 'CLIPPED ' + clipped.join(' | ') : 'ok', 'scroll', await page.evaluate(() => document.documentElement.scrollHeight));
    await page.screenshot({ path: `${OUT}/board-${sz}-${p}.png` });
  }
}
await browser.close();

// 화면 QA 캡처: tablet_server/tools/qa_server.py(예시 데이터, 가짜 날씨)를 먼저 띄운 뒤 실행한다.
//   node tests/visual/capture.mjs [baseURL] [outDir] [scale]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4174/';
const OUT = process.argv[3] ?? 'docs/v2/screenshots';
const SCALE = Number(process.argv[4] ?? 1);
const VIEWPORTS = [[1920, 1080], [1280, 800], [1024, 768], [768, 1024], [390, 844], [360, 800]];
const TIMES = { morning: '08:05', afternoon: '15:10', evening: '19:30' };
mkdirSync(OUT, { recursive: true });

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const browser = await chromium.launch();
const report = [];
for (const [w, h] of VIEWPORTS) {
  for (const [period, hm] of Object.entries(TIMES)) {
    if (w < 1000 && period !== 'morning' && !(w === 390)) continue; // 작은 화면은 아침만(390은 전부)
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: SCALE, baseURL: BASE });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date(`${today}T${hm}:00+09:00`));
    await page.goto('./#/login');
    await page.getByLabel('ID', { exact: true }).fill('owner');
    await page.getByLabel('비밀번호').fill('qa-owner-pass');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByTestId('v2-board').waitFor();
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({
      hScroll: document.documentElement.scrollWidth > window.innerWidth,
      vScroll: document.documentElement.scrollHeight > window.innerHeight + 1,
      overflowing: [...document.querySelectorAll('.v2-card')].filter((c) => c.scrollHeight > c.clientHeight + 2).map((c) => c.className.split(' ')[1]),
    }));
    report.push({ viewport: `${w}x${h}`, period, ...m });
    await page.screenshot({ path: `${OUT}/board-${w}x${h}-${period}.png`, fullPage: w <= 600 });
    await ctx.close();
  }
}
console.log(JSON.stringify(report, null, 1));
await browser.close();

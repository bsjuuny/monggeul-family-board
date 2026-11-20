// 추가 대화상자 캡처: node tests/visual/ux-dialogs.mjs <baseURL> <outDir>
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
for (const [name, path, btn] of [['dlg-event', '/calendar', '일정 추가'], ['dlg-task', '/tasks', '할 일 추가']]) {
  await page.evaluate((p) => { window.location.hash = p; }, path);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: btn }).first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await page.keyboard.press('Escape');
}
await browser.close();
console.log('ok');

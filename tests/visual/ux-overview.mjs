// 이번 주 화면 한 화면 확인: node tests/visual/ux-overview.mjs <baseURL> <out.png>
import { chromium } from '@playwright/test';
const [BASE, OUT] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 }, baseURL: BASE })).newPage();
await page.goto('./#/login');
await page.getByLabel('ID', { exact: true }).fill('owner');
await page.getByLabel('비밀번호').fill('qa-owner-pass');
await page.getByRole('button', { name: '로그인', exact: true }).click();
await page.waitForTimeout(1500);
if (process.env.CLEAR_EVENTS) await page.evaluate(async () => { const s = await (await fetch('/api/state')).json(); s.data.events = []; await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseVersion: s.version, data: s.data }) }); });
await page.evaluate(() => { window.location.hash = '/overview'; });
await page.reload();
await page.waitForTimeout(1200);
const h = await page.evaluate(() => document.documentElement.scrollHeight);
console.log('scrollHeight', h);
await page.screenshot({ path: OUT });
await browser.close();

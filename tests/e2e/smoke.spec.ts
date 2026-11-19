import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// 실제 Python 태블릿 서버 + 임시 SQLite (tablet_server/tools/e2e_server.py). 계정은 그 스크립트와 같아야 한다.
const OWNER = { id: 'owner', pw: 'e2e-owner-pass' };
const MOM = { id: 'mom', pw: 'e2e-mom-pass-1' };

async function login(page: Page, who: { id: string; pw: string }) {
  await page.goto('./#/login');
  await expect(page.getByTestId('server-ok')).toBeVisible();
  await page.getByLabel('ID', { exact: true }).fill(who.id);
  await page.getByLabel('비밀번호').fill(who.pw);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

async function enter(page: Page, who = OWNER) {
  await login(page, who);
  // 로그인 직후 잠깐 거치는 #/ 를 완료 상태로 오인하지 않도록 실제 화면이 뜰 때까지 기다린다.
  // 서버 문서에 가족이 아직 없으면 첫 로그인 사용자가 만든다. 이미 있으면 바로 홈.
  const setupHeading = page.getByRole('heading', { name: '가족을 만들어 볼까요?' });
  const homeHeading = page.getByRole('heading', { name: /월 .*일/ });
  await expect(setupHeading.or(homeHeading)).toBeVisible();
  if (await setupHeading.isVisible()) {
    await page.getByLabel('가족 이름 (필수)').fill('몽글네');
    await page.getByRole('button', { name: '가족 만들기', exact: true }).click();
  }
  await expect(homeHeading).toBeVisible();
}

async function addTask(page: Page, title: string) {
  await page.getByRole('link', { name: '할 일', exact: true }).click();
  await page.getByRole('button', { name: /할 일 추가/ }).first().click();
  await page.getByLabel('제목 (1~120자)').fill(title);
  await page.getByRole('button', { name: '저장', exact: true }).click();
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:4173/' });
  return { ctx, page: await ctx.newPage() };
}

test('F-01 로그인 후 가족을 만들고 주요 화면을 탐색한다', async ({ page }) => {
  await enter(page);
  await expect(page.getByText('몽글 패밀리보드').first()).toBeVisible();
  await page.getByRole('link', { name: '캘린더', exact: true }).click();
  await expect(page.getByRole('heading', { name: '캘린더' })).toBeVisible();
  await page.getByRole('link', { name: '할 일', exact: true }).click();
  await expect(page.getByRole('heading', { name: '할 일 · 장보기' })).toBeVisible();
  await page.getByRole('link', { name: '아이', exact: true }).click();
  await expect(page.getByRole('heading', { name: '아이' })).toBeVisible();
  await page.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible();
  await expect(page.getByTestId('server-status')).toContainText('연결됨');
});

test('각 기준 뷰포트에서 가로 오버플로가 없다', async ({ page }) => {
  await enter(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('link', { name: '설정', exact: true }).click();
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('잘못된 비밀번호는 오류를 보여 주고 로그인되지 않는다', async ({ page }) => {
  await login(page, { id: 'owner', pw: 'wrong-password' });
  await expect(page.getByRole('alert').filter({ hasText: '올바르지 않아요' })).toBeVisible();
  await expect(page).toHaveURL(/#\/login$/);
});

test('서버가 없으면 조용히 로컬 모드로 넘어가지 않고 연결 오류를 안내한다', async ({ page }) => {
  await page.route('**/api/**', (r) => r.abort());
  await page.goto('./#/login');
  await expect(page.getByTestId('server-down')).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: /이 기기에서 바로 시작/ })).toHaveCount(0);
  await page.goto('./#/tasks');
  await expect(page.getByText('태블릿 서버에 연결할 수 없어요')).toBeVisible();
});

test('데이터는 서버에 저장되고 새로고침(hash route)·재접속 뒤에도 남으며 브라우저에는 문서를 두지 않는다', async ({ page, browser }) => {
  await enter(page);
  const title = `서버저장-${Date.now()}`;
  await addTask(page, title);
  await expect(page.getByText(title)).toBeVisible();
  await page.reload(); // 쿠키 세션 + 서버 문서에서 복원 (AC-07)
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByText(title)).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mgfb:demo')))).toEqual([]);
  const other = await newPage(browser); // 다른 기기
  await enter(other.page, MOM);
  await other.page.getByRole('link', { name: '할 일', exact: true }).click();
  await expect(other.page.getByText(title)).toBeVisible();
  await other.ctx.close();
});

test('로그아웃하면 로그인 화면으로 가고 서버 세션이 폐기된다', async ({ page }) => {
  await enter(page);
  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page).toHaveURL(/#\/login$/);
  const res = await page.request.get('/api/me');
  expect(res.status()).toBe(401);
});

test('TV 미리보기에는 공개 정보만 표시한다', async ({ page }) => {
  await enter(page);
  await page.getByRole('link', { name: /TV 화면 미리보기/ }).click();
  await expect(page.getByTestId('tv-display')).toBeVisible();
  await expect(page.getByText('비공개')).toHaveCount(0);
});

test('409 충돌: 다른 기기가 먼저 저장하면 덮어쓰지 않고 충돌 UI와 내 JSON 백업을 보여 준다', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop-1024', '한 뷰포트에서만 실행');
  const a = await newPage(browser);
  const b = await newPage(browser);
  await enter(a.page, OWNER);
  await enter(b.page, MOM);
  await a.page.reload(); // B의 접속(구성원 연결)이 올린 version을 받는다
  await expect(a.page.getByRole('heading', { name: /월 .*일/ })).toBeVisible();
  const stamp = Date.now();
  await addTask(a.page, `A할일-${stamp}`);
  await expect(a.page.getByText(`A할일-${stamp}`)).toBeVisible();

  // B는 아직 이전 version을 들고 있다
  await addTask(b.page, `B할일-${stamp}`);
  // 충돌 시 입력 폼과 값은 보존한다. 사용자가 확인한 뒤 폼을 닫아 배너 작업을 진행한다.
  await expect(b.page.getByRole('alert').filter({ hasText: '다른 사람이 먼저 수정했어요' })).toBeVisible();
  await expect(b.page.getByLabel('제목 (1~120자)')).toHaveValue(`B할일-${stamp}`);
  await b.page.getByRole('button', { name: '취소', exact: true }).click();
  const banner = b.page.getByTestId('conflict-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('덮어쓰지 않았어요');
  const [download] = await Promise.all([b.page.waitForEvent('download'), banner.getByRole('button', { name: '내 JSON 백업' }).click()]);
  const mine = JSON.parse(readFileSync(await download.path(), 'utf-8')) as { format: string; data: unknown };
  expect(mine.format).toBe('monggeul-family-board-backup');
  expect(JSON.stringify(mine.data)).toContain(`B할일-${stamp}`);

  // 서버에는 A의 변경만 있다
  await banner.getByRole('button', { name: '서버 값 다시 불러오기' }).click();
  await expect(banner).toHaveCount(0);
  await expect(b.page.getByText(`A할일-${stamp}`)).toBeVisible();
  await expect(b.page.getByText(`B할일-${stamp}`)).toHaveCount(0);
  await a.ctx.close();
  await b.ctx.close();
});

test('owner는 JSON 백업·복원을 할 수 있고 일반 성인은 할 수 없다', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop-1024', '한 뷰포트에서만 실행');
  const o = await newPage(browser);
  await enter(o.page, OWNER);
  await o.page.getByRole('link', { name: '설정', exact: true }).click();
  const [dl] = await Promise.all([o.page.waitForEvent('download'), o.page.getByRole('button', { name: 'JSON 백업 내려받기' }).click()]);
  const backupPath = await dl.path();
  const stamp = `복원전후-${Date.now()}`;
  await addTask(o.page, stamp);
  await expect(o.page.getByText(stamp)).toBeVisible();
  await o.page.getByRole('link', { name: '설정', exact: true }).click();
  await o.page.locator('input[type=file]').setInputFiles(backupPath);
  await o.page.getByRole('button', { name: '복원', exact: true }).click();
  await expect(o.page.getByText('백업을 복원했어요.')).toBeVisible();
  await o.page.getByRole('link', { name: '할 일', exact: true }).click();
  await expect(o.page.getByText(stamp)).toHaveCount(0); // 백업 시점으로 돌아갔다

  const m = await newPage(browser);
  await enter(m.page, MOM);
  await m.page.getByRole('link', { name: '설정', exact: true }).click();
  await expect(m.page.getByRole('button', { name: 'JSON 백업 내려받기' })).toBeDisabled();
  await expect(m.page.getByRole('button', { name: 'JSON 복원…' })).toBeDisabled();
  await o.ctx.close();
  await m.ctx.close();
});

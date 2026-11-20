import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v2 보드 흐름: 실제 Python 서버 + 임시 SQLite (tablet_server/tools/run_e2e.py)
const OWNER = { id: 'owner', pw: 'e2e-owner-pass' };
const kst = (d = 0) => new Date(Date.now() + 9 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);

async function enter(page: Page) {
  await page.goto('./#/login');
  await expect(page.getByTestId('server-ok')).toBeVisible();
  await page.getByLabel('ID', { exact: true }).fill(OWNER.id);
  await page.getByLabel('비밀번호').fill(OWNER.pw);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  const setup = page.getByRole('heading', { name: '가족을 만들어 볼까요?' });
  const board = page.getByTestId('v2-board');
  await expect(setup.or(board)).toBeVisible();
  if (await setup.isVisible()) {
    await page.getByLabel('가족 이름 (필수)').fill('몽글네');
    await page.getByRole('button', { name: '가족 만들기', exact: true }).click();
  }
  await expect(board).toBeVisible();
}

/** 아이 한 명과 등하원 시간을 API로 넣는다(PIN 화면을 거치지 않기 위해) */
async function seedChild(page: Page) {
  const st = await (await page.request.get('/api/state')).json();
  if (!st.data.children.some((c: { id: string }) => c.id === 'kid-e2e')) {
    st.data.children.push({ familyId: st.data.families[0].id, id: 'kid-e2e', displayName: '서윤', avatarKey: 'bodeuli', active: true });
    expect((await page.request.put('/api/state', { data: { baseVersion: st.version, data: st.data } })).status()).toBe(200);
  }
  const s = await (await page.request.get('/api/settings')).json();
  const res = await page.request.put('/api/settings/commute', {
    data: { baseVersion: s._versions.commute, value: { children: { 'kid-e2e': { weekdays: [1, 2, 3, 4, 5, 6, 7], leaveHomeAt: '08:30', arriveBy: '09:00', pickupAt: '16:30', pickupAssignee: '엄마' } } } },
  });
  expect(res.status()).toBe(200);
}

test('보드: 가로 스크롤 없음, 태블릿·TV는 세로 스크롤도 없음, 시간대 전환', async ({ page }, info) => {
  await enter(page);
  await seedChild(page);
  await page.reload();
  await expect(page.getByTestId('v2-board')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/\d+월 \d+일 .요일/);
  const m = await page.evaluate(() => ({ h: document.documentElement.scrollWidth > window.innerWidth, v: document.documentElement.scrollHeight > window.innerHeight + 1 }));
  expect(m.h).toBe(false);
  if (info.project.name !== 'mobile-360') expect(m.v).toBe(false);
  await page.getByTestId('period-evening').click();
  await expect(page.getByRole('tab', { name: '저녁' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('commute-view')).toContainText('내일 등원');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '오후' })).toHaveAttribute('aria-selected', 'true');
  // 날씨 지역을 정하지 않았으면 추측하지 않고 설정을 안내한다
  await expect(page.getByText('날씨 지역을 정해 주세요')).toBeVisible();
});

test('공지 붙여넣기 → 분석 → 확인 필요 → 확인 → 보드·준비물·캘린더 반영', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1024', '한 뷰포트에서만 실행');
  await enter(page);
  await seedChild(page);
  await page.reload(); // 화면이 가진 가족 문서 version 을 서버와 맞춘다
  await expect(page.getByTestId('v2-board')).toBeVisible();
  const tomorrow = kst(1);
  const [, mm, dd] = tomorrow.split('-').map(Number);
  await page.goto('./#/notices/new');
  await page.getByLabel('공지 내용').fill(`${mm}월 ${dd}일 숲 체험이 있습니다. 개인 물통과 여벌옷을 보내주세요. 이날은 오후 1시에 조기 하원합니다.`);
  await page.getByRole('button', { name: '분석하기' }).click();
  await expect(page.getByLabel('행사 날짜')).toHaveValue(tomorrow);
  await expect(page.getByLabel('준비물 1 내용')).toHaveValue('물통');
  await expect(page.getByLabel('하원 시간 변경 시각')).toHaveValue('13:00');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByTestId('notice-detail')).toBeVisible();
  await expect(page.getByText('확인할 것:')).toContainText('조기 하원');
  // 확인 전: 하원 변경은 확인 필요로 표시
  const commute = await (await page.request.get(`/api/commute?from=${tomorrow}&to=${tomorrow}`)).json();
  expect(commute.days[0].plans[0]).toMatchObject({ pickupAt: '13:00', needsReview: true });
  await page.getByTestId('notice-confirm').click();
  await expect(page.getByText('확인함')).toBeVisible();
  // 확인하면 행사가 캘린더에 들어간다(공지에서 가져온 일정)
  await expect.poll(async () => {
    const ev = await (await page.request.get(`/api/notice-events?from=${tomorrow}&to=${tomorrow}`)).json();
    return ev.events[0]?.calendarEventId ?? null;
  }).not.toBeNull();
  const st = await (await page.request.get('/api/state')).json();
  expect(st.data.events.some((e: { note: string }) => e.note === '공지에서 가져온 일정')).toBe(true);
  // 같은 공지를 다시 넣으면 중복 저장하지 않는다
  await page.goto('./#/notices/new');
  await page.getByLabel('공지 내용').fill(`${mm}월 ${dd}일 숲 체험이 있습니다. 개인 물통과 여벌옷을 보내주세요. 이날은 오후 1시에 조기 하원합니다.`);
  await page.getByRole('button', { name: '분석하기' }).click();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('이미 저장된 공지예요')).toBeVisible();
  const list = await (await page.request.get('/api/notices')).json();
  expect(list.notices).toHaveLength(1);
  // 보드 저녁 화면: 내일 준비물 칩, 체크하면 완료
  await page.goto('./#/');
  await page.getByTestId('period-evening').click();
  const chip = page.getByTestId('prep-chip').filter({ hasText: '물통' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
});

test('TV 연결: 코드로 연결하면 로그인 없이 보드만 보이고 관리 API는 막힌다', async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'tv-1920', 'TV 뷰포트에서만 실행');
  await enter(page);
  await page.goto('./#/settings');
  await page.getByTestId('make-pair-code').click();
  const code = (await page.getByTestId('pair-code').innerText()).slice(0, 6);
  const tv = await browser.newContext({ baseURL: 'http://127.0.0.1:4173/', viewport: { width: 1920, height: 1080 } });
  const tvPage = await tv.newPage();
  await tvPage.goto('./#/display');
  await expect(tvPage.getByTestId('tv-pair')).toBeVisible();
  await tvPage.getByLabel('연결 코드').fill(code);
  await tvPage.getByRole('button', { name: 'TV로 연결' }).click();
  await expect(tvPage.getByTestId('tv-display')).toBeVisible();
  // TV는 읽기 전용: 공지 제목은 보이지만 눌러서 들어가는 링크·준비물 체크 버튼은 없다
  await expect(tvPage.locator('a.v2-notice')).toHaveCount(0);
  await expect(tvPage.locator('.v2-chip--prep button')).toHaveCount(0);
  expect((await tvPage.request.get('/api/state')).status()).toBe(401);
  expect((await tvPage.request.get('/api/notices')).status()).toBe(401);
  // 새로고침해도 연결이 유지된다(HttpOnly 기기 쿠키)
  await tvPage.reload();
  await expect(tvPage.getByTestId('tv-display')).toBeVisible();
  // 보호자가 연결을 해제하면 TV는 다시 연결 화면으로
  const devices = await (await page.request.get('/api/devices')).json();
  await page.request.delete(`/api/devices/${devices.devices[0].id}`);
  await tvPage.reload();
  await expect(tvPage.getByTestId('tv-pair')).toBeVisible();
  await tv.close();
});

test('공지톡 내보내기 파일 가져오기: 미리보기 → 가져오기 → 다시 올리면 이미 있음', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1024', '한 뷰포트에서만 실행');
  await enter(page);
  const stamp = Date.now();
  const file = join(mkdtempSync(join(tmpdir(), 'gjt-')), 'gongjitalk-notices.json');
  writeFileSync(file, JSON.stringify({ format: 'gongjitalk-export', version: 1, exportedAt: new Date().toISOString(), notices: [
    { id: `notice-${stamp}`, createdAt: new Date().toISOString(), originalText: `내일 수영 수업이 있습니다. 수영복과 수건을 챙겨 보내주세요. (${stamp})`, summary: '', checklistItems: [] },
    { id: 'broken', createdAt: 'nope' },
  ] }));
  await page.goto('./#/notices/import');
  await page.getByLabel('내보내기 파일').setInputFiles(file);
  const card = page.getByRole('region', { name: '가져오기 미리보기' });
  await expect(card).toContainText('새 공지 1건');
  await expect(card).toContainText('형식 오류 1건');
  await card.getByRole('button', { name: '1건 가져오기' }).click();
  await expect(page.getByRole('region', { name: '가져오기 미리보기' })).toContainText('새로 1건');
  const list = await (await page.request.get('/api/notices')).json();
  const mine = list.notices.find((n: { sourceId: string }) => n.sourceId === `notice-${stamp}`);
  expect(mine).toMatchObject({ source: 'gongjitalk', hasOriginal: false, title: '수영 수업' });
  await page.goto('./#/notices');
  await page.goto('./#/notices/import');
  await page.getByLabel('내보내기 파일').setInputFiles(file);
  await expect(page.getByRole('region', { name: '가져오기 미리보기' })).toContainText('이미 있음 1건');
});

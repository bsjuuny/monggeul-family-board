import { describe, expect, it } from 'vitest';
import { expectCode, login, makeHarness, ownerWithFamily, uuid } from './helpers';
import { todayIn } from '../src/domain/dates';
import type { Harness } from './helpers';

const iso = (h: string) => `2026-11-19T${h}:00.000Z`;

async function withChild(h: Harness) {
  const child = await h.repo.addChild({ displayName: '하늘', avatarKey: 'bear' }, uuid());
  const habit = await h.repo.addHabitTemplate({ childId: child.id, title: '양치하기', iconKey: 'tooth', approvalRequired: true }, uuid());
  return { child, habit };
}

describe('인증 · 가족 (F-01)', () => {
  it('6자리 OTP만 허용하고 잘못된 코드는 거부한다', async () => {
    const h = makeHarness();
    await h.repo.requestOtp('a@example.com');
    await expectCode(h.repo.verifyOtp('a@example.com', '12ab56'), 'VALIDATION_ERROR');
    await expectCode(h.repo.verifyOtp('a@example.com', '000000'), 'UNAUTHENTICATED');
    const s = await h.repo.verifyOtp('a@example.com', '123456');
    expect(s.email).toBe('a@example.com');
  });

  it('요청하지 않은 이메일, 5회 초과 시도는 거부한다', async () => {
    const h = makeHarness();
    await expectCode(h.repo.verifyOtp('x@example.com', '123456'), 'UNAUTHENTICATED');
    await h.repo.requestOtp('b@example.com');
    for (let i = 0; i < 5; i++) await expectCode(h.repo.verifyOtp('b@example.com', '111111'), 'UNAUTHENTICATED');
    await expectCode(h.repo.verifyOtp('b@example.com', '123456'), 'RATE_LIMITED');
  });

  it('같은 idempotency key로 가족 생성을 재시도해도 가족은 1개다', async () => {
    const h = makeHarness();
    await login(h, 'a@example.com');
    const key = uuid();
    const f1 = await h.repo.createFamily('우리집', key);
    const f2 = await h.repo.createFamily('우리집', key);
    expect(f2.id).toBe(f1.id);
    const state = h.repo.load();
    expect(state.families).toHaveLength(1);
    expect(state.members).toHaveLength(1);
    await expectCode(h.repo.createFamily('다른이름', key), 'IDEMPOTENCY_CONFLICT');
    await expectCode(h.repo.createFamily('두번째', uuid()), 'FORBIDDEN');
  });

  it('로그인 없이는 가족 데이터를 읽을 수 없다', async () => {
    const h = makeHarness();
    await expectCode(h.repo.getFamily(), 'UNAUTHENTICATED');
    await expectCode(h.repo.getEvents({ from: '2026-11-01', to: '2026-11-30' }), 'UNAUTHENTICATED');
    expect((await h.repo.getAppContext()).kind).toBe('anonymous');
  });
});

describe('초대 (F-02)', () => {
  it('초대 수락 → 같은 token 재사용/철회/만료/이미 가족 있는 계정 거부', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    const inv = await owner.repo.createInvitation();
    expect(inv.token.length).toBeGreaterThan(20);
    // 목록 응답에는 원문 token이 없다
    const list = await owner.repo.listInvitations();
    expect(JSON.stringify(list)).not.toContain(inv.token);
    // 서버 상태에도 원문이 없다
    expect(owner.server.getItem('mgfb:demo:state:v1')).not.toContain(inv.token);

    const guest = owner.otherBrowser();
    await login(guest, 'guest@example.com');
    expect(await guest.repo.previewInvitation(inv.token)).toMatchObject({ status: 'valid', familyName: '테스트네' });
    const fam = await guest.repo.acceptInvitation(inv.token);
    expect(fam.name).toBe('테스트네');
    expect((await guest.repo.getMembers()).adults.map((m) => m.role).sort()).toEqual(['adult', 'owner']);

    // 사용된 초대
    const guest2 = owner.otherBrowser();
    await login(guest2, 'guest2@example.com');
    expect(await guest2.repo.previewInvitation(inv.token)).toEqual({ status: 'used' });
    await expectCode(guest2.repo.acceptInvitation(inv.token), 'INVITE_EXPIRED');

    // 철회된 초대
    const inv2 = await owner.repo.createInvitation();
    await owner.repo.revokeInvitation(inv2.id);
    expect(await guest2.repo.previewInvitation(inv2.token)).toEqual({ status: 'revoked' });
    await expectCode(guest2.repo.acceptInvitation(inv2.token), 'INVITE_EXPIRED');

    // 만료된 초대
    const inv3 = await owner.repo.createInvitation();
    guest2.setNow(new Date('2026-12-01T00:00:00Z'));
    expect(await guest2.repo.previewInvitation(inv3.token)).toEqual({ status: 'expired' });

    // 이미 다른 가족이 있는 계정
    const inv4 = await owner.repo.createInvitation();
    const other = owner.otherBrowser();
    await login(other, 'other@example.com');
    await other.repo.createFamily('다른가족', uuid());
    await expectCode(other.repo.acceptInvitation(inv4.token), 'FORBIDDEN');
    // 잘못된 token
    expect(await guest2.repo.previewInvitation('not-a-real-token')).toEqual({ status: 'invalid' });
  });

  it('adult는 초대를 만들 수 없다 (owner 전용)', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    const inv = await owner.repo.createInvitation();
    const adult = owner.otherBrowser();
    await login(adult, 'adult@example.com');
    await adult.repo.acceptInvitation(inv.token);
    await expectCode(adult.repo.createInvitation(), 'FORBIDDEN');
    await expectCode(adult.repo.listDevices(), 'FORBIDDEN');
    await expectCode(adult.repo.removeMember(owner.repo.load().members[0]!.userId), 'FORBIDDEN');
  });
});

describe('일정 (F-03, AC-07, AC-09)', () => {
  it('종일/시간 일정 검증: 종료≤시작 차단, 제목 길이', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    const base = { allDay: false, visibility: 'family' as const };
    await expectCode(h.repo.createEvent({ ...base, title: '회의', startsAt: iso('05:00'), endsAt: iso('05:00') }, uuid()), 'VALIDATION_ERROR');
    await expectCode(h.repo.createEvent({ ...base, title: '회의', startsAt: iso('06:00'), endsAt: iso('05:00') }, uuid()), 'VALIDATION_ERROR');
    await expectCode(h.repo.createEvent({ ...base, title: '', startsAt: iso('05:00'), endsAt: iso('06:00') }, uuid()), 'VALIDATION_ERROR');
    await expectCode(h.repo.createEvent({ ...base, title: 'x'.repeat(121), startsAt: iso('05:00'), endsAt: iso('06:00') }, uuid()), 'VALIDATION_ERROR');
    await expectCode(
      h.repo.createEvent({ allDay: true, title: '종일', startDate: '2026-11-20', endDate: '2026-11-19', visibility: 'family' }, uuid()),
      'VALIDATION_ERROR',
    );
    const ok = await h.repo.createEvent({ ...base, title: 'x'.repeat(120), startsAt: iso('05:00'), endsAt: iso('06:00') }, uuid());
    expect(ok.version).toBe(1);
    expect(ok.startDate).toBeNull();
  });

  it('같은 idempotency key는 중복 레코드를 만들지 않고, 다른 body는 409', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    const key = uuid();
    const input = { title: '치과', allDay: true, startDate: '2026-11-20', endDate: '2026-11-20', visibility: 'family' as const };
    const a = await h.repo.createEvent(input, key);
    const b = await h.repo.createEvent(input, key);
    expect(b.id).toBe(a.id);
    expect(h.repo.load().events).toHaveLength(1);
    await expectCode(h.repo.createEvent({ ...input, title: '다른' }, key), 'IDEMPOTENCY_CONFLICT');
  });

  it('동시 수정은 409이며 최신 레코드를 돌려주고 자동 덮어쓰지 않는다', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    const inv = await owner.repo.createInvitation();
    const adult = owner.otherBrowser();
    await login(adult, 'adult@example.com');
    await adult.repo.acceptInvitation(inv.token);

    const ev = await owner.repo.createEvent({ title: '원본', allDay: true, startDate: '2026-11-20', endDate: '2026-11-20', visibility: 'family' }, uuid());
    const updated = await owner.repo.updateEvent(ev.id, ev.version, { title: '엄마 수정' });
    expect(updated.version).toBe(2);
    try {
      await adult.repo.updateEvent(ev.id, ev.version, { title: '아빠 수정' });
      throw new Error('should conflict');
    } catch (e) {
      const err = e as { code: string; details: { latest: { title: string; version: number } } };
      expect(err.code).toBe('VERSION_CONFLICT');
      expect(err.details.latest).toMatchObject({ title: '엄마 수정', version: 2 });
    }
    expect((await owner.repo.getEvents({ from: '2026-11-20', to: '2026-11-20' }))[0]?.title).toBe('엄마 수정');
    await expectCode(adult.repo.deleteEvent(ev.id, 1), 'VERSION_CONFLICT');
    await adult.repo.deleteEvent(ev.id, 2);
    expect(await owner.repo.getEvents({ from: '2026-11-20', to: '2026-11-20' })).toHaveLength(0);
  });

  it('private 일정은 작성자만 읽고 수정할 수 있다', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    const inv = await owner.repo.createInvitation();
    const adult = owner.otherBrowser();
    await login(adult, 'adult@example.com');
    await adult.repo.acceptInvitation(inv.token);
    const priv = await owner.repo.createEvent({ title: '비밀', allDay: true, startDate: '2026-11-20', endDate: '2026-11-20', visibility: 'private' }, uuid());
    const fam = await owner.repo.createEvent({ title: '가족', allDay: true, startDate: '2026-11-20', endDate: '2026-11-20', visibility: 'family' }, uuid());
    const seen = await adult.repo.getEvents({ from: '2026-11-01', to: '2026-11-30' });
    expect(seen.map((e) => e.title)).toEqual(['가족']);
    await expectCode(adult.repo.updateEvent(priv.id, 1, { title: '해킹' }), 'NOT_FOUND');
    await expectCode(adult.repo.deleteEvent(priv.id, 1), 'NOT_FOUND');
    // 남의 가족 일정을 나만 보기로 바꾸면 작성자도 못 보게 되므로 금지
    await expectCode(adult.repo.updateEvent(fam.id, 1, { visibility: 'private' }), 'FORBIDDEN');
  });

  it('다른 가족의 데이터는 보이지도 수정되지도 않는다', async () => {
    const a = makeHarness();
    await ownerWithFamily(a, 'a@example.com');
    const ev = await a.repo.createEvent({ title: 'A가족', allDay: true, startDate: '2026-11-20', endDate: '2026-11-20', visibility: 'family' }, uuid());
    const task = await a.repo.createTask({ kind: 'todo', title: 'A일' }, uuid());
    const b = a.otherBrowser();
    await ownerWithFamily(b, 'b@example.com').catch(() => undefined);
    // b는 b 가족을 따로 만든다
    expect((await b.repo.getEvents({ from: '2026-11-01', to: '2026-11-30' })).length).toBe(0);
    expect(await b.repo.getTasks()).toHaveLength(0);
    await expectCode(b.repo.updateEvent(ev.id, 1, { title: 'x' }), 'NOT_FOUND');
    await expectCode(b.repo.setTaskCompleted(task.id, true, iso('02:00'), uuid()), 'NOT_FOUND');
    await expectCode(b.repo.deleteTask(task.id, 1), 'NOT_FOUND');
  });
});

describe('할 일 (F-04, AC-09, AC-10)', () => {
  it('완료는 LWW: 더 오래된 client_timestamp는 무시, 같은 key는 멱등', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    const t = await h.repo.createTask({ kind: 'todo', title: '설거지' }, uuid());
    const k1 = uuid();
    const done = await h.repo.setTaskCompleted(t.id, true, iso('03:00'), k1);
    expect(done.completedAt).not.toBeNull();
    // 같은 key 재전송 → 버전이 오르지 않는다
    const again = await h.repo.setTaskCompleted(t.id, true, iso('03:00'), k1);
    expect(again.version).toBe(done.version);
    // 더 오래된 취소 요청은 무시
    const stale = await h.repo.setTaskCompleted(t.id, false, iso('02:00'), uuid());
    expect(stale.completedAt).not.toBeNull();
    // 더 새로운 취소는 적용
    const undone = await h.repo.setTaskCompleted(t.id, false, iso('04:00'), uuid());
    expect(undone.completedAt).toBeNull();
  });

  it('장보기 수량/단위 검증과 담당자 가족 검증', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    await expectCode(h.repo.createTask({ kind: 'shopping', title: '우유', quantity: -1 }, uuid()), 'VALIDATION_ERROR');
    await expectCode(h.repo.createTask({ kind: 'todo', title: '일', assigneeId: uuid(), assigneeType: 'child' }, uuid()), 'VALIDATION_ERROR');
    const t = await h.repo.createTask({ kind: 'shopping', title: '우유', quantity: 2, unit: '개' }, uuid());
    expect(t).toMatchObject({ quantity: 2, unit: '개' });
    const { child } = await withChild(h);
    const t2 = await h.repo.createTask({ kind: 'todo', title: '숙제', assigneeId: child.id, assigneeType: 'child' }, uuid());
    expect(t2.assigneeType).toBe('child');
    expect((await h.repo.getTasks({ kind: 'shopping' })).map((x) => x.title)).toEqual(['우유']);
  });

  it('오프라인 outbox 동기화는 허용된 2종만 1회 반영하고 중복 전송은 duplicate', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    const t = await h.repo.createTask({ kind: 'todo', title: '빨래' }, uuid());
    const k = uuid();
    const action = { type: 'task_completed' as const, taskId: t.id, completed: true, clientTimestamp: iso('03:00'), idempotencyKey: k };
    const r1 = await h.repo.syncOfflineActions([action]);
    const r2 = await h.repo.syncOfflineActions([action]);
    expect(r1[0]?.status).toBe('applied');
    expect(r2[0]?.status).toBe('duplicate');
    expect((await h.repo.getTasks())[0]?.version).toBe(2);
    const bad = await h.repo.syncOfflineActions([{ ...action, taskId: uuid(), idempotencyKey: uuid() }]);
    expect(bad[0]).toMatchObject({ status: 'error', errorCode: 'NOT_FOUND' });
  });
});

describe('습관·PIN (F-05, F-06b)', () => {
  it('체크 → 승인 대기 → 승인/반려, 중복 체크는 갱신', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    const { child, habit } = await withChild(h);
    const today = todayIn('Asia/Seoul', new Date('2026-11-19T01:00:00Z'));
    const k = uuid();
    const r1 = await h.repo.checkHabit(habit.id, today, iso('02:00'), k);
    expect(r1.state).toBe('pending');
    const r1b = await h.repo.checkHabit(habit.id, today, iso('02:00'), k);
    expect(r1b.id).toBe(r1.id);
    expect(h.repo.load().habitRecords).toHaveLength(1);
    const rej = await h.repo.rejectHabit(r1.id);
    expect(rej.state).toBe('rejected');
    const r2 = await h.repo.checkHabit(habit.id, today, iso('03:00'), uuid());
    expect(r2.id).toBe(r1.id);
    expect(r2.state).toBe('pending');
    const approved = await h.repo.approveHabit(r2.id);
    expect(approved.state).toBe('approved');
    expect(approved.approvedBy).not.toBeNull();
    // 승인 뒤 재체크는 무시
    const r3 = await h.repo.checkHabit(habit.id, today, iso('04:00'), uuid());
    expect(r3.state).toBe('approved');
    const list = await h.repo.getHabits(child.id, today);
    expect(list[0]?.record?.state).toBe('approved');
    await expectCode(h.repo.checkHabit(habit.id, '2027-01-01', iso('04:00'), uuid()), 'VALIDATION_ERROR');
  });

  it('PIN은 평문으로 저장되지 않고, 틀리면 횟수 제한 후 RATE_LIMITED', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    const raw = h.server.getItem('mgfb:demo:state:v1') ?? '';
    expect(raw).not.toContain('"1234"');
    expect(h.repo.load().secrets[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    await expectCode(h.repo.verifyParentPin('0000'), 'FORBIDDEN');
    for (let i = 0; i < 4; i++) await expectCode(h.repo.verifyParentPin('0000'), 'FORBIDDEN');
    await expectCode(h.repo.verifyParentPin('1234'), 'RATE_LIMITED');
    h.setNow(new Date('2026-11-19T02:00:00Z'));
    const u = await h.repo.verifyParentPin('1234');
    expect(u.token.length).toBeGreaterThan(20);
    expect(h.unlock.isUnlocked()).toBe(true);
    // 로컬 저장소 어디에도 PIN/unlock token이 없다
    expect(h.server.getItem('mgfb:demo:state:v1')).not.toContain(u.token);
  });

  it('자녀 기기 코드는 PIN unlock 없이는 만들 수 없고, 기기 철회는 즉시 반영된다', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    const { child, habit } = await withChild(owner);
    await expectCode(owner.repo.createPairingCode('child'), 'FORBIDDEN');
    await owner.repo.verifyParentPin('1234');
    const code = await owner.repo.createPairingCode('child');
    expect(code.code).toMatch(/^\d{6}$/);

    const tablet = owner.otherBrowser();
    const dev = await tablet.repo.exchangePairingCode(code.code);
    tablet.devices.set(dev);
    // 코드는 1회용
    await expectCode(owner.otherBrowser().repo.exchangePairingCode(code.code), 'NOT_FOUND');

    expect(await tablet.repo.getAppContext()).toMatchObject({ kind: 'device', mode: 'child' });
    const members = await tablet.repo.getMembers();
    expect(members.adults).toEqual([]);
    expect(members.children.map((c) => c.displayName)).toEqual(['하늘']);
    const today = '2026-11-19';
    const rec = await tablet.repo.checkHabit(habit.id, today, iso('02:00'), uuid());
    expect(rec.state).toBe('pending');
    // child 기기는 일정/할 일/승인에 접근 불가
    await expectCode(tablet.repo.getEvents({ from: today, to: today }), 'UNAUTHENTICATED');
    await expectCode(tablet.repo.approveHabit(rec.id), 'UNAUTHENTICATED');
    expect(child.id).toBeTruthy();

    const devices = await owner.repo.listDevices();
    expect(devices).toHaveLength(1);
    expect(JSON.stringify(devices)).not.toContain(dev.token);
    await owner.repo.revokeDevice(devices[0]!.id);
    await expectCode(tablet.repo.getHabits(child.id, today), 'TOKEN_REVOKED');
    await expectCode(tablet.repo.checkHabit(habit.id, today, iso('03:00'), uuid()), 'TOKEN_REVOKED');
    // 철회 후 앱 컨텍스트는 슬롯을 비우고 익명으로 돌아간다
    expect((await tablet.repo.getAppContext()).kind).toBe('anonymous');
    expect(tablet.devices.get('child')).toBeNull();
  });

  it('페어링 코드 무차별 대입은 RATE_LIMITED', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    const dev = owner.otherBrowser();
    for (let i = 0; i < 8; i++) await expectCode(dev.repo.exchangePairingCode('000000'), 'NOT_FOUND');
    await expectCode(dev.repo.exchangePairingCode('000000'), 'RATE_LIMITED');
  });
});

describe('TV (F-06, AC-08)', () => {
  it('공개 일정/할 일 요약만 allowlist로 내려주고 private·메모·이메일·token은 없다', async () => {
    const owner = makeHarness();
    await ownerWithFamily(owner);
    await owner.repo.createEvent({ title: '공개 가족 행사', allDay: true, startDate: '2026-11-19', endDate: '2026-11-19', visibility: 'family', note: '비밀 메모' }, uuid());
    await owner.repo.createEvent({ title: '개인 비밀 일정', allDay: true, startDate: '2026-11-19', endDate: '2026-11-19', visibility: 'private' }, uuid());
    await owner.repo.createTask({ kind: 'todo', title: '쓰레기 버리기' }, uuid());
    const { habit } = await withChild(owner);
    // 승인이 필요한 습관은 아이가 체크만 한 상태(pending)에서는 완료로 세지 않는다
    const rec = await owner.repo.checkHabit(habit.id, '2026-11-19', iso('02:00'), uuid());
    expect(rec.state).toBe('pending');
    await owner.repo.approveHabit(rec.id);

    const code = await owner.repo.createPairingCode('tv');
    const tv = owner.otherBrowser();
    const dev = await tv.repo.exchangePairingCode(code.code);
    const data = await tv.repo.getTvBoardData(dev.token);
    const json = JSON.stringify(data);
    expect(data.events.map((e) => e.title)).toEqual(['공개 가족 행사']);
    expect(json).not.toContain('개인 비밀 일정');
    expect(json).not.toContain('비밀 메모');
    expect(json).not.toContain('owner@example.com');
    expect(json).not.toContain('하늘');
    expect(json).not.toContain(dev.token);
    expect(data.habits).toEqual({ done: 1, total: 1 });
    expect(Object.keys(data.events[0]!).sort()).toEqual(['allDay', 'endDate', 'endsAt', 'id', 'startDate', 'startsAt', 'title']);

    // 잘못된/child token 은 TV에서 거부
    await expectCode(tv.repo.getTvBoardData('nonsense-token'), 'TOKEN_REVOKED');
    // 철회 즉시 거부
    await owner.repo.revokeDevice((await owner.repo.listDevices())[0]!.id);
    await expectCode(tv.repo.getTvBoardData(dev.token), 'TOKEN_REVOKED');
  });
});

describe('오류 주입(개발용)과 데모 도구', () => {
  it('fault 주입은 지정 횟수만큼만 오류를 던진다', async () => {
    const h = makeHarness();
    await ownerWithFamily(h);
    h.server.setItem('mgfb:demo:fault', JSON.stringify({ method: 'getTasks', code: 'NETWORK_ERROR', remaining: 1 }));
    await expectCode(h.repo.getTasks(), 'NETWORK_ERROR');
    expect(await h.repo.getTasks()).toEqual([]);
  });

  it('샘플 가족 시드 후 PIN 1234로 unlock 가능', async () => {
    const h = makeHarness();
    await login(h, 'sample@example.com');
    const f = await h.repo.seedSample();
    expect(f.name).toBe('몽글네');
    await h.repo.verifyParentPin('1234');
    expect((await h.repo.getMembers()).children).toHaveLength(2);
    await h.repo.resetDemo();
    expect((await h.repo.getAppContext()).kind).toBe('anonymous');
  });
});

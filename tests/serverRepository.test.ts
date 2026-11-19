import { describe, expect, it } from 'vitest';
import { ServerBackedRepository } from '../src/repo/serverRepository';
import { UnlockStore } from '../src/repo/stores';
import { parseBackupFile, ServerApi } from '../src/server/api';
import { expectCode, uuid } from './helpers';

/** 태블릿 서버 계약(/api/*)을 흉내 내는 fetch. 실제 Python 서버는 tablet_server/tests 와 e2e에서 검증한다. */
class FakeServer {
  version = 0;
  data: Record<string, unknown> | null = null;
  loggedIn = new Set<string>();
  down = false;
  puts = 0;
  readonly users: Record<string, { pw: string; role: 'owner' | 'adult' }> = { owner: { pw: 'pw-owner-1', role: 'owner' }, mom: { pw: 'pw-mom-123', role: 'adult' } };

  fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError('Failed to fetch');
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    const cookie = this.currentCookie;
    if (path === '/api/health') return json(200, { status: 'ok', schemaVersion: 1, serverTime: 'x' });
    if (path === '/api/login') {
      const u = this.users[String(body?.id)];
      if (!u || u.pw !== body?.password) return json(401, { error: { code: 'UNAUTHENTICATED', message: 'ID 또는 비밀번호가 올바르지 않아요.' } });
      this.currentCookie = String(body?.id);
      return json(200, { id: body?.id, role: u.role });
    }
    if (path === '/api/logout') {
      this.currentCookie = null;
      return json(200, { ok: true });
    }
    if (!cookie) return json(401, { error: { code: 'UNAUTHENTICATED', message: '로그인이 필요해요.' } });
    if (path === '/api/me') return json(200, { id: cookie, role: this.users[cookie]?.role });
    if (path.startsWith('/api/state') && method === 'GET') {
      return path.endsWith('meta=1') ? json(200, { version: this.version, updatedAt: 't' }) : json(200, { version: this.version, updatedAt: 't', data: this.data });
    }
    if (path === '/api/state' && method === 'PUT') {
      this.puts += 1;
      if (body?.baseVersion !== this.version) return json(409, { error: { code: 'VERSION_CONFLICT', message: 'x' }, version: this.version, updatedAt: 't' });
      this.version += 1;
      this.data = body?.data as Record<string, unknown>;
      return json(200, { version: this.version, updatedAt: 't' });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'x' } });
  };
  currentCookie: string | null = null;
}

function browser(server: FakeServer) {
  // 브라우저마다 쿠키가 따로이므로 fetch를 감싸 현재 쿠키를 교체한다
  let cookie: string | null = null;
  const api = new ServerApi(async (u, i) => {
    server.currentCookie = cookie;
    const r = await server.fetch(u, i);
    cookie = server.currentCookie;
    return r;
  });
  const sb = new ServerBackedRepository(api, new UnlockStore());
  return { sb, repo: sb.repo, api };
}

async function setup(server: FakeServer, who: 'owner' | 'mom' = 'owner') {
  const b = browser(server);
  await b.sb.login(who, server.users[who]!.pw);
  return b;
}

describe('ServerBackedRepository', () => {
  it('서버가 꺼져 있으면 NETWORK_ERROR를 던지고 로컬 모드로 넘어가지 않는다', async () => {
    const server = new FakeServer();
    server.down = true;
    const b = browser(server);
    await expectCode(b.sb.login('owner', 'pw-owner-1'), 'NETWORK_ERROR');
    await expectCode(b.repo.getAppContext(), 'NETWORK_ERROR');
    await expectCode(b.repo.createFamily('몽글네', uuid()), 'UNAUTHENTICATED'); // 로그인 전에는 로컬에도 쓰지 않는다
    expect(server.puts).toBe(0);
  });

  it('로그인 전에는 anonymous, 로그인 후에는 adult 컨텍스트', async () => {
    const server = new FakeServer();
    const b = browser(server);
    expect((await b.repo.getAppContext()).kind).toBe('anonymous');
    await expectCode(b.sb.login('owner', 'wrong'), 'UNAUTHENTICATED');
    await b.sb.login('owner', 'pw-owner-1');
    const ctx = await b.repo.getAppContext();
    expect(ctx.kind).toBe('adult');
    if (ctx.kind === 'adult') {
      expect(ctx.session.email).toBe('owner');
      expect(ctx.family).toBeNull();
    }
  });

  it('쓰기는 baseVersion과 함께 서버에 저장되고 새로고침(새 브라우저)에서도 보인다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    expect(server.version).toBeGreaterThan(0);
    const v = server.version;
    await a.repo.createTask({ kind: 'todo', title: '장보기' }, uuid());
    expect(server.version).toBe(v + 1);
    // 같은 계정으로 새로 접속(새로고침) → 서버 문서에서 복원
    const reopened = browser(server);
    await reopened.sb.login('owner', 'pw-owner-1');
    const tasks = await reopened.repo.getTasks();
    expect(tasks.map((t) => t.title)).toEqual(['장보기']);
    expect((await reopened.repo.getFamily()).name).toBe('몽글네');
  });

  it('읽기만 할 때는 서버 version을 올리지 않는다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    const v = server.version;
    const puts = server.puts;
    await a.repo.getFamily();
    await a.repo.getMembers();
    await a.repo.getTasks();
    expect(server.version).toBe(v);
    expect(server.puts).toBe(puts);
  });

  it('다른 성인 계정은 같은 가족 문서에 구성원으로 연결된다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    const m = await setup(server, 'mom');
    const ctx = await m.repo.getAppContext();
    expect(ctx.kind === 'adult' && ctx.family?.name).toBe('몽글네');
    expect(ctx.kind === 'adult' && ctx.member?.role).toBe('adult');
    const { adults } = await m.repo.getMembers();
    expect(adults.map((x) => x.displayName).sort()).toEqual(['mom', 'owner']);
  });

  it('409: 두 기기가 같은 version에서 저장하면 나중 쪽은 덮어쓰지 않고 충돌 상태가 된다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    const b = await setup(server, 'mom'); // B 접속 자체가 구성원 연결로 version을 올린다
    await a.sb.reloadFromServer();
    // A가 먼저 저장 (B는 아직 이전 version)
    await a.repo.createTask({ kind: 'todo', title: 'A의 할 일' }, uuid());
    const serverDataAfterA = JSON.stringify(server.data);
    await expectCode(b.repo.createTask({ kind: 'todo', title: 'B의 할 일' }, uuid()), 'VERSION_CONFLICT');
    expect(JSON.stringify(server.data)).toBe(serverDataAfterA); // 서버는 덮어쓰이지 않음
    const snap = b.sb.sync.getSnapshot();
    expect(snap.conflict).not.toBeNull();
    expect(snap.conflict?.serverVersion).toBe(server.version);
    // 내 JSON 백업에는 저장되지 못한 내 변경이 들어 있다
    const mine = JSON.stringify(b.sb.myBackup().data);
    expect(mine).toContain('B의 할 일');
    expect(parseBackupFile(JSON.stringify(b.sb.myBackup())).format).toBe('monggeul-family-board-backup');
    // 메모리 문서는 마지막 서버 문서로 되돌아가 있다
    expect((await b.repo.getTasks()).map((t) => t.title)).toEqual([]);
    // 서버 값 다시 불러오기로 해소 후 다시 저장 가능
    await b.sb.reloadFromServer();
    expect(b.sb.sync.getSnapshot().conflict).toBeNull();
    expect((await b.repo.getTasks()).map((t) => t.title)).toEqual(['A의 할 일']);
    await b.repo.createTask({ kind: 'todo', title: 'B의 할 일' }, uuid());
    expect(server.version).toBeGreaterThan(0);
  });

  it('저장 중 서버가 끊기면 NETWORK_ERROR로 알리고 저장되지 않은 변경을 남기지 않는다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    server.down = true;
    await expectCode(a.repo.createTask({ kind: 'todo', title: '유령' }, uuid()), 'NETWORK_ERROR');
    expect(a.sb.sync.getSnapshot().unreachable).toBe(true);
    server.down = false;
    expect((await a.repo.getTasks()).map((t) => t.title)).toEqual([]);
  });

  it('poll은 다른 기기의 새 version을 알리기만 하고 문서를 교체하지 않는다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    const b = await setup(server, 'mom');
    await a.sb.reloadFromServer();
    await a.repo.createTask({ kind: 'todo', title: '새 할 일' }, uuid());
    await b.sb.poll();
    expect(b.sb.sync.getSnapshot().remoteVersion).toBe(server.version);
    expect((await b.repo.getTasks()).map((t) => t.title)).toEqual([]); // 자동 교체 없음
    await b.sb.reloadFromServer();
    expect(b.sb.sync.getSnapshot().remoteVersion).toBeNull();
    expect((await b.repo.getTasks()).map((t) => t.title)).toEqual(['새 할 일']);
  });

  it('세션이 만료되면 로컬 문서를 비우고 anonymous가 된다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    server.currentCookie = null; // 서버 쪽 세션 폐기
    const lostApi = new ServerApi(async (u, i) => {
      server.currentCookie = null;
      return server.fetch(u, i);
    });
    const c = new ServerBackedRepository(lostApi, new UnlockStore());
    expect((await c.repo.getAppContext()).kind).toBe('anonymous');
    expect(c.sync.getSnapshot().ready).toBe(false);
  });

  it('로그아웃하면 로컬 문서에 접근할 수 없다', async () => {
    const server = new FakeServer();
    const a = await setup(server);
    await a.repo.createFamily('몽글네', uuid());
    await a.repo.signOut();
    await expectCode(a.repo.getFamily(), 'UNAUTHENTICATED');
    expect((await a.repo.getAppContext()).kind).toBe('anonymous');
  });
});

describe('parseBackupFile', () => {
  it('형식이 맞지 않으면 VALIDATION_ERROR', () => {
    expect(() => parseBackupFile('not json')).toThrow();
    expect(() => parseBackupFile(JSON.stringify({ format: 'x' }))).toThrow();
    expect(parseBackupFile(JSON.stringify({ format: 'monggeul-family-board-backup', schemaVersion: 1, exportedAt: 'x', data: {} })).data).toEqual({});
  });
});

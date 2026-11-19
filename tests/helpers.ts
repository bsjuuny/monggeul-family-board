import { DemoRepository } from '../src/repo/demoRepository';
import { DeviceStore, MemoryStorage, UnlockStore } from '../src/repo/stores';

export interface Harness {
  repo: DemoRepository;
  /** "서버" 상태 */
  server: MemoryStorage;
  devices: DeviceStore;
  unlock: UnlockStore;
  setNow(d: Date): void;
  /** 같은 "서버"를 공유하지만 세션/기기 슬롯이 따로인 다른 브라우저 */
  otherBrowser(): Harness;
}

export function makeHarness(server: MemoryStorage = new MemoryStorage(), start = new Date('2026-11-19T01:00:00.000Z')): Harness {
  let now = start;
  const client = new MemoryStorage();
  const devices = new DeviceStore(client);
  const unlock = new UnlockStore(() => now.getTime());
  const repo = new DemoRepository({ storage: server, sessionStorage: client, deviceStore: devices, unlockStore: unlock, latencyMs: 0, now: () => now });
  return {
    repo,
    server,
    devices,
    unlock,
    setNow: (d) => {
      now = d;
    },
    otherBrowser: () => makeHarness(server, now),
  };
}

export const uuid = () => crypto.randomUUID();

export async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    const got = (e as { code?: string }).code;
    if (got !== code) throw new Error(`expected ${code} but got ${got ?? String(e)}`);
    return;
  }
  throw new Error(`expected ${code} but resolved`);
}

export async function login(h: Harness, email: string) {
  await h.repo.requestOtp(email);
  return h.repo.verifyOtp(email, '123456');
}

/** 가입 → 가족 생성 → PIN 설정까지 마친 owner 환경 */
export async function ownerWithFamily(h: Harness, email = 'owner@example.com') {
  await login(h, email);
  const family = await h.repo.createFamily('테스트네', uuid());
  await h.repo.setParentPin('1234');
  return family;
}

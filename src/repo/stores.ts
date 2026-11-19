// 클라이언트 측 보관소: 기기 token(localStorage), PIN unlock(메모리 전용)
import type { DeviceMode, DeviceSession } from '../domain/types';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements KeyValueStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

export function browserStorage(): KeyValueStorage {
  try {
    const s = window.localStorage;
    s.setItem('__mgfb_probe', '1');
    s.removeItem('__mgfb_probe');
    return s;
  } catch {
    return new MemoryStorage();
  }
}

type Listener = () => void;

/**
 * 장기 기기 token 보관. TV/child 슬롯을 따로 둔다.
 * URL query에는 절대 넣지 않으며, 로그아웃·기기 철회 시 clear 한다.
 */
export class DeviceStore {
  private listeners = new Set<Listener>();
  constructor(private storage: KeyValueStorage) {}

  private key(mode: DeviceMode) {
    return `mgfb:device:${mode}:v1`;
  }

  get(mode: DeviceMode): DeviceSession | null {
    const raw = this.storage.getItem(this.key(mode));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as DeviceSession;
      if (typeof v.token !== 'string' || v.mode !== mode) return null;
      if (Date.parse(v.expiresAt) <= Date.now()) {
        this.storage.removeItem(this.key(mode));
        return null;
      }
      return v;
    } catch {
      return null;
    }
  }

  set(session: DeviceSession): void {
    this.storage.setItem(this.key(session.mode), JSON.stringify(session));
    this.emit();
  }

  clear(mode: DeviceMode): void {
    this.storage.removeItem(this.key(mode));
    this.emit();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const UNLOCK_TTL_MS = 15 * 60 * 1000;

/** 부모 PIN unlock token: 메모리에만 두고 15분 뒤 폐기한다 (명세 §1). 새로고침하면 사라진다. */
export class UnlockStore {
  constructor(private clock: () => number = () => Date.now()) {}
  private token: string | null = null;
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();

  set(token: string, expiresAtIso: string): void {
    this.clear(false);
    this.token = token;
    this.expiresAt = Math.min(Date.parse(expiresAtIso), this.clock() + UNLOCK_TTL_MS);
    const ms = Math.max(0, this.expiresAt - this.clock());
    this.timer = setTimeout(() => this.clear(), ms);
    (this.timer as { unref?: () => void }).unref?.();
    this.emit();
  }

  getToken(): string | null {
    if (this.token && this.clock() >= this.expiresAt) this.clear();
    return this.token;
  }

  isUnlocked(): boolean {
    return this.getToken() !== null;
  }

  getExpiresAt(): number | null {
    return this.getToken() ? this.expiresAt : null;
  }

  clear(notify = true): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.token = null;
    this.expiresAt = 0;
    if (notify) this.emit();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

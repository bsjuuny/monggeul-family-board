// 태블릿 서버(/api/*) 클라이언트. 같은 origin만 사용하고 서버가 없으면 NETWORK_ERROR를 그대로 던진다.
// (조용한 로컬 모드 fallback 금지: 명세 v1.3)
import { FamilyBoardError, type ErrorCode } from '../domain/errors';

export type ServerRole = 'owner' | 'adult';

export interface ServerUser {
  id: string;
  role: ServerRole;
}
export interface ServerHealth {
  status: 'ok';
  schemaVersion: number;
  serverTime: string;
}
export interface ServerState {
  version: number;
  updatedAt: string;
  /** null이면 서버에 아직 저장된 문서가 없다 */
  data: Record<string, unknown> | null;
}
export interface ServerStateMeta {
  version: number;
  updatedAt: string;
}
export const BACKUP_FORMAT = 'monggeul-family-board-backup';
export const BACKUP_SCHEMA_VERSION = 1;
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  data: Record<string, unknown>;
}

const OFFLINE_MESSAGE = '태블릿 서버에 연결할 수 없어요. 서버가 켜져 있고 같은 Wi-Fi인지 확인해 주세요.';

type Json = Record<string, unknown>;

function codeFor(status: number, serverCode: unknown): ErrorCode {
  if (serverCode === 'VERSION_CONFLICT' || status === 409) return 'VERSION_CONFLICT';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

export class ServerApi {
  constructor(
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    private base = '',
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json | null; text: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new FamilyBoardError('NETWORK_ERROR', OFFLINE_MESSAGE, { offline: true });
    }
    const text = await res.text().catch(() => '');
    let json: Json | null = null;
    try {
      const parsed: unknown = text ? JSON.parse(text) : null;
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json?.error ?? {}) as { code?: unknown; message?: unknown };
      const code = codeFor(res.status, err.code);
      // 서버 앞단(프록시 등)이 HTML 오류를 주는 경우도 서버 연결 문제로 안내한다.
      if (!json && res.status >= 500) throw new FamilyBoardError('NETWORK_ERROR', OFFLINE_MESSAGE, { status: res.status });
      const details: Record<string, unknown> = { status: res.status };
      if (json && typeof json.version === 'number') details.serverVersion = json.version;
      if (json && typeof json.retryAfterSec === 'number') details.retryAfterSec = json.retryAfterSec;
      throw new FamilyBoardError(code, typeof err.message === 'string' ? err.message : '서버 요청에 실패했어요.', details);
    }
    return { status: res.status, json, text };
  }

  async health(): Promise<ServerHealth> {
    const { json } = await this.call('GET', '/api/health');
    if (!json || json.status !== 'ok' || typeof json.schemaVersion !== 'number') {
      throw new FamilyBoardError('NETWORK_ERROR', '이 주소는 몽글 패밀리보드 서버가 아니에요.');
    }
    return json as unknown as ServerHealth;
  }

  async login(id: string, password: string): Promise<ServerUser> {
    const { json } = await this.call('POST', '/api/login', { id, password });
    return this.user(json);
  }

  async logout(): Promise<void> {
    await this.call('POST', '/api/logout', {});
  }

  async me(): Promise<ServerUser> {
    const { json } = await this.call('GET', '/api/me');
    return this.user(json);
  }

  async getState(): Promise<ServerState> {
    const { json } = await this.call('GET', '/api/state');
    if (!json || typeof json.version !== 'number') throw new FamilyBoardError('INTERNAL_ERROR', '서버 응답이 올바르지 않아요.');
    const data = json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? (json.data as Record<string, unknown>) : null;
    return { version: json.version, updatedAt: String(json.updatedAt ?? ''), data };
  }

  async getStateMeta(): Promise<ServerStateMeta> {
    const { json } = await this.call('GET', '/api/state?meta=1');
    if (!json || typeof json.version !== 'number') throw new FamilyBoardError('INTERNAL_ERROR', '서버 응답이 올바르지 않아요.');
    return { version: json.version, updatedAt: String(json.updatedAt ?? '') };
  }

  /** baseVersion이 서버 version과 다르면 VERSION_CONFLICT(details.serverVersion) */
  async putState(baseVersion: number, data: Record<string, unknown>): Promise<ServerStateMeta> {
    const { json } = await this.call('PUT', '/api/state', { baseVersion, data });
    if (!json || typeof json.version !== 'number') throw new FamilyBoardError('INTERNAL_ERROR', '서버 응답이 올바르지 않아요.');
    return { version: json.version, updatedAt: String(json.updatedAt ?? '') };
  }

  async backup(): Promise<BackupFile> {
    const { json } = await this.call('GET', '/api/backup');
    if (!json || json.format !== BACKUP_FORMAT) throw new FamilyBoardError('INTERNAL_ERROR', '백업 응답이 올바르지 않아요.');
    return json as unknown as BackupFile;
  }

  async restore(file: BackupFile): Promise<ServerStateMeta> {
    const { json } = await this.call('POST', '/api/restore', file);
    if (!json || typeof json.version !== 'number') throw new FamilyBoardError('INTERNAL_ERROR', '서버 응답이 올바르지 않아요.');
    return { version: json.version, updatedAt: String(json.updatedAt ?? '') };
  }

  private user(json: Json | null): ServerUser {
    if (!json || typeof json.id !== 'string' || (json.role !== 'owner' && json.role !== 'adult')) {
      throw new FamilyBoardError('INTERNAL_ERROR', '서버 응답이 올바르지 않아요.');
    }
    return { id: json.id, role: json.role };
  }
}

/** 백업 JSON 문자열 → 형식 검증 (복원 전 클라이언트 검사; 서버가 다시 검증한다) */
export function parseBackupFile(text: string): BackupFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new FamilyBoardError('VALIDATION_ERROR', '백업 파일이 올바른 JSON이 아니에요.');
  }
  const o = v as Partial<BackupFile> | null;
  if (!o || o.format !== BACKUP_FORMAT || o.schemaVersion !== BACKUP_SCHEMA_VERSION || typeof o.exportedAt !== 'string' || !o.data || typeof o.data !== 'object' || Array.isArray(o.data)) {
    throw new FamilyBoardError('VALIDATION_ERROR', '몽글 패밀리보드 백업 파일이 아니거나 버전이 달라요.');
  }
  return o as BackupFile;
}

export function makeBackupFile(data: Record<string, unknown>, now = new Date()): BackupFile {
  return { format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: now.toISOString(), data };
}

// 명세 §7 오류 코드와 응답 envelope

import { newId } from '../lib/crypto';

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVITE_EXPIRED',
  'TOKEN_REVOKED',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export class FamilyBoardError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly requestId: string;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    requestId: string = newRequestId(),
  ) {
    super(message);
    this.name = 'FamilyBoardError';
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export function isFamilyBoardError(e: unknown): e is FamilyBoardError {
  return e instanceof FamilyBoardError;
}

export function newRequestId(): string {
  return newId();
}

export interface ApiMeta {
  requestId: string;
  serverTime: string;
}
export interface ApiSuccess<T> {
  data: T;
  meta: ApiMeta;
}
export interface ApiFailure {
  error: { code: ErrorCode; message: string; requestId: string; details: Record<string, unknown> };
}
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function okResponse<T>(data: T, requestId: string = newRequestId(), now: Date = new Date()): ApiSuccess<T> {
  return { data, meta: { requestId, serverTime: now.toISOString() } };
}

export function failResponse(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  requestId: string = newRequestId(),
): ApiFailure {
  return { error: { code, message, requestId, details } };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVITE_EXPIRED: 410,
  TOKEN_REVOKED: 401,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  NETWORK_ERROR: 503,
  INTERNAL_ERROR: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** 사용자에게 보여줄 한국어 안내문. 내부 메시지·token·본문은 포함하지 않는다. */
export function friendlyMessage(e: unknown): string {
  if (!isFamilyBoardError(e)) return '알 수 없는 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
  switch (e.code) {
    case 'VALIDATION_ERROR':
      return e.message || '입력한 내용을 다시 확인해 주세요.';
    case 'UNAUTHENTICATED':
      return e.message || '로그인이 필요하거나 인증이 만료됐어요. 다시 로그인해 주세요.';
    case 'FORBIDDEN':
      return '이 작업을 할 권한이 없어요.';
    case 'NOT_FOUND':
      return '찾는 항목이 없거나 이미 삭제됐어요.';
    case 'INVITE_EXPIRED':
      return '초대가 만료되었거나 이미 사용·철회되었어요. 새 초대를 요청해 주세요.';
    case 'TOKEN_REVOKED':
      return '이 기기의 연결이 해제되었어요. 다시 연결해 주세요.';
    case 'VERSION_CONFLICT':
      return '다른 사람이 먼저 수정했어요. 최신 내용을 확인해 주세요.';
    case 'IDEMPOTENCY_CONFLICT':
      return '같은 요청 번호로 다른 내용이 전송되었어요. 새로고침 후 다시 시도해 주세요.';
    case 'RATE_LIMITED':
      return '시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.';
    case 'NETWORK_ERROR':
      return '네트워크에 연결할 수 없어요. 연결을 확인하고 다시 시도해 주세요.';
    default:
      return '서버에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
  }
}

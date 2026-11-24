// v2 서버 API 계약(tablet_server/app.py ROUTES)과 클라이언트 함수.
import type { NoticeDigest } from '../notices/types';
import type { ServerApi } from './api';

export type Period = 'morning' | 'afternoon' | 'evening';

export interface WeatherPoint {
  time?: string;
  tmp?: number | null;
  pop?: number | null;
  pty?: string;
  sky?: string;
  wsd?: number | null;
  condition?: string;
}
export interface Advice {
  code: string;
  text: string;
  tone: string;
}
export type Weather =
  | { configured: false; reason: 'location' | 'key'; location?: string }
  | { configured: true; available: false; location?: string; error: string }
  | {
      configured: true;
      available: true;
      location: string;
      current: { temp: number | null; condition: string; pty: string; sky: string | null; wind: number | null; humidity: number | null; pop: number | null };
      today: { min: number | null; max: number | null; popMax: number | null; condition: string | null };
      tomorrow: { min: number | null; max: number | null; popMax: number | null; condition: string | null; dropoff: WeatherPoint | null };
      dropoff: WeatherPoint | null;
      pickup: WeatherPoint | null;
      advice: Advice[];
      tomorrowAdvice: Advice[];
      updatedAt: string;
      stale: boolean;
      ageMinutes: number | null;
      error: string | null;
    };

/** 등원 없는 날 카드에 보여 줄 다음 등원(3주 안) */
export interface NextCommute {
  date: string;
  leaveHomeAt: string;
  arriveBy: string;
  needsReview: boolean;
}

export interface CommutePlan {
  childId: string;
  date: string;
  attends: boolean;
  closed: boolean;
  closedNote: string | null;
  leaveHomeAt: string;
  arriveBy: string;
  pickupAt: string;
  pickupAssignee: string | null;
  needsReview: boolean;
  changes: Array<{ kind: 'dropoff_time' | 'pickup_time'; time: string; note: string | null; needsReview: boolean; noticeId: string | null }>;
}

export interface NoticeCard {
  id: string;
  title: string;
  status: NoticeStatus;
  reviewReasons: string[];
  receivedOn: string;
  eventDate: string | null;
  needsReply: boolean;
  source: string;
}
export type NoticeStatus = 'auto' | 'needs_review' | 'confirmed' | 'dismissed' | 'pending_analysis';

export interface PrepItem {
  id: string;
  noticeId: string | null;
  childId: string | null;
  date: string | null;
  kind: 'dropoff' | 'pickup' | 'event' | 'document' | 'parent_task';
  text: string;
  needsReview: boolean;
  userEdited: boolean;
  doneAt: string | null;
  doneBy: string | null;
  noticeTitle: string | null;
}

export interface Pickup {
  date: string;
  childId: string;
  assignee: string | null;
  assigneeSource: 'manual' | 'default' | null;
  pickupAt: string | null;
  attends: boolean;
  doneAt: string | null;
  doneBy: string | null;
}

export interface BoardEvent {
  id: string;
  title: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  time?: string | null;
  source: 'calendar' | 'notice';
  noticeId?: string;
  needsReview?: boolean;
}

export interface Board {
  serverTime: string;
  today: string;
  tomorrow: string;
  /** 달력상 오늘(머리글 날짜용). today 는 아침 시작 시각에 넘어가는 보드 기준 날짜 */
  calendarToday?: string;
  family: { name: string; timezone: string };
  viewer: { kind: 'user' | 'device'; label: string | null; role: 'owner' | 'adult' | null };
  screen: { morningFrom: string; afternoonFrom: string; eveningFrom: string; mode: Period };
  children: Array<{ id: string; displayName: string; avatarKey: string; habits: { done: number; total: number; pending: number } }>;
  commute: { configured: boolean; today: CommutePlan[]; tomorrow: CommutePlan[]; nextAfterToday?: NextCommute | null; nextAfterTomorrow?: NextCommute | null };
  weather: Weather;
  notices: { needsReview: number; top: NoticeCard[] };
  prep: { today: PrepItem[]; tomorrow: PrepItem[] };
  pickups: Pickup[];
  events: { today: BoardEvent[]; tomorrow: BoardEvent[] };
  tasks: { todo: Array<{ id: string; title: string; done: boolean }>; shopping: Array<{ id: string; title: string }> };
  sync: { name: string; mode: string; available: boolean; enabled: boolean; lastOkAt: string | null; lastError: string | null; paused: boolean };
}

export interface ChildCommute {
  weekdays: number[];
  leaveHomeAt: string;
  arriveBy: string;
  pickupAt: string;
  pickupAtByWeekday: Record<string, string>;
  pickupAssignee: string;
  pickupAssigneeByWeekday: Record<string, string>;
}

export interface Settings {
  location: { name: string; lat: number; lon: number; grid?: [number, number] } | null;
  commute: { children: Record<string, ChildCommute> };
  screen: { morningFrom: string; afternoonFrom: string; eveningFrom: string };
  notices: { storeOriginal: boolean; autoShowGeneral: boolean };
  kidsnote: { enabled: boolean; times: string[] };
  tvPrivacy: { hideChildNames: boolean; hideNoticeTitles: boolean; hidePickup: boolean };
  /** 공지 저장 전 가리기: 연락처 자동, 이름은 목록만 ○○로 */
  privacy: { maskContacts: boolean; maskNames: string[] };
  weatherKeyConfigured: boolean;
  weatherKeySource: 'env' | 'file' | null;
  _versions: Record<'location' | 'commute' | 'screen' | 'notices' | 'kidsnote' | 'tvPrivacy' | 'privacy', number>;
}
export type SettingKey = keyof Settings['_versions'];

export interface Notice {
  id: string;
  source: 'manual' | 'gongjitalk' | 'kidsnote' | 'mock';
  sourceId: string | null;
  receivedOn: string;
  title: string;
  digest: NoticeDigest;
  status: NoticeStatus;
  editedByUser: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  reviewReasons: string[];
  hasOriginal: boolean;
  originalText?: string | null;
}

export interface NoticeEventRow {
  id: string;
  noticeId: string;
  date: string;
  endDate: string | null;
  time: string | null;
  title: string;
  kind: string;
  needsReview: boolean;
  calendarEventId: string | null;
  calendarSnapshot: { title: string; date: string; endDate: string | null; time: string | null } | null;
}

export interface DeviceRow {
  id: string;
  label: string;
  mode: 'tv';
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export interface SyncStatus {
  adapter: { name: string; mode: string; available: boolean; reason: string | null };
  settings: { enabled: boolean; times: string[] };
  state: { lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; failures: number; nextAllowedAt: string | null; paused: boolean };
  runs: Array<{ trigger: string; started_at: string; finished_at: string | null; ok: number | null; fetched: number; created: number; updated: number; skipped: number; error: string | null }>;
}

export interface CommuteResponse {
  settings: { children: Record<string, ChildCommute> };
  version: number;
  exceptions: Array<{ id: string; noticeId: string | null; childId: string | null; date: string; endDate: string | null; kind: 'closed' | 'dropoff_time' | 'pickup_time'; time: string | null; note: string | null; needsReview: boolean; noticeTitle: string | null }>;
  days: Array<{ date: string; plans: CommutePlan[] }>;
}

export interface NewNoticeBody {
  source: 'manual' | 'gongjitalk';
  sourceId?: string;
  receivedOn: string;
  contentHash: string;
  digest: NoticeDigest;
  originalText?: string;
  storeOriginal?: boolean;
}

export function v2(api: ServerApi) {
  const q = (o: Record<string, string | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) s.set(k, v);
    const t = s.toString();
    return t ? `?${t}` : '';
  };
  return {
    board: () => api.request<Board>('GET', '/api/board'),
    settings: () => api.request<Settings>('GET', '/api/settings'),
    putSetting: <K extends SettingKey>(key: K, value: unknown, baseVersion: number) =>
      api.request<{ key: K; value: unknown; version: number; maskedNotices?: number }>('PUT', `/api/settings/${key}`, { value, baseVersion }),
    setWeatherKey: (key: string) => api.request<{ saved: boolean; check: 'ok'; message: string }>('PUT', '/api/weather-key', { key }),
    deleteWeatherKey: () => api.request<{ removed: boolean }>('DELETE', '/api/weather-key'),
    // TV
    createPairingCode: () => api.request<{ code: string; expiresAt: string }>('POST', '/api/devices/pairing-codes', {}),
    pair: (code: string, label: string) => api.request<{ id: string; label: string }>('POST', '/api/devices/pair', { code, label }),
    devices: () => api.request<{ devices: DeviceRow[] }>('GET', '/api/devices'),
    revokeDevice: (id: string) => api.request<{ ok: true }>('DELETE', `/api/devices/${id}`),
    deviceMe: () => api.request<{ id: string; label: string; familyName: string }>('GET', '/api/device/me'),
    unpair: () => api.request<{ ok: true }>('POST', '/api/device/unpair', {}),
    // 공지
    notices: (status?: NoticeStatus) => api.request<{ notices: Notice[] }>('GET', `/api/notices${q({ status })}`),
    notice: (id: string, original = false) => api.request<Notice>('GET', `/api/notices/${id}${original ? '?original=1' : ''}`),
    createNotice: (body: NewNoticeBody) => api.request<{ duplicate: boolean; notice: Notice }>('POST', '/api/notices', body),
    updateNotice: (id: string, baseVersion: number, digest: NoticeDigest, receivedOn?: string) =>
      api.request<Notice>('PUT', `/api/notices/${id}`, { baseVersion, digest, receivedOn }),
    confirmNotice: (id: string, baseVersion: number, dismiss = false) => api.request<Notice>('POST', `/api/notices/${id}/confirm`, { baseVersion, dismiss }),
    deleteNotice: (id: string) => api.request<{ ok: true }>('DELETE', `/api/notices/${id}`),
    noticeHistory: (id: string) => api.request<{ history: Array<{ at: string; actor: string; action: string }> }>('GET', `/api/notices/${id}/history`),
    pendingAnalysis: () => api.request<{ items: Array<{ id: string; receivedOn: string; text: string }> }>('GET', '/api/notices/pending-analysis'),
    saveAnalysis: (id: string, digest: NoticeDigest) => api.request<Notice>('POST', `/api/notices/${id}/analysis`, { digest }),
    importNotices: (items: unknown[], preview: boolean) =>
      api.request<{ preview: boolean; results: Array<{ index: number; status: 'new' | 'created' | 'duplicate' | 'invalid'; title?: string; error?: string }>; summary: Record<string, number> }>('POST', '/api/notices/import', { items, preview }),
    // 준비물·등하원·픽업
    prep: (from: string, to: string) => api.request<{ items: PrepItem[] }>('GET', `/api/preparations${q({ from, to })}`),
    addPrep: (body: { date: string; kind: PrepItem['kind']; text: string; childId?: string }) => api.request<PrepItem>('POST', '/api/preparations', body),
    patchPrep: (id: string, body: Partial<{ done: boolean; text: string; date: string | null; kind: PrepItem['kind']; deleted: true }>) =>
      api.request<PrepItem>('PATCH', `/api/preparations/${id}`, body),
    commute: (from: string, to: string) => api.request<CommuteResponse>('GET', `/api/commute${q({ from, to })}`),
    addException: (body: { kind: 'closed' | 'dropoff_time' | 'pickup_time'; date: string; endDate?: string; time?: string; note?: string; childId?: string }) =>
      api.request('POST', '/api/commute/exceptions', body),
    deleteException: (id: string) => api.request('DELETE', `/api/commute/exceptions/${id}`),
    pickups: (from: string, to: string) => api.request<{ pickups: Pickup[]; adults: string[] }>('GET', `/api/pickups${q({ from, to })}`),
    setPickup: (body: { date: string; childId: string; assignee?: string; done?: boolean }) => api.request('PUT', '/api/pickups', body),
    noticeEvents: (from: string, to: string) => api.request<{ events: NoticeEventRow[] }>('GET', `/api/notice-events${q({ from, to })}`),
    /** 공지 하나의 행사 전체(날짜 제한 없음, 지운 행 포함) */
    noticeEventsOf: (noticeId: string) => api.request<{ events: Array<NoticeEventRow & { deleted: boolean }> }>('GET', `/api/notice-events${q({ noticeId })}`),
    linkNoticeEvent: (id: string, calendarEventId: string | null, snapshot?: NoticeEventRow['calendarSnapshot']) =>
      api.request('PUT', `/api/notice-events/${id}/link`, { calendarEventId, snapshot }),
    // 공지 자동 수집
    syncStatus: () => api.request<SyncStatus>('GET', '/api/kidsnote/status'),
    syncNow: () => api.request<{ ok: boolean; fetched: number; created: number; updated: number; skipped: number; error: string | null }>('POST', '/api/kidsnote/sync', {}),
    syncResume: () => api.request<SyncStatus>('POST', '/api/kidsnote/resume', {}),
  };
}

export type V2 = ReturnType<typeof v2>;

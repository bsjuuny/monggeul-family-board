// 이 기기(태블릿) 스피커로 라디오 듣기.
// 화면을 옮겨도(보드 ↔ 라디오 화면) 끊기지 않게 페이지 하나에 오디오 하나만 두고, 상태는 작은 저장소로 알린다.
// 방송 주소는 태블릿 서버 → 미니PC radio-cast(/stream)로 받는다. KBS·MBC·SBS 주소에는 시간이 지나면 끝나는 토큰이
// 붙어 있어서, 재생이 끊기면 한 번 새 주소를 받아 다시 튼다.
// 방송은 HLS(m3u8) 형식이다. 안드로이드 크롬은 이 형식을 직접 못 트는 경우가 있어 hls.js(MSE)로 풀어서 튼다.
// 방송사 서버가 모두 CORS 를 열어 두어(Access-Control-Allow-Origin) 브라우저에서 바로 받을 수 있다.
// hls.js 는 라디오를 처음 틀 때만 불러온다(보드 첫 화면이 무거워지지 않게).
import { useSyncExternalStore } from 'react';
import type HlsType from 'hls.js';

export type LocalState = 'idle' | 'loading' | 'playing' | 'error';
export interface LocalRadio {
  state: LocalState;
  station: string | null;
  title: string | null;
  error: string | null;
  volume: number;
}

type Resolve = (station: string) => Promise<{ url: string; title: string }>;

const VOLUME_KEY = 'mgfb.radio.localVolume';
let audio: HTMLAudioElement | null = null;
let hls: HlsType | null = null;
let resolveUrl: Resolve | null = null;
let retried = false;
let lastDetail: string | null = null;
const tail = () => (lastDetail ? ` (${lastDetail})` : '');
let snapshot: LocalRadio = { state: 'idle', station: null, title: null, error: null, volume: readVolume() };
const listeners = new Set<() => void>();

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.6;
  } catch {
    return 0.6;
  }
}

function set(patch: Partial<LocalRadio>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.volume = snapshot.volume;
  audio.addEventListener('playing', () => set({ state: 'playing', error: null }));
  audio.addEventListener('error', () => {
    // hls.js 가 붙어 있으면 오류는 hls.js 쪽에서 처리한다. 주소를 비울 때 나는 오류(빈 src)도 무시한다.
    if (hls || !audio?.getAttribute('src')) return;
    void recover('방송을 재생하지 못했어요.', `브라우저 오류 ${audio?.error?.code ?? '?'}`);
  });
  audio.addEventListener('ended', () => void recover('방송이 끊겼어요.'));
  return audio;
}

/** 토큰이 끝났거나 잠깐 끊겼을 때 새 주소로 한 번만 다시 시도한다 */
async function recover(message: string, detail?: string) {
  if (detail) lastDetail = detail;
  const station = snapshot.station;
  if (!station || snapshot.state === 'idle') return;
  if (retried || !resolveUrl) {
    set({ state: 'error', error: `${message} 이 기기 브라우저가 이 방송 형식을 지원하지 않거나 인터넷이 끊겼을 수 있어요.${tail()}` });
    return;
  }
  retried = true;
  try {
    const { url } = await resolveUrl(station);
    await start(url);
  } catch {
    set({ state: 'error', error: `${message} 잠시 뒤 다시 눌러 보거나, 집 안 스피커로 틀어 주세요.${tail()}` });
  }
}

function detachHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

/** hls.js 가 되면 hls.js 로, 안 되면(아이폰 사파리 등) 브라우저가 직접 튼다 */
async function start(url: string): Promise<void> {
  const a = element();
  detachHls();
  let Hls: typeof HlsType | null = null;
  try {
    Hls = (await import('hls.js')).default;
  } catch {
    Hls = null; // 못 불러오면 브라우저 직접 재생으로
  }
  if (Hls && Hls.isSupported()) {
    const h = new Hls({ lowLatencyMode: false, maxBufferLength: 30, enableWorker: false }) // 보안 설정(CSP)상 blob 워커는 쓰지 않는다;
    hls = h;
    h.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || hls !== h) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        h.recoverMediaError();
        return;
      }
      detachHls();
      void recover('방송을 재생하지 못했어요.', data.details);
    });
    h.attachMedia(a);
    h.loadSource(url);
  } else {
    a.src = url;
  }
  await a.play();
}

export async function playLocal(station: string, resolve: Resolve): Promise<void> {
  resolveUrl = resolve;
  retried = false;
  lastDetail = null;
  set({ state: 'loading', station, error: null });
  try {
    const { url, title } = await resolve(station);
    set({ title });
    await start(url);
  } catch (e) {
    const blocked = e instanceof DOMException && e.name === 'NotAllowedError';
    set({ state: 'error', error: blocked ? '브라우저가 자동 재생을 막았어요. 재생 버튼을 한 번 더 눌러 주세요.' : e instanceof Error && e.message ? e.message : '방송을 틀지 못했어요.' });
  }
}

export function stopLocal(): void {
  detachHls();
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  set({ state: 'idle', error: null });
}

export function setLocalVolume(v: number): void {
  const vol = Math.min(1, Math.max(0.05, Math.round(v * 100) / 100));
  if (audio) audio.volume = vol;
  try {
    localStorage.setItem(VOLUME_KEY, String(vol));
  } catch {
    /* 저장 못 해도 이번 재생에는 적용 */
  }
  set({ volume: vol });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useLocalRadio(): LocalRadio {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** 테스트용 */
export function _resetLocalRadio() {
  detachHls();
  audio = null;
  resolveUrl = null;
  retried = false;
  snapshot = { state: 'idle', station: null, title: null, error: null, volume: 0.6 };
}

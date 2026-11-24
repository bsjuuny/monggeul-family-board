// 이 기기(태블릿) 스피커로 라디오 듣기.
// 화면을 옮겨도(보드 ↔ 라디오 화면) 끊기지 않게 페이지 하나에 오디오 하나만 두고, 상태는 작은 저장소로 알린다.
// 방송 주소는 태블릿 서버 → 미니PC radio-cast(/stream)로 받는다. KBS·MBC·SBS 주소에는 시간이 지나면 끝나는 토큰이
// 붙어 있어서, 재생이 끊기면 한 번 새 주소를 받아 다시 튼다.
import { useSyncExternalStore } from 'react';

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
let resolveUrl: Resolve | null = null;
let retried = false;
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
  audio.addEventListener('error', () => void recover('방송을 재생하지 못했어요.'));
  audio.addEventListener('ended', () => void recover('방송이 끊겼어요.'));
  return audio;
}

/** 토큰이 끝났거나 잠깐 끊겼을 때 새 주소로 한 번만 다시 시도한다 */
async function recover(message: string) {
  const station = snapshot.station;
  if (!station || snapshot.state === 'idle') return;
  if (retried || !resolveUrl) {
    set({ state: 'error', error: `${message} 이 기기 브라우저가 이 방송 형식을 지원하지 않거나 인터넷이 끊겼을 수 있어요.` });
    return;
  }
  retried = true;
  try {
    const { url } = await resolveUrl(station);
    const a = element();
    a.src = url;
    await a.play();
  } catch {
    set({ state: 'error', error: `${message} 잠시 뒤 다시 눌러 보거나, 집 안 스피커로 틀어 주세요.` });
  }
}

export async function playLocal(station: string, resolve: Resolve): Promise<void> {
  resolveUrl = resolve;
  retried = false;
  set({ state: 'loading', station, error: null });
  try {
    const { url, title } = await resolve(station);
    set({ title });
    const a = element();
    a.src = url;
    await a.play();
  } catch (e) {
    const blocked = e instanceof DOMException && e.name === 'NotAllowedError';
    set({ state: 'error', error: blocked ? '브라우저가 자동 재생을 막았어요. 재생 버튼을 한 번 더 눌러 주세요.' : e instanceof Error && e.message ? e.message : '방송을 틀지 못했어요.' });
  }
}

export function stopLocal(): void {
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
  audio = null;
  resolveUrl = null;
  retried = false;
  snapshot = { state: 'idle', station: null, title: null, error: null, volume: 0.6 };
}

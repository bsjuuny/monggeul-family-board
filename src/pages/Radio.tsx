// 라디오: 미니PC radio-cast 로 집 안 구글 스피커에 틀거나, 이 기기(태블릿) 스피커로 바로 듣는다.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePageTitle, useServices } from '../app/context';
import { isFamilyBoardError } from '../domain/errors';
import type { RadioStation } from '../server/v2';
import { playLocal, setLocalVolume, stopLocal, useLocalRadio } from '../radio/player';
import { ErrorBlock, LoadingBlock } from '../ui/States';
import { useToast } from '../ui/Toasts';

type Mode = 'speaker' | 'here';
const MODE_KEY = 'mgfb.radio.mode';
const DEVICE_KEY = 'mgfb.radio.device';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* 이번 화면에서만 */
  }
}
const errText = (e: unknown, fallback: string) => (isFamilyBoardError(e) ? e.message : fallback);

export function RadioPage() {
  usePageTitle('라디오');
  const { v2 } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['v2settings'], queryFn: () => v2.settings() });
  const ready = Boolean(settings.data?.radio?.baseUrl && settings.data?.radioKeySource);
  const stations = useQuery({ queryKey: ['radio-stations'], queryFn: () => v2.radioStations(), enabled: ready, staleTime: 60 * 60 * 1000, retry: false });
  const [mode, setMode] = useState<Mode>(() => (stored(MODE_KEY) === 'here' ? 'here' : 'speaker'));
  const [station, setStation] = useState<string>('cbs_music');
  const [device, setDevice] = useState<string>(() => stored(DEVICE_KEY) ?? '');
  const devices = useQuery({ queryKey: ['radio-devices'], queryFn: () => v2.radioDevices(), enabled: ready && mode === 'speaker', staleTime: 5 * 60 * 1000, retry: false });
  const dev = device || settings.data?.radio?.defaultDevice || devices.data?.default || '';
  const status = useQuery({ queryKey: ['radio-status', dev], queryFn: () => v2.radioStatus(dev || null), enabled: ready && mode === 'speaker', refetchInterval: 20_000, retry: false });
  const local = useLocalRadio();

  useEffect(() => {
    const def = settings.data?.radio?.defaultStation;
    if (def) setStation((cur) => (cur === 'cbs_music' ? def : cur));
  }, [settings.data?.radio?.defaultStation]);
  useEffect(() => store(MODE_KEY, mode), [mode]);

  const refreshStatus = () => qc.invalidateQueries({ queryKey: ['radio-status'] });
  const play = useMutation({
    mutationFn: () => v2.radioPlay(station, dev || null),
    onSuccess: (r) => { toast.info(`${r.device}에서 ${r.title}을(를) 틀었어요.`); void refreshStatus(); },
    onError: (e) => toast.error(errText(e, '틀지 못했어요.')),
  });
  const stop = useMutation({
    mutationFn: () => v2.radioStop(dev || null),
    onSuccess: () => { toast.info('멈췄어요.'); void refreshStatus(); },
    onError: (e) => toast.error(errText(e, '멈추지 못했어요.')),
  });
  const vol = useMutation({
    mutationFn: (step: 'up' | 'down') => v2.radioVolume(step, dev || null),
    onSuccess: () => void refreshStatus(),
    onError: (e) => toast.error(errText(e, '볼륨을 바꾸지 못했어요.')),
  });

  if (settings.isPending) return <LoadingBlock />;
  if (settings.isError) return <ErrorBlock error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!ready) {
    return (
      <div className="stack" data-testid="radio-page">
        <h1>라디오</h1>
        <section className="card">
          <p>미니PC의 라디오 서버(radio-cast)와 연결하면 여기서 집 안 스피커로 틀거나 이 태블릿으로 바로 들을 수 있어요.</p>
          <p className="muted">{settings.data.radio?.baseUrl ? '라디오 서버 비밀번호가 아직 없어요.' : '라디오 서버 주소가 아직 없어요.'}</p>
          <Link className="btn" to="/settings#set-radio">설정에서 연결하기</Link>
        </section>
      </div>
    );
  }

  const groups = new Map<string, RadioStation[]>();
  for (const s of stations.data?.stations ?? []) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const nameOf = (id: string | null) => (stations.data?.stations ?? []).find((s) => s.id === id);
  const picked = nameOf(station);
  const pickedLabel = picked ? `${picked.group} ${picked.name}` : station;

  return (
    <div className="stack radio-page" data-testid="radio-page">
      <h1>라디오</h1>

      <section className="card" aria-labelledby="radio-where">
        <h2 id="radio-where">어디서 들을까요?</h2>
        <div className="seg" role="group" aria-label="듣는 곳">
          <button type="button" aria-pressed={mode === 'speaker'} onClick={() => setMode('speaker')} data-testid="radio-mode-speaker">집 안 스피커</button>
          <button type="button" aria-pressed={mode === 'here'} onClick={() => setMode('here')} data-testid="radio-mode-here">이 기기에서</button>
        </div>
        {mode === 'speaker' ? (
          <div className="radio-now">
            <div className="radio-field">
              <label htmlFor="radio-device">스피커</label>
              <div className="radio-inline">
                <select id="radio-device" value={dev} onChange={(e) => { setDevice(e.target.value); store(DEVICE_KEY, e.target.value); }}>
                  {!devices.data && <option value={dev}>{dev || '기본 스피커'}</option>}
                  {(devices.data?.devices ?? []).map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                </select>
                <button type="button" className="btn ghost small" onClick={() => void qc.fetchQuery({ queryKey: ['radio-devices'], queryFn: () => v2.radioDevices(true) })}>다시 찾기</button>
              </div>
            </div>
            <p className="radio-status" data-testid="radio-status" aria-live="polite">
              {status.isError ? errText(status.error, '스피커 상태를 알 수 없어요.')
                : !status.data ? '스피커 상태 확인 중…'
                  : status.data.state === 'PLAYING' || status.data.state === 'BUFFERING' ? `🎵 ${status.data.title ?? '재생 중'} · ${status.data.device}${status.data.volume != null ? ` · 볼륨 ${Math.round(status.data.volume * 100)}` : ''}`
                    : `${status.data.device} · 쉬는 중`}
            </p>
            <div className="btn-row">
              <button type="button" className="btn" disabled={play.isPending} onClick={() => play.mutate()} data-testid="radio-play">{play.isPending ? '트는 중…' : `▶ ${pickedLabel} 틀기`}</button>
              <button type="button" className="btn secondary" disabled={stop.isPending} onClick={() => stop.mutate()}>■ 멈춤</button>
            </div>
            <div className="radio-inline radio-vol">
              <span>볼륨</span>
              <button type="button" className="btn secondary" aria-label="볼륨 작게" disabled={vol.isPending} onClick={() => vol.mutate('down')}>－</button>
              <button type="button" className="btn secondary" aria-label="볼륨 크게" disabled={vol.isPending} onClick={() => vol.mutate('up')}>＋</button>
            </div>
          </div>
        ) : (
          <div className="radio-now">
            <p className="radio-status" data-testid="radio-local-status" aria-live="polite">
              {local.state === 'playing' ? `🎵 ${local.title ?? '재생 중'} · 이 기기`
                : local.state === 'loading' ? '방송을 불러오는 중…'
                  : local.state === 'error' ? local.error
                    : '이 기기 스피커로 들어요. 다른 화면으로 옮겨도 계속 나와요.'}
            </p>
            <div className="btn-row">
              <button type="button" className="btn" disabled={local.state === 'loading'} data-testid="radio-play-here"
                onClick={() => void playLocal(station, (sid) => v2.radioStream(sid))}>▶ {pickedLabel} 듣기</button>
              <button type="button" className="btn secondary" disabled={local.state === 'idle'} onClick={stopLocal}>■ 멈춤</button>
            </div>
            <label className="field radio-volume">
              <span>볼륨 {Math.round(local.volume * 100)}</span>
              <input type="range" min={5} max={100} step={5} value={Math.round(local.volume * 100)} onChange={(e) => setLocalVolume(Number(e.target.value) / 100)} />
            </label>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="radio-stations">
        <h2 id="radio-stations">채널</h2>
        {stations.isPending ? <LoadingBlock rows={2} /> : stations.isError ? <ErrorBlock error={stations.error} onRetry={() => void stations.refetch()} /> : (
          <div className="radio-groups">
            {[...groups.entries()].map(([g, list]) => (
              <div key={g} className="radio-group">
                <h3>{g}</h3>
                <div className="btn-row">
                  {list.map((s) => (
                    <button key={s.id} type="button" className="btn ghost" aria-pressed={station === s.id} onClick={() => setStation(s.id)} data-testid={`radio-station-${s.id}`}>{s.name}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

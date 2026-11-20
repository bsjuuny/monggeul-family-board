// 설정 v2 항목: 날씨 지역, 등하원 시간, 화면 전환, TV 연결, 공지·자동 수집, 앱 업데이트
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useServices, useSession } from '../app/context';
import { useMembers } from '../app/queries';
import { isFamilyBoardError } from '../domain/errors';
import type { ChildCommute, SettingKey, Settings } from '../server/v2';
import { useToast } from '../ui/Toasts';
import { checkForUpdate, BUILD_ID } from '../app/swUpdate';

const WD = ['월', '화', '수', '목', '금', '토', '일'];
const PRESETS = [
  { name: '서울 시청', lat: 37.5665, lon: 126.978 }, { name: '수원', lat: 37.2636, lon: 127.0286 }, { name: '인천', lat: 37.4563, lon: 126.7052 },
  { name: '대전', lat: 36.3504, lon: 127.3845 }, { name: '대구', lat: 35.8714, lon: 128.6014 }, { name: '광주', lat: 35.1595, lon: 126.8526 },
  { name: '부산', lat: 35.1796, lon: 129.0756 }, { name: '제주', lat: 33.4996, lon: 126.5312 },
];
const DEFAULT_CHILD: ChildCommute = { weekdays: [1, 2, 3, 4, 5], leaveHomeAt: '08:30', arriveBy: '09:00', pickupAt: '16:30', pickupAtByWeekday: {}, pickupAssignee: '', pickupAssigneeByWeekday: {} };

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="card" id={id} aria-labelledby={`${id}-h`}><h2 id={`${id}-h`}>{title}</h2>{children}</section>;
}

function useSettings() {
  const { v2 } = useServices();
  return useQuery({ queryKey: ['v2settings'], queryFn: () => v2.settings() });
}

function useSave() {
  const { v2 } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ key, value, version }: { key: SettingKey; value: unknown; version: number }) => v2.putSetting(key, value, version),
    onSuccess: async () => {
      toast.info('저장했어요.');
      await qc.invalidateQueries({ queryKey: ['v2settings'] });
      await qc.invalidateQueries({ queryKey: ['board'] });
    },
    onError: async (e) => {
      toast.error(isFamilyBoardError(e) ? e.message : '저장하지 못했어요.');
      await qc.invalidateQueries({ queryKey: ['v2settings'] });
    },
  });
}

function WeatherSection({ s }: { s: Settings }) {
  const save = useSave();
  const [loc, setLoc] = useState({ name: s.location?.name ?? '', lat: String(s.location?.lat ?? ''), lon: String(s.location?.lon ?? '') });
  return (
    <Section id="set-weather" title="🌤 날씨 지역">
      <p className="muted">기상청 단기예보로 등원·하원 시점 날씨와 옷차림을 알려 드려요. 동네 위치를 정해 주세요{s.location?.grid ? ` (지금 격자 ${s.location.grid.join(', ')})` : ''}.</p>
      <div className="btn-row">{PRESETS.map((p) => <button key={p.name} type="button" className="btn ghost small" onClick={() => setLoc({ name: p.name, lat: String(p.lat), lon: String(p.lon) })}>{p.name}</button>)}</div>
      <div className="row3">
        <div className="field"><label htmlFor="wx-name">이름</label><input id="wx-name" value={loc.name} maxLength={30} onChange={(e) => setLoc({ ...loc, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="wx-lat">위도</label><input id="wx-lat" inputMode="decimal" value={loc.lat} onChange={(e) => setLoc({ ...loc, lat: e.target.value })} /></div>
        <div className="field"><label htmlFor="wx-lon">경도</label><input id="wx-lon" inputMode="decimal" value={loc.lon} onChange={(e) => setLoc({ ...loc, lon: e.target.value })} /></div>
      </div>
      <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate({ key: 'location', value: { name: loc.name, lat: Number(loc.lat), lon: Number(loc.lon) }, version: s._versions.location })}>위치 저장</button>
      <p className={s.weatherKeyConfigured ? 'muted' : 'err'} data-testid="weather-key">
        {s.weatherKeyConfigured ? '기상청 서비스 키: 설정됨' : '기상청 서비스 키가 없어요. 태블릿 Termux에서 python tablet_server/app.py --set-weather-key 로 넣어 주세요.'}
      </p>
    </Section>
  );
}

function CommuteSection({ s }: { s: Settings }) {
  const save = useSave();
  const members = useMembers();
  const kids = members.data?.children.filter((c) => c.active) ?? [];
  const [draft, setDraft] = useState<Record<string, ChildCommute>>(s.commute.children);
  useEffect(() => setDraft(s.commute.children), [s.commute.children]);
  const set = (id: string, p: Partial<ChildCommute>) => setDraft({ ...draft, [id]: { ...(draft[id] ?? DEFAULT_CHILD), ...p } });
  return (
    <Section id="set-commute" title="🏫 등하원 시간">
      {!kids.length && <p className="muted">아이를 먼저 추가해 주세요(아래 '아이와 습관').</p>}
      {kids.map((k) => {
        const c = draft[k.id];
        if (!c) return <div key={k.id} className="commute-child"><strong>{k.displayName}</strong> <button type="button" className="btn small" onClick={() => set(k.id, {})}>등하원 시간 정하기</button></div>;
        return (
          <fieldset key={k.id} className="commute-child">
            <legend>{k.displayName}</legend>
            <div className="btn-row" role="group" aria-label={`${k.displayName} 등원 요일`}>
              {WD.map((w, i) => {
                const n = i + 1;
                const on = c.weekdays.includes(n);
                return <label key={w} className="check"><input type="checkbox" checked={on} onChange={() => set(k.id, { weekdays: on ? c.weekdays.filter((x) => x !== n) : [...c.weekdays, n].sort() })} /> {w}</label>;
              })}
            </div>
            <div className="row3">
              <div className="field"><label htmlFor={`lv-${k.id}`}>집 출발</label><input id={`lv-${k.id}`} type="time" value={c.leaveHomeAt} onChange={(e) => set(k.id, { leaveHomeAt: e.target.value })} /></div>
              <div className="field"><label htmlFor={`ar-${k.id}`}>도착 목표</label><input id={`ar-${k.id}`} type="time" value={c.arriveBy} onChange={(e) => set(k.id, { arriveBy: e.target.value })} /></div>
              <div className="field"><label htmlFor={`pk-${k.id}`}>하원</label><input id={`pk-${k.id}`} type="time" value={c.pickupAt} onChange={(e) => set(k.id, { pickupAt: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor={`as-${k.id}`}>기본 픽업 담당</label><input id={`as-${k.id}`} value={c.pickupAssignee} maxLength={20} placeholder="예: 엄마" onChange={(e) => set(k.id, { pickupAssignee: e.target.value })} /></div>
            <details>
              <summary>요일마다 다르게</summary>
              <div className="weekday-grid">
                {WD.slice(0, 5).map((w, i) => {
                  const key = String(i + 1);
                  return (
                    <div key={w} className="row3">
                      <strong>{w}요일</strong>
                      <input type="time" aria-label={`${w}요일 하원`} value={c.pickupAtByWeekday[key] ?? ''} onChange={(e) => {
                        const m = { ...c.pickupAtByWeekday };
                        if (e.target.value) m[key] = e.target.value; else delete m[key];
                        set(k.id, { pickupAtByWeekday: m });
                      }} />
                      <input aria-label={`${w}요일 픽업 담당`} placeholder="담당" maxLength={20} value={c.pickupAssigneeByWeekday[key] ?? ''} onChange={(e) => {
                        const m = { ...c.pickupAssigneeByWeekday };
                        if (e.target.value) m[key] = e.target.value; else delete m[key];
                        set(k.id, { pickupAssigneeByWeekday: m });
                      }} />
                    </div>
                  );
                })}
              </div>
            </details>
          </fieldset>
        );
      })}
      {kids.length > 0 && <button type="button" className="btn" disabled={save.isPending} data-testid="save-commute" onClick={() => save.mutate({ key: 'commute', value: { children: draft }, version: s._versions.commute })}>등하원 시간 저장</button>}
    </Section>
  );
}

function ScreenSection({ s }: { s: Settings }) {
  const save = useSave();
  const [v, setV] = useState(s.screen);
  return (
    <Section id="set-screen" title="🌅 화면 전환 시각">
      <p className="muted">보드는 시간대에 따라 아침(등원) → 오후(하원) → 저녁(내일 준비) 화면으로 바뀌어요. 보드에서 직접 바꾸면 다음 전환 때까지 유지돼요.</p>
      <div className="row3">
        <div className="field"><label htmlFor="sc-m">아침 시작</label><input id="sc-m" type="time" value={v.morningFrom} onChange={(e) => setV({ ...v, morningFrom: e.target.value })} /></div>
        <div className="field"><label htmlFor="sc-a">오후 시작</label><input id="sc-a" type="time" value={v.afternoonFrom} onChange={(e) => setV({ ...v, afternoonFrom: e.target.value })} /></div>
        <div className="field"><label htmlFor="sc-e">저녁 시작</label><input id="sc-e" type="time" value={v.eveningFrom} onChange={(e) => setV({ ...v, eveningFrom: e.target.value })} /></div>
      </div>
      <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate({ key: 'screen', value: v, version: s._versions.screen })}>전환 시각 저장</button>
    </Section>
  );
}

function TvPrivacy({ s }: { s: Settings }) {
  const save = useSave();
  const p = s.tvPrivacy;
  const set = (k: keyof Settings['tvPrivacy'], v: boolean) => save.mutate({ key: 'tvPrivacy', value: { ...p, [k]: v }, version: s._versions.tvPrivacy });
  return (
    <div className="sync-box" data-testid="tv-privacy">
      <strong>TV에서 가릴 정보</strong>
      <p className="muted">손님이 거실 TV를 볼 수 있어요. 켠 항목은 TV에서만 가리고, 보호자 화면에는 그대로 보여요.</p>
      <label className="check"><input type="checkbox" checked={p.hideChildNames} disabled={save.isPending} onChange={(e) => set('hideChildNames', e.target.checked)} /> 아이 이름 가리기</label>
      <label className="check"><input type="checkbox" checked={p.hideNoticeTitles} disabled={save.isPending} onChange={(e) => set('hideNoticeTitles', e.target.checked)} /> 공지 제목 가리기</label>
      <label className="check"><input type="checkbox" checked={p.hidePickup} disabled={save.isPending} onChange={(e) => set('hidePickup', e.target.checked)} /> 픽업 담당자 가리기</label>
    </div>
  );
}

function TvSection({ s }: { s: Settings }) {
  const { v2 } = useServices();
  const qc = useQueryClient();
  const toast = useToast();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => v2.devices() });
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const make = useMutation({ mutationFn: () => v2.createPairingCode(), onSuccess: setCode, onError: (e) => toast.error(isFamilyBoardError(e) ? e.message : '코드를 만들지 못했어요.') });
  const revoke = useMutation({ mutationFn: (id: string) => v2.revokeDevice(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['devices'] }) });
  const live = devices.data?.devices.filter((d) => !d.revokedAt) ?? [];
  return (
    <Section id="set-tv" title="📺 TV 연결">
      <p className="muted">거실 TV·태블릿 브라우저에서 <strong>이 서버 주소/#/display</strong> 를 열고, 아래 코드를 넣으면 로그인 없이 오늘 정보만 보여요. TV에서는 설정·공지 원문을 볼 수 없어요.</p>
      <button type="button" className="btn" onClick={() => make.mutate()} disabled={make.isPending} data-testid="make-pair-code">연결 코드 만들기</button>
      {code && <p className="big-code" data-testid="pair-code" aria-live="polite">{code.code} <small className="muted">{new Date(code.expiresAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}까지</small></p>}
      <ul className="list">
        {live.map((d) => (
          <li key={d.id} className="prep-row"><span>📺 {d.label} · 마지막 접속 {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString('ko-KR') : '-'}</span>
            <button type="button" className="btn ghost small" onClick={() => revoke.mutate(d.id)}>연결 해제</button></li>
        ))}
        {!live.length && <li className="muted">연결된 TV가 없어요.</li>}
      </ul>
      <TvPrivacy s={s} />
    </Section>
  );
}

function NoticeSyncSection({ s }: { s: Settings }) {
  const { v2 } = useServices();
  const { isOwner } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const save = useSave();
  const status = useQuery({ queryKey: ['notice-sync'], queryFn: () => v2.syncStatus() });
  const run = useMutation({
    mutationFn: () => v2.syncNow(),
    onSuccess: async (r) => { toast.info(r.ok ? `새 공지 ${r.created}건, 바뀐 공지 ${r.updated}건` : `수집 실패: ${r.error}`); await qc.invalidateQueries({ queryKey: ['notice-sync'] }); await qc.invalidateQueries({ queryKey: ['board'] }); },
    onError: (e) => toast.error(isFamilyBoardError(e) ? e.message : '동기화하지 못했어요.'),
  });
  const resume = useMutation({ mutationFn: () => v2.syncResume(), onSuccess: () => qc.invalidateQueries({ queryKey: ['notice-sync'] }) });
  const st = status.data;
  return (
    <Section id="set-notices" title="📨 공지 저장·자동 수집">
      <label className="check"><input type="checkbox" disabled={!isOwner || save.isPending} checked={s.notices.storeOriginal} onChange={(e) => save.mutate({ key: 'notices', value: { ...s.notices, storeOriginal: e.target.checked }, version: s._versions.notices })} /> 공지 원문도 태블릿에 저장(기본: 요약만 저장)</label>
      {!isOwner && <p className="muted">공지·자동 수집 설정은 owner만 바꿀 수 있어요.</p>}
      {st && (
        <div className="sync-box" data-testid="sync-box">
          <p><strong>{st.adapter.name}</strong> · {st.adapter.available ? (st.adapter.mode === 'mock' ? '모의 데이터(개발·QA)' : '사용 가능') : '사용할 수 없음'}</p>
          {st.adapter.reason && <p className="muted">{st.adapter.reason}</p>}
          <label className="check"><input type="checkbox" disabled={!isOwner || !st.adapter.available || save.isPending} checked={s.kidsnote.enabled}
            onChange={(e) => save.mutate({ key: 'kidsnote', value: { ...s.kidsnote, enabled: e.target.checked }, version: s._versions.kidsnote })} /> 정해진 시각에 자동으로 확인({s.kidsnote.times.join(', ')})</label>
          <div className="btn-row">
            <button type="button" className="btn secondary" disabled={!st.adapter.available || run.isPending} onClick={() => run.mutate()}>지금 동기화</button>
            {st.state.paused && <button type="button" className="btn ghost" onClick={() => resume.mutate()}>자동 수집 다시 켜기</button>}
          </div>
          {st.state.lastError && <p className="err">마지막 오류: {st.state.lastError}{st.state.paused ? ' · 연속 실패로 자동 수집을 멈췄어요.' : ''}</p>}
          {st.runs.length > 0 && <ul className="list small">{st.runs.slice(0, 5).map((r, i) => <li key={i}>{new Date(r.started_at).toLocaleString('ko-KR')} · {r.trigger === 'manual' ? '수동' : '예약'} · {r.ok ? `성공(새 ${r.created}, 변경 ${r.updated})` : `실패`}</li>)}</ul>}
        </div>
      )}
    </Section>
  );
}

function UpdateSection() {
  const toast = useToast();
  return (
    <Section id="set-update" title="🔄 앱 업데이트">
      <p className="muted">화면 버전 {BUILD_ID}. 태블릿 서버를 새 버전으로 바꾸면 TV 화면은 자동으로 새로고침돼요.</p>
      <button type="button" className="btn ghost" onClick={() => void checkForUpdate().then((found) => toast.info(found ? '새 버전을 적용하는 중이에요.' : '지금이 최신 버전이에요.'))}>새 버전 확인</button>
    </Section>
  );
}

export function V2SettingsSections() {
  const q = useSettings();
  if (!q.data) return null;
  return (
    <>
      <WeatherSection s={q.data} />
      <CommuteSection s={q.data} />
      <ScreenSection s={q.data} />
      <TvSection s={q.data} />
      <NoticeSyncSection s={q.data} />
      <UpdateSection />
    </>
  );
}

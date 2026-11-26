// 몽글 동화형 메인 보드 (디자인 명세 docs/design/v2/DESIGN_SPEC.md)
// 홈(성인)과 TV(읽기 전용)가 같은 화면을 쓴다. 그림·캐릭터 레이어와 데이터 컴포넌트를 분리한다.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import type { Board, NoticeCard as NoticeCardData, Period, PrepItem } from '../server/v2';
import { Bodeuli, Jjokkomi, Monggeul, Nabi, Pogeuni } from '../ui/characters';
import type { CharacterProps } from '../ui/characters';
import { commuteView, dateKo, greeting, kstHm, periodAt, periodEndsAt, shortDateKo, splitUnits, weatherPhrase } from './format';
import { Icon, adviceIcon, weatherIcon } from './icons';

const PERIOD_LABEL: Record<Period, string> = { morning: '아침', afternoon: '오후', evening: '저녁' };

/** 대화상자: 열리면 첫 버튼으로 포커스, Tab 은 안에서만 돌고, Escape 로 닫고, 닫히면 원래 자리로 포커스를 돌려준다 */
export function useDialog(open: boolean, firstRef: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    firstRef.current?.focus();
    const panel = firstRef.current?.closest('[role="dialog"]') as HTMLElement | null;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]):not([tabindex="-1"]), input, select, textarea')];
      if (!items.length) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      back?.focus?.();
    };
  }, [open, firstRef, onClose]);
}

/** 리모컨 방향키: 카드 사이를 화면 위치 기준으로 이동한다(시간대 탭 안에서는 탭 규칙을 쓴다) */
function onBoardArrows(e: KeyboardEvent<HTMLDivElement>) {
  const dirs: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const d = dirs[e.key];
  const cur = document.activeElement as HTMLElement | null;
  if (!d || !cur || cur.closest('[role="tablist"]') || cur.closest('[role="dialog"]') || /INPUT|SELECT|TEXTAREA/.test(cur.tagName)) return;
  const root = e.currentTarget;
  const from = cur.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]):not([tabindex="-1"])')) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const along = dx * d[0] + dy * d[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) { e.preventDefault(); best.focus(); }
}
const OVERRIDE_KEY = 'mgfb.periodOverride';

/** 자동 시간대 + 수동 전환(다음 자동 전환 시각까지만 유지) */
export function usePeriod(board: Board | undefined, now: Date): [Period, (p: Period) => void] {
  const [override, setOverride] = useState<{ period: Period; until: number } | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(OVERRIDE_KEY) ?? 'null') as { period: Period; until: number } | null;
      return v && v.until > Date.now() ? v : null;
    } catch {
      return null;
    }
  });
  const auto: Period = board ? periodAt(now, board.screen) : 'morning';
  const active = override && override.until > now.getTime() ? override.period : auto;
  const choose = (p: Period) => {
    if (!board) return;
    const v = p === periodAt(new Date(), board.screen) ? null : { period: p, until: periodEndsAt(new Date(), board.screen) };
    setOverride(v);
    try {
      if (v) localStorage.setItem(OVERRIDE_KEY, JSON.stringify(v));
      else localStorage.removeItem(OVERRIDE_KEY);
    } catch {
      /* 저장소를 못 쓰면 이번 화면에서만 */
    }
  };
  return [active, choose];
}

const SCENE_CHARS: Record<Period, Array<{ C: (p: CharacterProps) => ReactNode; mood: 'happy' | 'cheer' | 'sleepy'; right: number; bottom: number; width: number; name: string }>> = {
  morning: [
    { C: Monggeul, mood: 'happy', right: 30, bottom: 3, width: 18, name: 'monggeul' },
    { C: Bodeuli, mood: 'happy', right: 19, bottom: 4, width: 12, name: 'bodeuli' },
  ],
  afternoon: [
    { C: Pogeuni, mood: 'happy', right: 27, bottom: 2, width: 17, name: 'pogeuni' },
    { C: Jjokkomi, mood: 'cheer', right: 16, bottom: 3, width: 11, name: 'jjokkomi' },
  ],
  evening: [
    { C: Monggeul, mood: 'sleepy', right: 29, bottom: 2, width: 18, name: 'monggeul' },
    { C: Nabi, mood: 'sleepy', right: 17, bottom: 3, width: 12, name: 'nabi' },
  ],
};

function art(name: string, wide: boolean) {
  return `${import.meta.env.BASE_URL}art/board/${name}${wide ? '' : '-1200'}.webp`;
}

function Clock({ now }: { now: Date }) {
  const hm = kstHm(now);
  return (
    <p className="v2-clock" aria-label={`지금 ${Number(hm.slice(0, 2))}시 ${Number(hm.slice(3))}분`}>
      <span>{hm.slice(0, 2)}</span>
      <span className="v2-clock__colon" aria-hidden="true">:</span>
      <span>{hm.slice(3)}</span>
    </p>
  );
}

function PeriodSwitch({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const order: Period[] = ['morning', 'afternoon', 'evening'];
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = order.indexOf(period);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % 3;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i + 2) % 3;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 2;
    if (next >= 0) {
      e.preventDefault();
      onChange(order[next] as Period);
      refs.current[next]?.focus();
    }
  };
  return (
    <div className="v2-period" role="tablist" aria-label="화면 시간대" onKeyDown={onKey}>
      {order.map((p, i) => (
        <button key={p} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={period === p} tabIndex={period === p ? 0 : -1}
          className={period === p ? 'is-on' : ''} onClick={() => onChange(p)} data-testid={`period-${p}`}>
          {PERIOD_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

function Badge({ tone, icon, children }: { tone: 'warning' | 'reply' | 'success' | 'info'; icon?: Parameters<typeof Icon>[0]['name']; children: ReactNode }) {
  return <span className={`v2-badge v2-badge--${tone}`}>{icon && <Icon name={icon} size={16} />}{children}</span>;
}

function BigValue({ value }: { value: string }) {
  if (/^\d{1,2}:\d{2}$/.test(value)) return <span className="v2-big" key={value}><span className="v2-big__num">{value}</span></span>;
  const parts = splitUnits(value);
  if (!parts.length) return <span className="v2-big">{value}</span>;
  return (
    <span className="v2-big" key={value}>
      {parts.map(([n, u], i) => (
        <span key={i} className="v2-big__part"><span className="v2-big__num">{n}</span><span className="v2-big__unit">{u}</span></span>
      ))}
    </span>
  );
}

function CommuteCard({ board, period, now, interactive, onPickupDone }: { board: Board; period: Period; now: Date; interactive: boolean; onPickupDone?: () => void }) {
  const pick = board.pickups[0];
  const view = commuteView(period, now, board.commute.today, board.commute.tomorrow, Boolean(pick?.doneAt), pick?.assignee ?? null,
    { afterToday: board.commute.nextAfterToday, afterTomorrow: board.commute.nextAfterTomorrow, base: board.today });
  const multi = board.children.length > 1;
  return (
    <section className="v2-card v2-commute" aria-labelledby="v2-commute-title">
      <div className="v2-commute__art" aria-hidden="true" style={{ backgroundImage: `url(${art('commute-path', true)})` }} />
      <h2 id="v2-commute-title" className="v2-card__title"><Icon name={period === 'afternoon' ? 'home' : 'school'} />{period === 'evening' ? '내일 등원' : period === 'afternoon' ? '하원' : '등원'}</h2>
      <div className="v2-commute__body" data-testid="commute-view" data-kind={view.kind}>
        {view.kind === 'empty' && (
          <div className="v2-empty"><strong>등하원 시간이 필요해요</strong><span>보호자 화면에서 시간을 알려 주세요</span>
            {interactive && <Link className="v2-btn" to="/settings#set-commute">시간 정하기</Link>}</div>
        )}
        {view.kind === 'off' && (
          <div className="v2-empty v2-commute__off"><strong>{view.title}</strong>{view.note && <span>{view.note}</span>}{view.needsReview && <Badge tone="warning" icon="alert">확인 필요</Badge>}
            {view.next && <p className="v2-commute__next" data-testid="next-commute"><span>다음 등원</span><b>{view.next.when} {view.next.time}</b></p>}</div>
        )}
        {(view.kind === 'countdown' || view.kind === 'clock') && (
          <>
            <p className="v2-commute__label">{view.label}</p>
            <p className="v2-commute__value" aria-live="off"><BigValue value={view.value} /></p>
            <div className="v2-commute__meta">
              {view.pill && <span className="v2-pill">{view.pill}</span>}
              {view.sub && <span className="v2-commute__sub">{view.sub}</span>}
            </div>
            {view.changeNote && <p className="v2-commute__change"><Badge tone={view.needsReview ? 'warning' : 'info'} icon="alert">{view.needsReview ? '확인 필요' : '변경'}</Badge>{view.changeNote.replace(' (확인 필요)', '')}</p>}
            {period === 'afternoon' && view.kind === 'countdown' && !pick?.assignee && <p className="v2-commute__change"><Badge tone="warning" icon="person">픽업 담당자 확인 필요</Badge></p>}
          </>
        )}
        {view.kind === 'done' && (
          <div className="v2-empty"><Badge tone={view.tone} icon={view.tone === 'success' ? 'check' : 'alert'}>{view.title}</Badge>{view.sub && <span>{view.sub}</span>}
            {interactive && view.tone === 'warning' && onPickupDone && <button type="button" className="v2-btn" onClick={onPickupDone}>하원 완료로 표시</button>}</div>
        )}
        {multi && board.commute.today.length > 1 && period !== 'evening' && (
          <ul className="v2-commute__kids">
            {board.commute.today.map((p) => {
              const c = board.children.find((k) => k.id === p.childId);
              return <li key={p.childId}>{c?.displayName}: {p.attends ? `${p.leaveHomeAt} 출발 · ${p.pickupAt} 하원` : '쉬는 날'}</li>;
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function WeatherCard({ board, period, interactive }: { board: Board; period: Period; interactive: boolean }) {
  const w = board.weather;
  const evening = period === 'evening';
  return (
    <section className="v2-card v2-weather" aria-labelledby="v2-weather-title">
      <div className="v2-deco v2-deco--weather" aria-hidden="true" style={{ backgroundImage: `url(${art('card-weather', true)})` }} />
      <div className="v2-card__head">
        <h2 id="v2-weather-title" className="v2-card__title"><Icon name="cloudSun" />{evening ? '내일 날씨' : '오늘 날씨'}</h2>
        {w.configured && w.available && (w.stale
          ? <Badge tone="warning" icon="refresh">오래된 날씨 · {kstHm(new Date(w.updatedAt))} 기준</Badge>
          : <span className="v2-muted">{kstHm(new Date(w.updatedAt))} 갱신</span>)}
      </div>
      {!w.configured && (
        <div className="v2-empty">
          <strong>{w.reason === 'location' ? '날씨 지역을 정해 주세요' : '날씨 서비스 키가 필요해요'}</strong>
          <span>{w.reason === 'location' ? '보호자 화면에서 지역을 설정할 수 있어요' : '태블릿 서버에 기상청 키를 넣어 주세요'}</span>
          {interactive && w.reason === 'location' && <Link className="v2-btn" to="/settings#set-weather">지역 정하기</Link>}
        </div>
      )}
      {w.configured && !w.available && <div className="v2-empty"><strong>날씨를 아직 받지 못했어요</strong><span>{w.error}</span></div>}
      {w.configured && w.available && (() => {
        const temp = evening ? w.tomorrow.dropoff?.tmp ?? w.tomorrow.min : w.current.temp;
        const cond = evening ? w.tomorrow.dropoff?.condition ?? w.tomorrow.condition : w.current.condition;
        const advice = evening ? w.tomorrowAdvice : w.advice;
        // 등원하지 않는 날은 등원·하원 칸 대신 그날 최저·최고와 비 올 확률
        const goes = (evening ? board.commute.tomorrow : board.commute.today).some((p) => p.attends);
        const day = evening ? w.tomorrow : w.today;
        const range = day.min == null ? '–' : `${Math.round(day.min)}° / ${Math.round(day.max ?? day.min)}°`;
        return (
          <>
            <div className="v2-weather__now">
              <Icon name={weatherIcon(cond, evening ? w.tomorrow.dropoff?.pty : w.current.pty)} size={84} className="v2-weather__icon" />
              <div>
                <p className="v2-weather__temp" data-testid="weather-temp">{temp == null ? '–' : Math.round(temp)}<span className="v2-weather__deg">°</span></p>
                <p className="v2-weather__phrase">{weatherPhrase(cond, temp)}</p>
              </div>
            </div>
            {advice.length > 0
              ? <ul className="v2-chips" aria-label="옷차림·우산 안내">{advice.slice(0, 3).map((a) => <li key={a.code} className={`v2-chip v2-chip--${a.tone}`}><Icon name={adviceIcon(a.code)} size={20} />{a.text}</li>)}</ul>
              : <p className="v2-muted">{goes ? '등하원 시각 예보가 없어 옷차림 안내를 쉬어요' : evening ? '내일은 등원이 없는 날이에요' : '오늘은 등원이 없는 날이에요'}</p>}
            <dl className="v2-mini">
              {!goes ? (
                <>
                  <div><dt>최저·최고</dt><dd>{range}</dd></div>
                  <div><dt>비 올 확률</dt><dd>{day.popMax == null ? '–' : `${day.popMax}%`}</dd></div>
                </>
              ) : evening ? (
                <>
                  <div><dt>내일 등원</dt><dd>{w.tomorrow.dropoff ? `${w.tomorrow.dropoff.time} · ${Math.round(w.tomorrow.dropoff.tmp ?? 0)}°` : board.commute.configured ? '예보 없음' : '시각 미설정'}</dd></div>
                  <div><dt>최저·최고</dt><dd>{range}</dd></div>
                </>
              ) : (
                <>
                  <div><dt>등원</dt><dd>{w.dropoff ? `${w.dropoff.time} · ${Math.round(w.dropoff.tmp ?? 0)}°` : board.commute.configured ? '예보 없음' : '시각 미설정'}</dd></div>
                  <div><dt>하원</dt><dd>{w.pickup ? `${w.pickup.time} · ${Math.round(w.pickup.tmp ?? 0)}°` : board.commute.configured ? '예보 없음' : '시각 미설정'}</dd></div>
                </>
              )}
            </dl>
          </>
        );
      })()}
    </section>
  );
}

function noticeTimeKo(time?: string | null) {
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return '';
  const hour = Number(time.slice(0, 2)); const minute = Number(time.slice(3));
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}시${minute ? ` ${minute}분` : ''}`;
}

function NoticePeek({ n, today, onClose }: { n: NoticeCardData; today: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialog(true, closeRef, onClose);
  return (
    <div className="v2-menu v2-peek" role="dialog" aria-modal="true" aria-labelledby="v2-peek-title">
      <button type="button" className="v2-menu__backdrop" aria-label="닫기" tabIndex={-1} onClick={onClose} />
      <div className="v2-menu__panel">
        <h2 id="v2-peek-title">{n.title}<button ref={closeRef} type="button" className="v2-menu__close" onClick={onClose} aria-label="닫기"><Icon name="close" /></button></h2>
        <p className="v2-notice__badges">
          {n.status === 'needs_review' && <Badge tone="warning" icon="alert">확인 필요</Badge>}
          {n.needsReply && <Badge tone="reply" icon="chat">답장 필요</Badge>}
        </p>
        {n.eventDate && <p className="v2-peek__line"><Icon name="calendar" size={20} />{shortDateKo(n.eventDate, today)} · {dateKo(n.eventDate)}{noticeTimeKo(n.eventTime) && ` · ${noticeTimeKo(n.eventTime)}`}</p>}
        {n.reviewReasons.length > 0 && <p className="v2-peek__line"><Icon name="alert" size={20} />확인할 것: {n.reviewReasons.join(', ')}</p>}
        <p className="v2-muted">자세한 내용과 확인은 보호자 휴대폰의 '공지 정리'에서 할 수 있어요.</p>
      </div>
    </div>
  );
}

function NoticeCard({ board, interactive }: { board: Board; interactive: boolean }) {
  const [peek, setPeek] = useState<NoticeCardData | null>(null);
  const top = board.notices.top;
  const shown = top.slice(0, 2);
  const rest = top.length - shown.length;
  const unread = board.notices.needsReview;
  return (
    <section className="v2-card v2-notices" aria-labelledby="v2-notice-title">
      <div className="v2-deco v2-deco--corner" aria-hidden="true" style={{ backgroundImage: `url(${art('card-notice', true)})` }} />
      <div className="v2-card__head">
        <h2 id="v2-notice-title" className="v2-card__title"><Icon name="bell" />공지톡 소식</h2>
        {unread > 0 && <span className="v2-count">확인할 소식 {unread}건</span>}
      </div>
      {shown.length === 0 ? (
        <div className="v2-empty"><strong>새로운 공지가 없어요</strong><span>확인할 소식이 생기면 여기에 보여드려요</span>
          {interactive && <Link className="v2-btn" to="/notices/new">공지 붙여넣기</Link>}</div>
      ) : (
        <ul className="v2-notice-list">
          {shown.map((n) => {
            const inner = (
              <>
                <span className="v2-notice__badges">
                  {(n.status === 'needs_review' || n.status === 'pending_analysis') && <Badge tone="warning" icon="alert">{n.status === 'pending_analysis' ? '분석 대기' : '확인 필요'}</Badge>}
                  {n.needsReply && <Badge tone="reply" icon="chat">답장 필요</Badge>}
                </span>
                <strong className="v2-notice__title">{n.title}</strong>
                <span className="v2-notice__sub">{n.eventDate ? `${shortDateKo(n.eventDate, board.today)}${noticeTimeKo(n.eventTime) ? ` ${noticeTimeKo(n.eventTime)}` : ''} · ` : ''}{n.reviewReasons.length ? n.reviewReasons.join(' · ') : `${shortDateKo(n.receivedOn, board.today)} 받은 공지`}</span>
              </>
            );
            return <li key={n.id} data-testid="board-notice">{interactive ? <Link className="v2-notice" to={`/notices/${n.id}`}>{inner}</Link> : <button type="button" className="v2-notice v2-notice--peek" onClick={() => setPeek(n)}>{inner}</button>}</li>;
          })}
        </ul>
      )}
      {rest > 0 && (interactive ? <Link className="v2-more" to="/notices">그 밖의 소식 {rest}건</Link> : <p className="v2-more">그 밖의 소식 {rest}건</p>)}
      {peek && <NoticePeek n={peek} today={board.today} onClose={() => setPeek(null)} />}
    </section>
  );
}

function PrepCard({ board, period, interactive, onToggle }: { board: Board; period: Period; interactive: boolean; onToggle?: (p: PrepItem) => void }) {
  const todayItems = board.prep.today.filter((p) => p.kind !== 'parent_task');
  // 아침에 오늘 챙길 것이 없으면 내일 것을 미리 보여 준다
  const tomorrow = period === 'evening' || (period === 'morning' && !todayItems.length && board.prep.tomorrow.length > 0);
  const items = (tomorrow ? board.prep.tomorrow : period === 'afternoon' ? [...board.prep.today.filter((p) => p.kind === 'pickup'), ...board.prep.tomorrow] : todayItems)
    .filter((p) => p.kind !== 'parent_task' || period === 'evening');
  const max = typeof window === 'undefined' ? 6 : window.innerHeight < 860 && window.innerWidth > 600 ? 3 : window.innerWidth < 1200 || window.innerHeight < 900 ? 4 : 6;
  const shown = items.slice(0, items.length > max ? max - 1 : max);
  const events = tomorrow ? board.events.tomorrow : board.events.today;
  return (
    <section className="v2-card v2-prep" aria-labelledby="v2-prep-title">
      <div className="v2-deco v2-deco--corner" aria-hidden="true" style={{ backgroundImage: `url(${art('card-prep', true)})` }} />
      <div className="v2-card__head">
        <h2 id="v2-prep-title" className="v2-card__title"><Icon name="bag" />{tomorrow ? '내일 준비물' : period === 'afternoon' ? '하원 준비·내일 준비물' : '오늘 준비물'}</h2>
        {tomorrow && period === 'morning' && <span className="v2-muted">오늘은 없어요</span>}
      </div>
      {shown.length === 0 ? (
        <div className="v2-empty v2-empty--small"><strong>챙길 준비물이 없어요</strong><span>가볍게 출발해요</span></div>
      ) : (
        <ul className="v2-chips" aria-label="준비물">
          {shown.map((p) => {
            const done = Boolean(p.doneAt);
            const label = `${p.kind === 'parent_task' ? '할 일: ' : ''}${p.text}${p.date && period === 'afternoon' && p.date === board.tomorrow ? ' (내일)' : ''}`;
            return (
              <li key={p.id} className={`v2-chip v2-chip--prep${done ? ' is-done' : ''}${p.needsReview ? ' is-review' : ''}`}>
                {interactive && onToggle
                  ? <button type="button" aria-pressed={done} onClick={() => onToggle(p)} data-testid="prep-chip"><Icon name={done ? 'check' : p.kind === 'document' ? 'doc' : 'bag'} size={20} />{label}</button>
                  : <span data-testid="prep-chip"><Icon name={done ? 'check' : p.kind === 'document' ? 'doc' : 'bag'} size={20} />{label}</span>}
              </li>
            );
          })}
          {items.length > shown.length && <li className="v2-chip v2-chip--more">외 {items.length - shown.length}개</li>}
        </ul>
      )}
      {events.length > 0 && (
        <p className="v2-prep__events"><Icon name="calendar" size={20} /><span className="v2-ellipsis">{events.slice(0, 2).map((e) => { const t = e.time ?? (e.startsAt ? kstHm(new Date(e.startsAt)) : ''); return `${t && !e.title.includes(t) ? `${t} ` : ''}${e.title}`; }).join(' · ')}{events.length > 2 ? ` 외 ${events.length - 2}` : ''}</span></p>
      )}
    </section>
  );
}

export interface BoardScreenProps {
  board: Board;
  now: Date;
  variant: 'home' | 'tv';
  online: boolean;
  /** 마지막 갱신 실패 시각(오프라인 띠) */
  offlineSince?: number | null;
  menu?: ReactNode;
  onTogglePrep?: (p: PrepItem) => void;
  onPickupDone?: () => void;
  testId?: string;
}

export function BoardScreen({ board, now, variant, online, menu, onTogglePrep, onPickupDone, testId = 'v2-board' }: BoardScreenProps) {
  const [period, setPeriod] = usePeriod(board, now);
  const interactive = variant === 'home';
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 600px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 600px)');
    const update = () => setCompact(query.matches);
    if (query.addEventListener) query.addEventListener('change', update);
    else query.addListener(update);
    return () => { if (query.removeEventListener) query.removeEventListener('change', update); else query.removeListener(update); };
  }, []);
  const prepFirst = interactive && compact && period === 'evening';
  const prep = <PrepCard board={board} period={period} interactive={interactive} onToggle={onTogglePrep} />;
  const wide = typeof window !== 'undefined' ? window.innerWidth >= 1100 : true;
  const w = board.weather;
  const weatherStale = w.configured && w.available && w.stale;
  const [recovered, setRecovered] = useState(false);
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      setRecovered(true);
      const t = setTimeout(() => setRecovered(false), 3000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [online]);
  const banner = useMemo(() => {
    const at = weatherStale ? kstHm(new Date(w.updatedAt)) : null;
    if (!online) return { tone: 'offline', icon: 'wifiOff' as const, text: at ? `오프라인 · 날씨는 ${at} 기준이에요` : '오프라인 · 마지막으로 받은 정보를 보여드려요' };
    if (weatherStale) return { tone: 'warning', icon: 'refresh' as const, text: `날씨를 새로 받지 못했어요 · ${at} 기준${w.configured && w.available && w.error ? ` · ${w.error}` : ''}` };
    if (recovered) return { tone: 'success', icon: 'check' as const, text: '연결됐어요 · 정보 갱신 완료' };
    return null;
  }, [online, weatherStale, recovered, w]);
  const names = board.children.map((c) => c.displayName);
  const scene = { morning: 'scene-morning', afternoon: 'scene-afternoon', evening: 'scene-evening' }[period];

  return (
    <div className="v2-board" data-period={period} data-variant={variant} data-prep-first={prepFirst ? 'true' : undefined} data-testid={testId} onKeyDown={onBoardArrows}
      style={{ ['--v2-paper' as string]: `url("${new URL(`${import.meta.env.BASE_URL}art/board/paper-texture.webp`, document.baseURI).href}")` }}>
      <div className={`v2-board__inner${banner ? ' has-banner' : ''}`}>
        {banner && <div className={`v2-banner v2-banner--${banner.tone}`} role="status" data-testid="v2-banner"><Icon name={banner.icon} size={20} />{banner.text}</div>}
        <header className="v2-hero">
          <section className="v2-greet" aria-label="인사와 시계">
            <p className="v2-greet__hello">{greeting(period, names)}</p>
            <Clock now={now} />
            <h1 className="v2-greet__date">{dateKo(board.calendarToday ?? board.today)}</h1>
            <PeriodSwitch period={period} onChange={setPeriod} />
          </section>
          <div className="v2-scene" style={{ backgroundImage: `url(${art(scene, wide)})` }} role="img" aria-label={`${PERIOD_LABEL[period]} 창밖 풍경`}>
            {SCENE_CHARS[period].map(({ C, mood, right, bottom, width, name }, i) => (
              <span key={name} className={`v2-char v2-char--${i}`} style={{ right: `${right}%`, bottom: `${bottom}%`, width: `${width}%` }}>
                <C mood={mood} decorative />
              </span>
            ))}
          </div>
        </header>
        <div className="v2-cards">
          {prepFirst && prep}
          <CommuteCard board={board} period={period} now={now} interactive={interactive} onPickupDone={onPickupDone} />
          <WeatherCard board={board} period={period} interactive={interactive} />
          <div className="v2-side">
            <NoticeCard board={board} interactive={interactive} />
            {!prepFirst && prep}
          </div>
        </div>
      </div>
      {menu}
    </div>
  );
}

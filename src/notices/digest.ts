// 공지 원문 → 보드용 요약(NoticeDigest). 브라우저와 서버(node 번들)가 같은 코드를 쓴다.
import { analyzeNotice } from './analyzer';
import { extractDates, findTimes, sentenceOf } from './dates';
import { contentHash } from './sha256';
import type { Change, DateConfidence, DateMention, DatedText, NoticeDigest } from './types';

const GREETING = /^(?:안녕하세요[!.~]*|안녕하십니까[!.~]*|학부모님[,!.~ ]*|어머님[,!.~ ]*|아버님[,!.~ ]*|부모님[,!.~ ]*)\s*/;
const TAIL = /\s*(?:이|가|은|는|을|를)?\s*(?:있습니다|있어요|있을\s*예정입니다|예정입니다|예정이에요|진행해요|예정되어\s*있습니다|진행됩니다|진행할\s*예정입니다|진행합니다|시작됩니다|실시합니다|안내드립니다|알려드립니다)[.!~]*$/;
const DOC_WORDS = ['동의서', '신청서', '서류', '서명', '회신서', '확인서', '설문', '가정통신문 회신', '투약의뢰서'];
const CLOSURE = /(휴원|휴무|쉽니다|방학|등원하지\s*않|가정\s*보육|원\s*운영을\s*하지|운영하지\s*않)/;
const EARLY = /(조기\s*하원|일찍\s*하원|단축\s*(?:수업|운영)|하원\s*시간을\s*앞당)/;

function splitSentences(text: string): Array<{ s: string; index: number }> {
  const out: Array<{ s: string; index: number }> = [];
  const re = /[^.!?\n]+[.!?]?/g;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s) out.push({ s, index: m.index ?? 0 });
  }
  return out;
}

function datesIn(mentions: DateMention[], start: number, end: number) {
  return mentions.filter((m) => m.index >= start && m.index < end);
}

/** 한 문장 안의 날짜 하나를 고른다. 정확한 날짜를 우선하고, 서로 다르면 '추정'으로 낮춘다. */
function pickDate(ms: DateMention[]): { date: string; endDate: string | null; time: string | null; confidence: DateConfidence } | null {
  if (!ms.length) return null;
  const exact = ms.find((m) => m.confidence === 'exact');
  const rel = ms.find((m) => m.confidence === 'relative');
  const chosen = exact ?? rel ?? (ms[0] as DateMention);
  let confidence: DateConfidence = chosen.confidence;
  if (exact && rel && exact.date !== rel.date) confidence = 'inferred';
  const time = ms.find((m) => m.time)?.time ?? null;
  return { date: chosen.date, endDate: chosen.endDate, time, confidence };
}

function shortTitle(sentence: string, fallback: string): string {
  let t = sentence.replace(GREETING, '').replace(/[.!?]$/, '').trim();
  t = t.replace(/^(?:오늘|내일|모레|이번\s*주\s*[월화수목금토일]요일|다음\s*주\s*[월화수목금토일]요일|\d{1,2}\s*월\s*\d{1,2}\s*일(?:\s*\([^)]*\))?)\s*(?:은|는|에|에는)?\s*/, '');
  t = t.replace(TAIL, '').trim();
  if (t.length < 2) t = fallback;
  return t.length > 32 ? `${t.slice(0, 31)}…` : t;
}

const CONF_RANK: Record<DateConfidence, number> = { exact: 0, relative: 1, inferred: 2, unknown: 3 };

export interface DigestResult {
  digest: NoticeDigest;
  contentHash: string;
}

export function buildDigest(text: string, receivedOn: string): DigestResult {
  const clean = text.replace(/﻿/g, '').replace(/\r\n?/g, '\n').trim();
  const a = analyzeNotice(clean);
  const mentions = extractDates(clean, receivedOn);
  const sentences = splitSentences(clean);
  const sentDate = (idx: number) => {
    const sent = sentences.find((x) => idx >= x.index && idx < x.index + x.s.length + 1);
    return sent ? pickDate(datesIn(mentions, sent.index, sent.index + sent.s.length + 1)) : null;
  };

  // 대표 행사 날짜: 행사 단어가 있는 문장의 날짜 → 마감이 아닌 첫 날짜
  const eventM = mentions.find((m) => m.kind === 'event') ?? mentions.find((m) => m.kind === 'mention');
  let event: ReturnType<typeof pickDate> = null;
  let eventSentence = '';
  if (eventM) {
    const sent = sentences.find((x) => eventM.index >= x.index && eventM.index < x.index + x.s.length + 1);
    event = sent ? pickDate(datesIn(mentions, sent.index, sent.index + sent.s.length + 1).filter((m) => m.kind !== 'deadline')) : null;
    eventSentence = sent?.s ?? '';
    // "…수업이 있습니다. 오전 10시 30분에 시작하오니…" 처럼 시각이 바로 다음 문장에 오는 경우
    if (event && !event.time && sent) {
      const next = sentences[sentences.indexOf(sent) + 1];
      if (next && !datesIn(mentions, next.index, next.index + next.s.length + 1).some((m) => m.kind !== 'deadline') && /(시작|부터|에\s|출발|모여)/.test(next.s)) {
        const t = findTimes(next.s)[0];
        if (t) event = { ...event, time: t.time };
      }
    }
  }
  const anyMismatch = mentions.some((m) => m.weekdayMismatch);
  const worst = mentions.reduce<DateConfidence>((acc, m) => (CONF_RANK[m.confidence] > CONF_RANK[acc] ? m.confidence : acc), 'exact');
  let dateConfidence: DateConfidence = event ? event.confidence : mentions.length ? worst : 'unknown';
  if (anyMismatch) dateConfidence = 'inferred';

  const where = (item: string) => {
    const idx = clean.indexOf(item);
    return idx >= 0 ? idx : -1;
  };
  const dateFor = (item: string) => {
    const idx = where(item);
    const d = idx >= 0 ? sentDate(idx) : null;
    return d?.date ?? event?.date ?? null;
  };
  const supplyFor = (item: string): 'dropoff' | 'pickup' | 'event' | 'unspecified' => {
    const idx = where(item);
    const s = idx >= 0 ? sentenceOf(clean, idx) : '';
    if (/하원/.test(s) && !/등원/.test(s)) return 'pickup';
    if (/(보내|챙겨|지참|가져|등원)/.test(s)) return 'dropoff';
    return 'unspecified';
  };

  const splitPair = (s: string) => {
    // "물통과 여벌옷" → 물통, 여벌옷 (앞이 두 글자 이상이고 뒤가 숫자로 시작하지 않을 때만: "사과 2개"는 그대로)
    const m = s.match(/^([가-힣A-Za-z0-9 ]{2,}?)(?:과|와|랑|하고)\s+([^\d\s].+)$/);
    return m && (m[1] as string).trim().length >= 2 ? [(m[1] as string).trim(), (m[2] as string).trim()] : [s];
  };
  const seenSupply = new Set<string>();
  const supplies = a.supplies
    .filter((s) => !s.startsWith('준비물 문장 확인'))
    .flatMap((s) => splitPair(s).map((part) => ({ part, src: s })))
    .filter(({ part }) => (seenSupply.has(part) ? false : (seenSupply.add(part), true)))
    .map(({ part, src }) => ({ text: part, date: dateFor(src), for: supplyFor(src) }));
  const clothing: DatedText[] = a.clothing.map((c) => ({ text: c, date: dateFor(c) }));

  const documents: DatedText[] = [];
  const parentTasks: DatedText[] = [];
  for (const { s, index } of sentences) {
    const deadline = datesIn(mentions, index, index + s.length + 1).find((m) => m.kind === 'deadline');
    if (DOC_WORDS.some((w) => s.includes(w)) && /(제출|보내|작성|서명|회신|가져|확인)/.test(s)) {
      documents.push({ text: s.length > 60 ? `${s.slice(0, 59)}…` : s, date: deadline?.date ?? null });
    }
  }
  for (const t of a.parentTasks) {
    const body = t.replace(/^마감 .*? - /, '');
    if (documents.some((d) => d.text.startsWith(body.slice(0, 20)))) continue;
    const idx = where(body.slice(0, 12));
    const dl = idx >= 0 ? datesIn(mentions, idx - 30, idx + body.length).find((m) => m.kind === 'deadline') : undefined;
    parentTasks.push({ text: body.length > 60 ? `${body.slice(0, 59)}…` : body, date: dl?.date ?? null });
  }

  let dropoffChange: Change | null = null;
  let pickupChange: Change | null = null;
  let closure: Change | null = null;
  const unresolved: string[] = [];
  for (const { s, index } of sentences) {
    const d = pickDate(datesIn(mentions, index, index + s.length + 1)) ?? (event ? { ...event } : null);
    const times = findTimes(s);
    if (!closure && CLOSURE.test(s) && !/(않으셔도|안\s*하셔도)/.test(s)) {
      if (d) closure = { date: d.date, endDate: d.endDate, time: null, text: s.slice(0, 80) };
      else unresolved.push(s);
    }
    if (!dropoffChange && /등원/.test(s) && times.length && /(까지|시간|변경|늦|일찍|맞춰)/.test(s)) {
      const t = times.find((x) => s.indexOf('등원') > x.index) ?? times[0];
      if (d && t) dropoffChange = { date: d.date, time: t.time, text: s.slice(0, 80) };
      else unresolved.push(s);
    }
    if (!pickupChange && /하원/.test(s) && times.length) {
      const t = times[times.length - 1];
      if (d && t) pickupChange = { date: d.date, time: t.time, text: s.slice(0, 80), early: EARLY.test(s) };
      else unresolved.push(s);
    }
  }

  const fallbackTitle = a.noticeTypes[0] ?? '어린이집 공지';
  const titleSource = eventSentence || sentences.find((x) => !GREETING.test(x.s) || x.s.replace(GREETING, '').length > 4)?.s || '';
  const needsReply = !a.teacherReply.includes('필요하지 않을');
  const needsConfirmation = [...a.needsConfirmation, ...unresolved.map((s) => `날짜·시각을 확인해 주세요: ${s.slice(0, 50)}`)].slice(0, 6);
  const confidence = Math.max(0, a.confidence - (dateConfidence === 'inferred' ? 15 : 0) - (dateConfidence === 'unknown' && mentions.length ? 10 : 0));

  const digest: NoticeDigest = {
    schema: 1,
    title: shortTitle(titleSource, fallbackTitle),
    summary: a.summary,
    kinds: a.noticeTypes,
    eventDate: event?.date ?? null,
    eventEndDate: event?.endDate ?? null,
    eventTime: event?.time ?? null,
    dateConfidence,
    dates: mentions.slice(0, 12).map(({ index: _i, weekdayMismatch: _w, ...rest }) => rest),
    supplies,
    clothing,
    documents,
    parentTasks,
    fees: a.fees,
    dropoffChange,
    pickupChange,
    closure,
    needsReply,
    replyText: needsReply ? a.teacherReply : '',
    needsConfirmation,
    cautions: a.cautions,
    confidence,
  };
  return { digest, contentHash: contentHash(clean) };
}

/** 공지톡 localStorage 항목을 보드 가져오기 형식으로 바꾼다(원문이 있으면 다시 분석한다). */
export function fromGongjitalk(item: unknown, keepOriginal: boolean): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!item || typeof item !== 'object') return { ok: false, error: '항목 형식이 올바르지 않아요.' };
  const o = item as Record<string, unknown>;
  const text = typeof o.originalText === 'string' ? o.originalText : '';
  const created = typeof o.createdAt === 'string' ? o.createdAt : '';
  const t = Date.parse(created);
  if (!text.trim() || Number.isNaN(t)) return { ok: false, error: '원문이나 분석 날짜가 없어요.' };
  // 받은 날 = 공지톡에서 분석한 날(한국 시간)
  const receivedOn = new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const { digest, contentHash } = buildDigest(text, receivedOn);
  return {
    ok: true,
    body: { source: 'gongjitalk', sourceId: typeof o.id === 'string' ? o.id.slice(0, 80) : undefined, receivedOn, contentHash, digest, ...(keepOriginal ? { originalText: text, storeOriginal: true } : {}) },
  };
}

import { describe, expect, it } from 'vitest';
import cases from './analyzer-cases.json';
import { analyzeNotice } from '../src/notices/analyzer';
import { addDaysIso, extractDates, parseTime } from '../src/notices/dates';
import { buildDigest, fromGongjitalk } from '../src/notices/digest';
import { contentHash, sha256Hex } from '../src/notices/sha256';

type Case = { id: string; text: string; expect: Record<string, unknown> };

describe('공지톡 분석기 회귀 (gongjitalk data/analyzer-cases.json)', () => {
  for (const c of cases as Case[]) {
    it(c.id, () => {
      const r = analyzeNotice(c.text) as unknown as Record<string, unknown>;
      const res = { ...r, checklist: (r.checklistItems as Array<{ text: string }>).map((x) => x.text) } as Record<string, unknown>;
      const flat = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
      for (const [field, want] of Object.entries(c.expect)) {
        if (field === 'minConfidence') {
          expect(r.confidence as number).toBeGreaterThanOrEqual(want as number);
          continue;
        }
        const target = field === 'notSupplies' ? 'supplies' : field === 'notChecklist' ? 'checklist' : field;
        const values = flat(res[target]);
        for (const w of want as string[]) {
          const has = values.some((v) => v.includes(w));
          expect(has, `${field} ${w}`).toBe(field !== 'notSupplies' && field !== 'notChecklist');
        }
      }
    });
  }
});

describe('SHA-256', () => {
  it('표준 벡터와 서버(파이썬) 결과가 같다', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(contentHash('  내일 숲 체험\n\n물통  ')).toBe('0d4faccf4932b8ac35ba2dc4692c58401916a0b52167f26a01e95144a4f2fda3');
    expect(sha256Hex('a'.repeat(1000))).toHaveLength(64);
  });
});

describe('날짜 정규화 (받은 날 2026-11-20 금요일 기준)', () => {
  const R = '2026-11-20';
  const one = (t: string) => extractDates(t, R)[0];
  it('상대 날짜', () => {
    expect(one('오늘 산책')?.date).toBe('2026-11-20');
    expect(one('내일 소풍')?.date).toBe('2026-11-21');
    expect(one('모레 행사')?.date).toBe('2026-11-22');
    expect(one('이번 주 금요일 발표회')).toMatchObject({ date: '2026-11-20', confidence: 'relative', kind: 'event' });
    expect(one('다음 주 월요일부터 수영 수업')).toMatchObject({ date: '2026-11-23', confidence: 'relative' });
    expect(one('다음주 수요일')?.date).toBe('2026-11-25');
  });
  it('절대 날짜와 연도 추정', () => {
    expect(one('11월 23일 체험')).toMatchObject({ date: '2026-11-23', confidence: 'exact' });
    expect(one('2026년 11월 23일')?.date).toBe('2026-11-23');
    expect(one('2026.12.01 마감')?.date).toBe('2026-12-01');
    expect(one('1월 5일 개학')?.date).toBe('2027-01-05'); // 지난 날짜가 아니라 내년
    expect(one('11/24(화) 견학')).toMatchObject({ date: '2026-11-24', confidence: 'exact' });
    expect(extractDates('물 1/2 컵', R)).toEqual([]);
  });
  it('요일이 틀리면 추정으로 낮춘다', () => {
    expect(one('11월 23일(금) 행사')).toMatchObject({ date: '2026-11-23', confidence: 'inferred', weekdayMismatch: true });
    expect(one('11월 23일(월) 행사')).toMatchObject({ confidence: 'exact' });
  });
  it('요일만 있으면 다가오는 날짜로 추정', () => {
    expect(one('수요일에 소풍')).toMatchObject({ date: '2026-11-25', confidence: 'inferred' });
  });
  it('기간과 마감', () => {
    expect(one('11월 23일~25일 방학')).toMatchObject({ date: '2026-11-23', endDate: '2026-11-25' });
    expect(one('11월 23일부터 11월 27일까지')).toMatchObject({ date: '2026-11-23', endDate: '2026-11-27' });
    expect(one('11월 25일까지 동의서 제출')).toMatchObject({ kind: 'deadline' });
    expect(one('내일까지 문자로 알려주세요')).toMatchObject({ kind: 'deadline', date: '2026-11-21' });
  });
  it('시각', () => {
    expect(parseTime('오전 10시 30분')).toBe('10:30');
    expect(parseTime('오후 3시')).toBe('15:00');
    expect(parseTime('3시 반')).toBe('15:30');
    expect(parseTime('9시 50분')).toBe('09:50');
    expect(parseTime('13:00')).toBe('13:00');
    expect(one('내일 오전 9시 50분까지 등원')?.time).toBe('09:50');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('공지 요약(NoticeDigest)', () => {
  it('숲 체험: 내일 날짜, 준비물·복장', () => {
    const { digest } = buildDigest('내일 숲 체험이 있습니다. 활동하기 편한 복장과 운동화를 착용해 주세요. 개인 물통을 보내주시고, 우천 시 실내 활동으로 대체됩니다. 도시락은 필요 없으며 급식으로 진행됩니다.', '2026-11-20');
    expect(digest.eventDate).toBe('2026-11-21');
    expect(digest.dateConfidence).toBe('relative');
    expect(digest.title).toBe('숲 체험');
    expect(digest.supplies.map((s) => s.text)).toContain('물통');
    expect(digest.supplies.every((s) => s.date === '2026-11-21')).toBe(true);
    expect(digest.supplies.map((s) => s.text)).not.toContain('도시락');
    expect(digest.needsReply).toBe(false);
    expect(digest.needsConfirmation.join()).toContain('우천 시');
  });
  it('참관 수업: 날짜 두 표현이 같으면 정확, 회신 필요', () => {
    const { digest } = buildDigest('이번 주 금요일(11월 20일)에 학부모 참관 수업이 있습니다. 오전 10시 30분에 시작하오니 참석 가능하신 분은 내일까지 선생님께 문자로 알려주세요.', '2026-11-18');
    expect(digest.eventDate).toBe('2026-11-20');
    expect(digest.dateConfidence).toBe('exact');
    expect(digest.eventTime).toBe('10:30');
    expect(digest.needsReply).toBe(true);
    expect(digest.dates.some((d) => d.kind === 'deadline' && d.date === '2026-11-19')).toBe(true);
  });
  it('날짜 두 표현이 다르면 확인 필요(추정)', () => {
    const { digest } = buildDigest('이번 주 금요일(11월 27일)에 발표회가 있습니다.', '2026-11-18');
    expect(digest.dateConfidence).toBe('inferred');
  });
  it('등원 시간 변경', () => {
    const { digest } = buildDigest('내일은 생일 축하와 숲 산책 활동이 예정되어 있습니다. 원활한 활동을 위해 오전 9시 50분까지 등원할 수 있도록 협조 부탁드립니다.', '2026-11-20');
    expect(digest.dropoffChange).toMatchObject({ date: '2026-11-21', time: '09:50' });
  });
  it('조기 하원과 휴원', () => {
    const a = buildDigest('11월 24일(화)은 교사 연수로 오후 1시에 조기 하원합니다.', '2026-11-20').digest;
    expect(a.pickupChange).toMatchObject({ date: '2026-11-24', time: '13:00', early: true });
    const b = buildDigest('12월 24일~26일은 겨울 방학으로 휴원합니다.', '2026-11-20').digest;
    expect(b.closure).toMatchObject({ date: '2026-12-24', endDate: '2026-12-26' });
  });
  it('서류 제출 기한', () => {
    const { digest } = buildDigest('사진 촬영 동의서를 11월 25일까지 제출해 주세요.', '2026-11-20');
    expect(digest.documents[0]).toMatchObject({ date: '2026-11-25' });
  });
  it('날짜를 정할 수 없는 시간 변경은 확인 필요 문구로 남긴다', () => {
    const { digest } = buildDigest('하원 시간이 오후 3시로 바뀝니다.', '2026-11-20');
    expect(digest.pickupChange).toBeNull();
    expect(digest.needsConfirmation.join()).toContain('날짜·시각을 확인');
  });
  it('공지톡 항목 가져오기는 분석한 날을 받은 날로 쓴다', () => {
    const r = fromGongjitalk({ id: 'notice-1', createdAt: '2026-11-19T23:30:00.000Z', originalText: '내일 소풍 물통' }, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.receivedOn).toBe('2026-11-20'); // 한국 시간 11/20 08:30
      expect((r.body.digest as { eventDate: string }).eventDate).toBe('2026-11-21');
      expect(r.body.originalText).toBeUndefined();
    }
    expect(fromGongjitalk({ id: 'x' }, false).ok).toBe(false);
  });
});

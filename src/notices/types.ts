// 공지 분석 타입. 앞부분은 공지톡(gongjitalk lib/types.ts)과 같은 모양이다(가져오기 호환).

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  category: 'supplies' | 'clothing' | 'task' | 'reply' | 'payment' | 'other';
}

/** 공지톡 localStorage 'gongjitalk_notices' 항목 모양 */
export interface NoticeAnalysis {
  id: string;
  createdAt: string;
  originalText: string;
  summary: string;
  noticeTypes: string[];
  dateTime: string[];
  deadlines: string[];
  locations: string[];
  supplies: string[];
  clothing: string[];
  fees: string[];
  parentTasks: string[];
  cautions: string[];
  childMessage: string;
  teacherReply: string;
  needsConfirmation: string[];
  confidence: number;
  checklistItems: ChecklistItem[];
}

export type DateConfidence = 'exact' | 'relative' | 'inferred' | 'unknown';

export interface DateMention {
  date: string; // YYYY-MM-DD
  endDate: string | null;
  time: string | null; // HH:MM
  text: string;
  kind: 'event' | 'deadline' | 'mention';
  confidence: Exclude<DateConfidence, 'unknown'>;
  /** 원문에서의 위치(문장 매칭용) */
  index: number;
  /** 적힌 요일과 실제 요일이 다름 */
  weekdayMismatch?: boolean;
}

export interface DatedText {
  text: string;
  date: string | null;
}

export interface Change {
  date: string;
  endDate?: string | null;
  time: string | null;
  text: string;
  early?: boolean;
}

/** 서버(tablet_server/board_store.clean_digest)와 맞춘 공지 요약 v1 */
export interface NoticeDigest {
  schema?: 1;
  title: string;
  summary: string;
  kinds: string[];
  eventDate: string | null;
  eventEndDate: string | null;
  eventTime: string | null;
  dateConfidence: DateConfidence;
  dates: Array<Omit<DateMention, 'index' | 'weekdayMismatch'>>;
  supplies: Array<DatedText & { for: 'dropoff' | 'pickup' | 'event' | 'unspecified' }>;
  clothing: DatedText[];
  documents: DatedText[];
  parentTasks: DatedText[];
  fees: string[];
  dropoffChange: Change | null;
  pickupChange: Change | null;
  closure: Change | null;
  needsReply: boolean;
  replyText: string;
  needsConfirmation: string[];
  cautions: string[];
  confidence: number;
}

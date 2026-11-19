import { useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { friendlyMessage } from '../domain/errors';
import { isValidDate, todayIn } from '../domain/dates';
import { DEFAULT_TIMEZONE } from '../domain/types';
import { validateChildName, validateFamilyName, validatePin, validateText } from '../domain/validation';
import { newId } from '../lib/crypto';
import { AVATAR_OPTIONS, avatarNameOf, avatarOf, LoadingBlock } from '../ui/States';
import { useAppCtx, useOnline, usePageTitle, useServices } from '../app/context';

type StepKey = 'family' | 'pin' | 'child' | 'task' | 'event';

/** F-01: 서버 로그인 → 가족 생성 → 첫 아이/일정/할 일(선택) → 홈. 재시도해도 같은 idempotency key로 중복 생성하지 않는다. */
export function SetupPage() {
  usePageTitle('가족 만들기');
  const { repo, queryClient } = useServices();
  const navigate = useNavigate();
  const online = useOnline();
  const ctx = useAppCtx();
  const [familyName, setFamilyName] = useState('');
  const [pin, setPin] = useState('');
  const [childName, setChildName] = useState('');
  const [avatar, setAvatar] = useState('monggeul');
  const [taskTitle, setTaskTitle] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // 단계별 key와 완료 표시: 실패 후 재시도해도 같은 key를 쓰고 끝난 단계는 건너뛴다
  const keys = useRef({ family: newId(), child: newId(), task: newId(), event: newId() });
  const done = useRef(new Set<StepKey>());

  if (ctx.isPending) return <div className="center"><LoadingBlock label="확인하는 중이에요…" /></div>;
  if (!ctx.data || ctx.data.kind === 'anonymous') return <Navigate to="/login" replace state={{ next: '/setup' }} />;
  if (ctx.data.kind === 'device') return <Navigate to="/kids" replace />;
  if (ctx.data.family) return <Navigate to="/" replace />;

  async function finish() {
    await queryClient.invalidateQueries({ queryKey: ['ctx'] });
    navigate('/', { replace: true });
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const errs: Record<string, string> = {};
    const check = (field: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        errs[field] = friendlyMessage(err);
      }
    };
    check('familyName', () => validateFamilyName(familyName));
    if (pin) check('pin', () => validatePin(pin));
    if (childName.trim()) check('childName', () => validateChildName(childName));
    if (taskTitle.trim()) check('taskTitle', () => validateText(taskTitle, 1, 120, '제목', 'taskTitle'));
    if (eventTitle.trim()) {
      check('eventTitle', () => validateText(eventTitle, 1, 120, '제목', 'eventTitle'));
      if (!isValidDate(eventDate)) errs.eventDate = '일정 날짜를 선택해 주세요.';
    }
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length > 0) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (!done.current.has('family')) {
        await repo.createFamily(familyName, keys.current.family);
        done.current.add('family');
      }
      if (pin && !done.current.has('pin')) {
        await repo.setParentPin(pin);
        done.current.add('pin');
      }
      if (childName.trim() && !done.current.has('child')) {
        await repo.addChild({ displayName: childName, avatarKey: avatar }, keys.current.child);
        done.current.add('child');
      }
      if (taskTitle.trim() && !done.current.has('task')) {
        await repo.createTask({ kind: 'todo', title: taskTitle }, keys.current.task);
        done.current.add('task');
      }
      if (eventTitle.trim() && !done.current.has('event')) {
        await repo.createEvent({ title: eventTitle, allDay: true, startDate: eventDate, endDate: eventDate, visibility: 'family' }, keys.current.event);
        done.current.add('event');
      }
      await finish();
    } catch (err) {
      // 가족이 이미 만들어졌다면 안내만 하고, 다시 누르면 남은 단계만 이어서 진행한다
      setFormError(
        done.current.has('family')
          ? `가족은 만들어졌지만 일부 항목을 저장하지 못했어요. ${friendlyMessage(err)} 다시 누르면 남은 항목만 이어서 저장해요.`
          : friendlyMessage(err),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const err = (k: string) => errors[k];
  const props = (k: string) => ({ 'aria-invalid': err(k) ? (true as const) : undefined, 'aria-describedby': err(k) ? `${k}-err` : undefined });

  return (
    <div className="center">
      <main className="card auth-card stack" id="main" style={{ width: 'min(620px, 100%)' }}>
        <h1>가족을 만들어 볼까요?</h1>
        <p className="muted">필수는 가족 이름뿐이에요. 나머지는 나중에 해도 돼요.</p>
        <form onSubmit={create} noValidate aria-label="가족 만들기">
          <div className="field">
            <label htmlFor="family-name">가족 이름 (필수)</label>
            <input id="family-name" type="text" maxLength={40} value={familyName} onChange={(e) => setFamilyName(e.target.value)} {...props('familyName')} />
            {err('familyName') && <span id="familyName-err" className="err">{err('familyName')}</span>}
          </div>
          <div className="field">
            <label htmlFor="parent-pin">부모 PIN 4~6자리 숫자 (선택)</label>
            <input id="parent-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} {...props('pin')} />
            <span className="hint">아이 모드 설정·종료에 써요. 나중에 설정에서 만들 수도 있어요.</span>
            {err('pin') && <span id="pin-err" className="err">{err('pin')}</span>}
          </div>
          <fieldset>
            <legend>첫 아이 (선택)</legend>
            <div className="field">
              <label htmlFor="child-name">아이 별칭</label>
              <input id="child-name" type="text" maxLength={20} value={childName} onChange={(e) => setChildName(e.target.value)} {...props('childName')} />
              <span className="hint">실명 대신 별칭을 권장해요.</span>
              {err('childName') && <span id="childName-err" className="err">{err('childName')}</span>}
            </div>
            <div className="field">
              <label htmlFor="child-avatar">아바타</label>
              <div className="avatar-select-row">
                <span className="avatar avatar-preview" role="img" aria-label={`${avatarNameOf(avatar)} 캐릭터 미리보기`}>
                  {avatarOf(avatar)}
                </span>
                <select id="child-avatar" value={avatar} onChange={(e) => setAvatar(e.target.value)}>
                  {AVATAR_OPTIONS.map(({ key, marker, label }) => (
                    <option key={key} value={key}>
                      {marker} {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="first-task">첫 할 일 (선택)</label>
            <input id="first-task" type="text" maxLength={120} value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} {...props('taskTitle')} />
            {err('taskTitle') && <span id="taskTitle-err" className="err">{err('taskTitle')}</span>}
          </div>
          <fieldset>
            <legend>첫 일정 (선택)</legend>
            <div className="row2">
              <div className="field">
                <label htmlFor="first-event">제목</label>
                <input id="first-event" type="text" maxLength={120} value={eventTitle} onChange={(e) => setEventTitle(e.target.value)} {...props('eventTitle')} />
                {err('eventTitle') && <span id="eventTitle-err" className="err">{err('eventTitle')}</span>}
              </div>
              <div className="field">
                <label htmlFor="first-event-date">날짜</label>
                <input id="first-event-date" type="date" value={eventDate} min={todayIn(DEFAULT_TIMEZONE)} onChange={(e) => setEventDate(e.target.value)} {...props('eventDate')} />
                {err('eventDate') && <span id="eventDate-err" className="err">{err('eventDate')}</span>}
              </div>
            </div>
          </fieldset>
          {formError && (
            <p className="err" role="alert" style={{ color: 'var(--bad)', fontWeight: 600 }}>
              {formError}
            </p>
          )}
          <div className="btn-row">
            <button type="submit" className="btn" disabled={busy || !online}>
              {busy ? '만드는 중…' : online ? '가족 만들기' : '오프라인이에요'}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

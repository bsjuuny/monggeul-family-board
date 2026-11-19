import { useRef, useState, type FormEvent } from 'react';
import { friendlyMessage, isFamilyBoardError } from '../domain/errors';
import { validatePin } from '../domain/validation';
import { useServices } from '../app/context';
import { Modal } from './Modal';

interface Props {
  title?: string;
  /** owner면 PIN이 아직 없을 때 새로 만들 수 있다 */
  canCreate?: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}

/** 부모 PIN 재확인. PIN은 state에만 잠시 두고 저장하지 않는다. */
export function PinDialog({ title = '부모 PIN 확인', canCreate = false, onClose, onUnlocked }: Props) {
  const { repo } = useServices();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [mode, setMode] = useState<'verify' | 'create'>('verify');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setError(null);
    try {
      validatePin(pin);
      if (mode === 'create' && pin !== pin2) {
        setError('두 PIN이 달라요. 다시 확인해 주세요.');
        return;
      }
    } catch (err) {
      setError(friendlyMessage(err));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      if (mode === 'create') await repo.setParentPin(pin);
      await repo.verifyParentPin(pin);
      onUnlocked();
    } catch (err) {
      if (isFamilyBoardError(err) && err.code === 'NOT_FOUND' && err.details.reason === 'NO_PIN') {
        if (canCreate) {
          setMode('create');
          setError('아직 부모 PIN이 없어요. 4~6자리 숫자로 새로 만들어 주세요.');
        } else {
          setError('부모 PIN이 아직 설정되지 않았어요. 가족 owner가 먼저 설정해야 해요.');
        }
      } else if (isFamilyBoardError(err) && err.code === 'FORBIDDEN' && typeof err.details.remaining === 'number') {
        setError(`PIN이 맞지 않아요. ${err.details.remaining}번 더 시도할 수 있어요.`);
      } else {
        setError(friendlyMessage(err));
      }
      setPin('');
      setPin2('');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={mode === 'create' ? '부모 PIN 만들기' : title} onClose={onClose} busy={busy}>
      <form onSubmit={submit} noValidate>
        <p className="muted">{mode === 'create' ? '아이 모드 설정과 종료에 쓰는 가족 공용 숫자예요.' : '설정을 바꾸려면 부모 PIN(4~6자리 숫자)을 입력해 주세요.'}</p>
        <div className="field">
          <label htmlFor="pin-input">{mode === 'create' ? '새 PIN' : 'PIN'}</label>
          <input
            id="pin-input"
            data-autofocus
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'pin-error' : undefined}
          />
        </div>
        {mode === 'create' && (
          <div className="field">
            <label htmlFor="pin2-input">새 PIN 한 번 더</label>
            <input id="pin2-input" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
          </div>
        )}
        {error && (
          <p id="pin-error" className="err" role="alert" style={{ color: 'var(--bad)', fontWeight: 600 }}>
            {error}
          </p>
        )}
        <div className="btn-row">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? '확인 중…' : mode === 'create' ? 'PIN 만들기' : '확인'}
          </button>
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
        </div>
      </form>
    </Modal>
  );
}

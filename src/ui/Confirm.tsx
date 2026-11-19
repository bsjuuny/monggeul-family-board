import { Modal } from './Modal';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** 위험 행동 확인 */
export function ConfirmDialog({ title, message, confirmLabel = '확인', danger, busy, onConfirm, onClose }: Props) {
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <p>{message}</p>
      <div className="btn-row">
        <button type="button" className={`btn ${danger ? 'danger' : ''}`} onClick={onConfirm} disabled={busy} data-autofocus>
          {busy ? '처리 중…' : confirmLabel}
        </button>
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
          취소
        </button>
      </div>
    </Modal>
  );
}

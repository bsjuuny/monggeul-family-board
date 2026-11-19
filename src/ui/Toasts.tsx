import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
interface ToastApi {
  info(text: string): void;
  error(text: string): void;
}
const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: Toast['kind']) => {
    const id = ++seq.current;
    setList((l) => [...l.slice(-3), { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);
  const api = useMemo<ToastApi>(() => ({ info: (t) => push(t, 'info'), error: (t) => push(t, 'error') }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`} role={t.kind === 'error' ? 'alert' : undefined}>
            {t.kind === 'error' ? '⚠️ ' : ''}
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider가 없어요.');
  return c;
}

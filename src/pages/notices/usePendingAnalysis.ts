// 서버에 node 가 없어 '분석 대기'로 저장된 공지를 보호자 브라우저가 대신 분석해 채운다.
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useServices } from '../../app/context';
import { buildDigest } from '../../notices/digest';

export function usePendingAnalysis(trigger: boolean) {
  const { v2 } = useServices();
  const qc = useQueryClient();
  const running = useRef(false);
  useEffect(() => {
    if (!trigger || running.current) return;
    running.current = true;
    void (async () => {
      try {
        const { items } = await v2.pendingAnalysis();
        for (const it of items) {
          const { digest } = buildDigest(it.text, it.receivedOn);
          await v2.saveAnalysis(it.id, digest).catch(() => undefined);
        }
        if (items.length) await qc.invalidateQueries({ queryKey: ['board'] });
        if (items.length) await qc.invalidateQueries({ queryKey: ['notices'] });
      } catch {
        /* 다음 기회에 다시 */
      } finally {
        running.current = false;
      }
    })();
  }, [trigger, v2, qc]);
}

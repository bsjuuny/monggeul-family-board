import { Link } from 'react-router-dom';
import { usePageTitle } from '../app/context';
import { EmptyBlock } from '../ui/States';

/** P1 자리표시자: 설명만 보여 주고 저장·입력 동작은 만들지 않는다 (명세 §4) */
export function PlaceholderPage({ icon, title, body }: { icon: string; title: string; body: string }) {
  usePageTitle(`${title} (준비 중)`);
  return (
    <div className="stack" data-testid="placeholder-page">
      <h1>{title}</h1>
      <EmptyBlock icon={icon} title="준비 중이에요">
        <p>{body}</p>
        <p className="muted">다음 단계(P1)에서 만나요. 지금은 저장하거나 입력할 수 있는 기능이 없어요.</p>
        <Link className="btn secondary" to="/">
          홈으로
        </Link>
      </EmptyBlock>
    </div>
  );
}

export function NotFoundPage() {
  usePageTitle('페이지를 찾을 수 없어요');
  return (
    <div className="stack" data-testid="not-found">
      <h1>페이지를 찾을 수 없어요</h1>
      <EmptyBlock icon="🧭" title="404" hint="주소가 바뀌었거나 없는 페이지예요.">
        <Link className="btn" to="/">
          홈으로 돌아가기
        </Link>
      </EmptyBlock>
    </div>
  );
}

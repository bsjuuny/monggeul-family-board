import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createServices } from './app/services';
import './styles.css';

const services = createServices();

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾을 수 없어요.');
createRoot(container).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);

// 서비스 워커는 배포(프로덕션) 빌드에서만 등록한다. 실패해도 앱 동작에는 영향이 없다.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}

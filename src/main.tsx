import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createServices } from './app/services';
import '@fontsource/jua/400.css';
import '@fontsource/noto-sans-kr/400.css';
import '@fontsource/noto-sans-kr/500.css';
import '@fontsource/noto-sans-kr/700.css';
import './styles.css';
import { registerServiceWorker } from './app/swUpdate';

const services = createServices();

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾을 수 없어요.');
createRoot(container).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);

// 서비스 워커는 배포(프로덕션) 빌드에서만 등록한다. 실패해도 앱 동작에는 영향이 없다.
if (import.meta.env.PROD) window.addEventListener('load', registerServiceWorker);

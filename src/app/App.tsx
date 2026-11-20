import { useMemo } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createHashRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { ToastProvider } from '../ui/Toasts';
import { FullscreenKeeper } from '../ui/Fullscreen';
import { LoginPage } from '../pages/Auth';
import { CalendarPage } from '../pages/Calendar';
import { BoardHomePage, DisplayPage } from '../pages/Board';
import { NoticeDetailPage, NoticeImportPage, NoticeNewPage, NoticesPage } from '../pages/notices/NoticePages';
import { PrepPage } from '../pages/Prep';
import '../pages/v2pages.css';
import { HomePage } from '../pages/Home';
import { KidDetailPage, KidsPage } from '../pages/Kids';
import { NotFoundPage, PlaceholderPage } from '../pages/Placeholders';
import { SettingsPage } from '../pages/Settings';
import { SetupPage } from '../pages/Setup';
import { TasksPage } from '../pages/Tasks';
import { ServicesContext } from './context';
import type { Services } from './services';
import { AppGate } from './Shell';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/setup', element: <SetupPage /> },
  { path: '/display', element: <DisplayPage /> },
  {
    element: <AppGate />,
    children: [
      { path: '/', element: <BoardHomePage /> },
      { path: '/overview', element: <HomePage /> },
      { path: '/notices', element: <NoticesPage /> },
      { path: '/notices/new', element: <NoticeNewPage /> },
      { path: '/notices/import', element: <NoticeImportPage /> },
      { path: '/notices/:id', element: <NoticeDetailPage /> },
      { path: '/prep', element: <PrepPage /> },
      { path: '/calendar', element: <CalendarPage /> },
      { path: '/tasks', element: <TasksPage /> },
      { path: '/kids', element: <KidsPage /> },
      { path: '/kids/:id', element: <KidDetailPage /> },
      { path: '/settings', element: <SettingsPage /> },
      {
        path: '/memories',
        element: <PlaceholderPage icon="📸" title="추억 앨범" body="가족 사진과 추억 슬라이드를 모아 보는 기능이에요." />,
      },
      {
        path: '/play',
        element: <PlaceholderPage icon="🎲" title="놀이터" body="가족이 함께 즐기는 보드게임과 미션 기능이에요." />,
      },
      {
        path: '/family',
        element: <PlaceholderPage icon="💌" title="가족 소통" body="가족 메시지와 식단 공유 기능이에요." />,
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

/** 테스트에서 MemoryRouter 대신 쓸 수 있도록 라우터 생성을 분리 */
export function createAppRouter() {
  return createHashRouter(routes);
}

export function App({ services }: { services: Services }) {
  const router = useMemo(() => createAppRouter(), []);
  return (
    <ServicesContext.Provider value={services}>
      <QueryClientProvider client={services.queryClient}>
        <ToastProvider>
          <FullscreenKeeper />
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </ServicesContext.Provider>
  );
}

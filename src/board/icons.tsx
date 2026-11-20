// 선 아이콘(디자인 명세 6장): 24×24, stroke=currentColor, 둥근 끝. 이모지 대신 쓴다.
import type { SVGProps } from 'react';

const PATHS: Record<string, string> = {
  sun: 'M12 7.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4',
  cloud: 'M7 18.5h10a4 4 0 0 0 .6-8a5.5 5.5 0 0 0-10.6 1.2A3.4 3.4 0 0 0 7 18.5z',
  cloudSun: 'M8.5 5.2a3.5 3.5 0 0 1 5.7 1.6M5 8.5a3.5 3.5 0 0 1 1-1M8 19h9a3.6 3.6 0 0 0 .5-7.2a5 5 0 0 0-9.6 1.1A3.1 3.1 0 0 0 8 19z',
  rain: 'M7 14.5h10a3.8 3.8 0 0 0 .5-7.6A5.2 5.2 0 0 0 7.5 8A3.3 3.3 0 0 0 7 14.5zM8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5',
  snow: 'M7 14h10a3.8 3.8 0 0 0 .5-7.6A5.2 5.2 0 0 0 7.5 7.5A3.3 3.3 0 0 0 7 14zM8 18h.01M12 19.5h.01M16 18h.01M10 21h.01M14 21.5h.01',
  umbrella: 'M3 12a9 9 0 0 1 18 0zM12 12v6.5a2 2 0 0 1-4 0M12 3v.5',
  noUmbrella: 'M3 12a9 9 0 0 1 18 0zM12 12v6.5a2 2 0 0 1-4 0M4 20L20 4',
  coat: 'M9 3.5L12 6l3-2.5l4 2v6.5h-2.5V21h-9V12H5V5.5zM12 6v15',
  jacket: 'M8.5 4L12 6.5L15.5 4l3.5 2l-1.2 5H16v9H8v-9H6.2L5 6zM12 6.5V20',
  tshirt: 'M8.5 4h7l4 3l-2.2 3L15.5 9v11h-7V9L6.7 10L4.5 7z',
  wind: 'M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h8',
  thermo: 'M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0zM12 9v7',
  bell: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  chat: 'M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5z',
  alert: 'M12 4l9 16H3zM12 10v4.5M12 17.5h.01',
  bag: 'M6 8h12l-1 12H7zM9 8V6.5a3 3 0 0 1 6 0V8',
  school: 'M3 21h18M5 21V10l7-5l7 5v11M10 21v-5h4v5M12 9.5h.01',
  home: 'M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5',
  person: 'M12 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7zM5 20.5a7 7 0 0 1 14 0',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  wifiOff: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 4.2-2.4M19 13a10 10 0 0 0-3-2M2 9.5a15 15 0 0 1 4-2.6M22 9.5A15 15 0 0 0 11 5.6M12 20h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  calendar: 'M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4',
  doc: 'M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M9.5 12h5M9.5 15.5h5',
  clock: 'M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM12 7.5V12l3 2',
  path: 'M5 19c3 0 3-4 7-4s4-4 7-4M5 19h.01M19 11h.01',
  car: 'M5 16.5V12l1.8-4.5h10.4L19 12v4.5zM5 12h14M7.5 16.5v2M16.5 16.5v2M8 14h.01M16 14h.01',
  close: 'M6 6l12 12M18 6L6 18',
  tv: 'M3.5 5.5h17v11h-17zM9 20h6M12 16.5V20',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, strokeWidth, title, ...rest }: { name: IconName; size?: number; strokeWidth?: number; title?: string } & SVGProps<SVGSVGElement>) {
  const sw = strokeWidth ?? (size >= 32 ? 2 : size <= 16 ? 2.5 : 2.25);
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title} focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function weatherIcon(condition: string | null | undefined, pty?: string | null): IconName {
  if (pty && pty !== 'none') return /snow/.test(pty) ? 'snow' : 'rain';
  if (!condition) return 'cloud';
  if (/(눈)/.test(condition)) return 'snow';
  if (/(비|소나기)/.test(condition)) return 'rain';
  if (condition === '맑음') return 'sun';
  if (condition === '구름 많음') return 'cloudSun';
  return 'cloud';
}

export function adviceIcon(code: string): IconName {
  return ({ heavy_coat: 'coat', jacket: 'jacket', light_jacket: 'jacket', light: 'tshirt', umbrella: 'umbrella', small_umbrella: 'umbrella',
    no_umbrella: 'noUmbrella', snow: 'snow', wind: 'wind', cold_alert: 'thermo', heat: 'thermo' } as Record<string, IconName>)[code] ?? 'sun';
}

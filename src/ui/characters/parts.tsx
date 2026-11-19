import { useId, type ReactNode } from 'react';
import type { CharacterMood } from './types';

// "말랑 스티커" 그림체 공통 부품 (viewBox 0 0 200 200 기준)

const INK = '#3a2e38';

/** 같은 화면에 캐릭터가 여러 개 있어도 gradient/filter id 가 겹치지 않도록 */
export function useCharacterIds() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return { shadow: `mgc-sh-${id}`, body: `mgc-body-${id}`, accent: `mgc-acc-${id}` };
}

type Ids = ReturnType<typeof useCharacterIds>;

export function Defs({ ids, body, accent }: { ids: Ids; body: [string, string]; accent?: [string, string] }) {
  return (
    <defs>
      <filter id={ids.shadow} x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#8a5a6a" floodOpacity=".18" />
      </filter>
      <radialGradient id={ids.body} cx="35%" cy="30%" r="80%">
        <stop offset="0" stopColor={body[0]} />
        <stop offset="1" stopColor={body[1]} />
      </radialGradient>
      {accent && (
        <radialGradient id={ids.accent} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor={accent[0]} />
          <stop offset="1" stopColor={accent[1]} />
        </radialGradient>
      )}
    </defs>
  );
}

/** 실루엣 뒤에 흰 스티커 테두리 + 그림자를 깐다. children 은 fill 없는 도형들 */
export function StickerBorder({ ids, children }: { ids: Ids; children: ReactNode }) {
  return (
    <g filter={`url(#${ids.shadow})`}>
      <g fill="#fff" stroke="#fff" strokeWidth="14" strokeLinejoin="round">
        {children}
      </g>
    </g>
  );
}

/** 몸통 위 왼쪽 위 광택 */
export function Shine({ x, y, rx = 15, ry = 8, opacity = 0.85 }: { x: number; y: number; rx?: number; ry?: number; opacity?: number }) {
  return <ellipse cx={x} cy={y} rx={rx} ry={ry} fill="#fff" opacity={opacity} transform={`rotate(-20 ${x} ${y})`} />;
}

export function Eyes({ mood, y, gap = 22 }: { mood: CharacterMood; y: number; gap?: number }) {
  const xs = [100 - gap, 100 + gap];
  if (mood === 'cheer') {
    return (
      <g fill="none" stroke={INK} strokeWidth="5" strokeLinecap="round">
        {xs.map((x) => (
          <path key={x} d={`M${x - 9} ${y + 3}q9-13 18 0`} />
        ))}
      </g>
    );
  }
  if (mood === 'sleepy') {
    return (
      <g fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round">
        {xs.map((x) => (
          <path key={x} d={`M${x - 9} ${y - 1}q9 9 18 0`} />
        ))}
      </g>
    );
  }
  return (
    <g>
      {xs.map((x) => (
        <g key={x}>
          <ellipse cx={x} cy={y} rx="9" ry="11" fill={INK} />
          <circle cx={x + 3} cy={y - 4} r="3.6" fill="#fff" />
          <circle cx={x - 3} cy={y + 4} r="1.6" fill="#fff" />
        </g>
      ))}
    </g>
  );
}

export function Cheeks({ y, gap = 36, color = '#ff9fb5', opacity = 0.55 }: { y: number; gap?: number; color?: string; opacity?: number }) {
  return (
    <g fill={color} opacity={opacity}>
      <ellipse cx={100 - gap} cy={y} rx="11" ry="7" />
      <ellipse cx={100 + gap} cy={y} rx="11" ry="7" />
    </g>
  );
}

/**
 * 입. style:
 *  - 'w'    : 고양이·구름처럼 ω 모양
 *  - 'nose' : 코 아래 ㅅ 모양 (토끼·곰)
 *  - 'open' : 활짝 웃는 입 (공룡)
 */
export function Mouth({ mood, y, style }: { mood: CharacterMood; y: number; style: 'w' | 'nose' | 'open' }) {
  if (mood === 'cheer') {
    return <path d={`M89 ${y - 2}q11 16 22 0z`} fill="#ff8d9e" stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />;
  }
  if (mood === 'sleepy') {
    return <ellipse cx="100" cy={y + 1} rx="3.5" ry="4" fill={INK} opacity=".85" />;
  }
  const common = { fill: 'none', stroke: INK, strokeWidth: 3.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  if (style === 'open') return <path d={`M87 ${y - 2}q13 14 26 0`} {...common} fill="#ff8c8c" />;
  if (style === 'nose') return <path d={`M100 ${y - 4}v4q-5 5-9 1M100 ${y}q5 5 9 1`} {...common} strokeWidth={3} />;
  return <path d={`M90 ${y}q5 6 10 0q5 6 10 0`} {...common} />;
}

/** 기분에 따른 장식: 신남=반짝이, 졸림=zZ */
export function MoodBits({ mood }: { mood: CharacterMood }) {
  if (mood === 'cheer') {
    const star = (x: number, y: number, s: number, c: string) => (
      <path
        key={`${x}-${y}`}
        d={`M${x} ${y - s}Q${x + s * 0.18} ${y - s * 0.18} ${x + s} ${y}Q${x + s * 0.18} ${y + s * 0.18} ${x} ${y + s}Q${x - s * 0.18} ${y + s * 0.18} ${x - s} ${y}Q${x - s * 0.18} ${y - s * 0.18} ${x} ${y - s}Z`}
        fill={c}
      />
    );
    return <g>{[star(26, 40, 13, '#ffcf4d'), star(176, 30, 10, '#ff9fc0'), star(182, 78, 7, '#8fd6ff'), star(18, 92, 6, '#ffcf4d')]}</g>;
  }
  if (mood === 'sleepy') {
    return (
      <g fill="#a08ac0" fontFamily="system-ui, sans-serif" fontWeight="900">
        <text x="150" y="44" fontSize="26">z</text>
        <text x="170" y="22" fontSize="18">z</text>
      </g>
    );
  }
  return null;
}

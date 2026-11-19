import { Cheeks, Defs, Eyes, MoodBits, Mouth, Shine, StickerBorder, useCharacterIds } from './parts';
import { characterA11y, type CharacterProps } from './types';

/** 나비: 귤빛 아기 고양이 */
export function Nabi({ mood = 'happy', decorative = false, label, className, ...props }: CharacterProps) {
  const ids = useCharacterIds();
  const ears = 'M46 96 48 40 94 70ZM154 96 152 40 106 70Z';
  const shape = (
    <>
      <path d={ears} />
      <ellipse cx="100" cy="120" rx="66" ry="54" />
    </>
  );
  return (
    <svg viewBox="0 0 200 200" className={`character character--nabi ${className ?? ''}`} {...characterA11y('나비', decorative, label)} {...props}>
      <Defs ids={ids} body={['#fff8ec', '#ffcf9c']} />
      <StickerBorder ids={ids}>{shape}</StickerBorder>
      <path d={ears} fill={`url(#${ids.body})`} stroke="#ffd7ad" strokeWidth="8" strokeLinejoin="round" />
      <path d="M58 82 59 54 82 70ZM142 82 141 54 118 70Z" fill="#ffb3b8" stroke="#ffb3b8" strokeWidth="5" strokeLinejoin="round" />
      <ellipse cx="100" cy="120" rx="66" ry="54" fill={`url(#${ids.body})`} />
      {/* 이마 줄무늬 */}
      <g stroke="#f4a565" strokeWidth="6" strokeLinecap="round">
        <path d="M100 70v14M86 73l3 11M114 73l-3 11" />
      </g>
      <Shine x={68} y={92} rx={13} ry={7} opacity={0.85} />
      <Eyes mood={mood} y={118} />
      <Cheeks y={138} gap={40} color="#ff9aa8" opacity={0.5} />
      <path d="M95 131h10l-5 5z" fill="#ff8fa3" stroke="#ff8fa3" strokeWidth="3" strokeLinejoin="round" />
      <Mouth mood={mood} y={139} style="w" />
      <g stroke="#d9a27a" strokeWidth="2.5" strokeLinecap="round" opacity=".8">
        <path d="M44 128l-18-4M44 136l-18 4M156 128l18-4M156 136l18 4" />
      </g>
      <MoodBits mood={mood} />
    </svg>
  );
}

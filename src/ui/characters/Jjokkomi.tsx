import { Cheeks, Defs, Eyes, MoodBits, Shine, StickerBorder, useCharacterIds } from './parts';
import { characterA11y, type CharacterProps } from './types';

/** 쪼꼬미: 노랑 병아리 */
export function Jjokkomi({ mood = 'happy', decorative = false, label, className, ...props }: CharacterProps) {
  const ids = useCharacterIds();
  const tuft = 'M98 62q-10-22 4-28q-2 12 8 16q-6 2-6 12z';
  // 신날 때는 날개를 위로 파닥
  const wingL = mood === 'cheer' ? 'rotate(-40 44 118)' : 'rotate(20 44 126)';
  const wingR = mood === 'cheer' ? 'rotate(40 156 118)' : 'rotate(-20 156 126)';
  const shape = (
    <>
      <path d={tuft} />
      <ellipse cx="44" cy="124" rx="14" ry="24" transform={wingL} />
      <ellipse cx="156" cy="124" rx="14" ry="24" transform={wingR} />
      <circle cx="100" cy="118" r="60" />
    </>
  );
  return (
    <svg viewBox="0 0 200 200" className={`character character--jjokkomi ${className ?? ''}`} {...characterA11y('쪼꼬미', decorative, label)} {...props}>
      <Defs ids={ids} body={['#fffbe3', '#ffd95a']} />
      <StickerBorder ids={ids}>{shape}</StickerBorder>
      <g fill={`url(#${ids.body})`}>{shape}</g>
      <Shine x={76} y={86} opacity={0.9} />
      <Eyes mood={mood} y={112} gap={24} />
      <Cheeks y={132} gap={40} color="#ff9f8a" opacity={0.5} />
      {mood === 'cheer' ? (
        <g stroke="#f08a2c" strokeWidth="2.5" strokeLinejoin="round">
          <path d="M88 124 100 118 112 124Z" fill="#ffa64d" />
          <path d="M90 128 100 140 110 128Z" fill="#ff8d5c" />
        </g>
      ) : (
        <path d="M89 126 100 119 111 126 100 135Z" fill="#ffa64d" stroke="#f08a2c" strokeWidth="2.5" strokeLinejoin="round" />
      )}
      <MoodBits mood={mood} />
    </svg>
  );
}

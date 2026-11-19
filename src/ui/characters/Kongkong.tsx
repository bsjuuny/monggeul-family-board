import { Cheeks, Defs, Eyes, MoodBits, Mouth, Shine, StickerBorder, useCharacterIds } from './parts';
import { characterA11y, type CharacterProps } from './types';

/** 콩콩이: 연두 아기 공룡 */
export function Kongkong({ mood = 'happy', decorative = false, label, className, ...props }: CharacterProps) {
  const ids = useCharacterIds();
  // 등 뾰족이: 밑동을 머리 안쪽에 두고 머리를 그 위에 그려서 떠 보이지 않게 한다
  const spikes = 'M70 80 82 48 96 74ZM90 70 102 38 116 70ZM106 74 122 48 132 82Z';
  const tail = 'M146 150q38 8 40-26q-18 16-42 8z';
  const shape = (
    <>
      <path d={spikes} />
      <path d={tail} />
      <ellipse cx="100" cy="116" rx="64" ry="58" />
    </>
  );
  return (
    <svg viewBox="0 0 200 200" className={`character character--kongkong ${className ?? ''}`} {...characterA11y('콩콩이', decorative, label)} {...props}>
      <Defs ids={ids} body={['#e4fbe9', '#9fdcb3']} accent={['#ffe2b0', '#ffb766']} />
      <StickerBorder ids={ids}>{shape}</StickerBorder>
      <path d={spikes} fill={`url(#${ids.accent})`} stroke="#ffc27a" strokeWidth="7" strokeLinejoin="round" />
      <path d={tail} fill={`url(#${ids.body})`} />
      <ellipse cx="100" cy="116" rx="64" ry="58" fill={`url(#${ids.body})`} />
      <ellipse cx="100" cy="152" rx="36" ry="18" fill="#f3ffe9" opacity=".85" />
      <Shine x={72} y={86} opacity={0.8} />
      <Eyes mood={mood} y={110} />
      <Cheeks y={130} gap={38} />
      <Mouth mood={mood} y={128} style="open" />
      <circle cx="132" cy="146" r="4" fill="#7cc79a" />
      <circle cx="70" cy="150" r="3" fill="#7cc79a" />
      <MoodBits mood={mood} />
    </svg>
  );
}

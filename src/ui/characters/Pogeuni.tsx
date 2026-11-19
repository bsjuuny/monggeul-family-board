import { Cheeks, Defs, Eyes, MoodBits, Mouth, Shine, StickerBorder, useCharacterIds } from './parts';
import { characterA11y, type CharacterProps } from './types';

/** 포근이: 꿀빛 아기 곰 */
export function Pogeuni({ mood = 'happy', decorative = false, label, className, ...props }: CharacterProps) {
  const ids = useCharacterIds();
  const shape = (
    <>
      <circle cx="52" cy="62" r="22" />
      <circle cx="148" cy="62" r="22" />
      <ellipse cx="100" cy="114" rx="66" ry="60" />
    </>
  );
  return (
    <svg viewBox="0 0 200 200" className={`character character--pogeuni ${className ?? ''}`} {...characterA11y('포근이', decorative, label)} {...props}>
      <Defs ids={ids} body={['#fbe6cf', '#e2b48a']} />
      <StickerBorder ids={ids}>{shape}</StickerBorder>
      <g fill={`url(#${ids.body})`}>{shape}</g>
      <circle cx="52" cy="62" r="11" fill="#f6c9b0" />
      <circle cx="148" cy="62" r="11" fill="#f6c9b0" />
      <ellipse cx="100" cy="114" rx="66" ry="60" fill={`url(#${ids.body})`} />
      <Shine x={74} y={80} opacity={0.7} />
      <ellipse cx="100" cy="138" rx="28" ry="20" fill="#fff4e6" />
      <Eyes mood={mood} y={108} />
      <Cheeks y={130} gap={40} color="#ff9fa0" opacity={0.5} />
      <ellipse cx="100" cy="130" rx="8" ry="5.5" fill="#5a3f36" />
      <Mouth mood={mood} y={140} style="nose" />
      <MoodBits mood={mood} />
    </svg>
  );
}

import { Cheeks, Defs, Eyes, MoodBits, Mouth, Shine, StickerBorder, useCharacterIds } from './parts';
import { characterA11y, type CharacterProps } from './types';

/** 몽글이: 하늘빛 뭉게구름 (앱 마스코트) */
export function Monggeul({ mood = 'happy', decorative = false, label, className, ...props }: CharacterProps) {
  const ids = useCharacterIds();
  const shape = (
    <>
      <circle cx="62" cy="112" r="36" />
      <circle cx="98" cy="84" r="46" />
      <circle cx="142" cy="106" r="38" />
      <rect x="40" y="100" width="124" height="60" rx="30" />
    </>
  );
  return (
    <svg viewBox="0 0 200 200" className={`character character--monggeul ${className ?? ''}`} {...characterA11y('몽글이', decorative, label)} {...props}>
      <Defs ids={ids} body={['#ffffff', '#d6ecff']} />
      <StickerBorder ids={ids}>{shape}</StickerBorder>
      <g fill={`url(#${ids.body})`}>{shape}</g>
      <Shine x={80} y={66} rx={16} ry={9} opacity={0.9} />
      <Eyes mood={mood} y={112} />
      <Cheeks y={130} gap={34} />
      <Mouth mood={mood} y={128} style="w" />
      <MoodBits mood={mood} />
    </svg>
  );
}

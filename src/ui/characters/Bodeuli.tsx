import { Cheeks, Defs, Eyes, MoodBits, Mouth, Shine, StickerBorder, useCharacterIds } from './parts';
import { characterA11y, type CharacterProps } from './types';

/** 보들이: 분홍 아기 토끼 */
export function Bodeuli({ mood = 'happy', decorative = false, label, className, ...props }: CharacterProps) {
  const ids = useCharacterIds();
  // 졸릴 때는 한쪽 귀가 살짝 접힌다
  const rightEar = mood === 'sleepy' ? 'rotate(38 128 56)' : 'rotate(14 128 56)';
  const shape = (
    <>
      <ellipse cx="74" cy="56" rx="17" ry="40" transform="rotate(-12 74 56)" />
      <ellipse cx="128" cy="56" rx="17" ry="40" transform={rightEar} />
      <ellipse cx="100" cy="122" rx="62" ry="54" />
    </>
  );
  return (
    <svg viewBox="0 0 200 200" className={`character character--bodeuli ${className ?? ''}`} {...characterA11y('보들이', decorative, label)} {...props}>
      <Defs ids={ids} body={['#ffffff', '#ffe0ea']} />
      <StickerBorder ids={ids}>{shape}</StickerBorder>
      <g fill={`url(#${ids.body})`}>{shape}</g>
      <ellipse cx="75" cy="60" rx="8" ry="28" transform="rotate(-12 75 60)" fill="#ffb8cb" />
      <ellipse cx="127" cy="60" rx="8" ry="28" transform={rightEar.replace('128 56', '127 60')} fill="#ffb8cb" />
      {/* 귀 위에 머리를 다시 그려 귀 밑동을 가린다 */}
      <ellipse cx="100" cy="122" rx="62" ry="54" fill={`url(#${ids.body})`} />
      <Shine x={76} y={94} rx={14} ry={8} opacity={0.9} />
      <Eyes mood={mood} y={120} />
      <Cheeks y={140} gap={38} color="#ff8fab" opacity={0.5} />
      <path d="M96 132l4 4 4-4z" fill="#ff7f9f" stroke="#ff7f9f" strokeWidth="3" strokeLinejoin="round" />
      <Mouth mood={mood} y={141} style="nose" />
      <MoodBits mood={mood} />
    </svg>
  );
}

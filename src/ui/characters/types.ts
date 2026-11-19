import type { SVGProps } from 'react';

export type CharacterMood = 'happy' | 'cheer' | 'sleepy';

export interface CharacterProps extends Omit<SVGProps<SVGSVGElement>, 'role'> {
  mood?: CharacterMood;
  decorative?: boolean;
  label?: string;
}

export function characterA11y(name: string, decorative: boolean, label?: string) {
  return decorative
    ? ({ 'aria-hidden': true, focusable: 'false' } as const)
    : ({ role: 'img', 'aria-label': label ?? `${name} 캐릭터`, focusable: 'false' } as const);
}

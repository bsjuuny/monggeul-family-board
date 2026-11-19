import type { ComponentType } from 'react';
import { Bodeuli } from './Bodeuli';
import { Jjokkomi } from './Jjokkomi';
import { Kongkong } from './Kongkong';
import { Monggeul } from './Monggeul';
import { Nabi } from './Nabi';
import { Pogeuni } from './Pogeuni';
import type { CharacterProps } from './types';

export type { CharacterMood, CharacterProps } from './types';
export { Bodeuli, Jjokkomi, Kongkong, Monggeul, Nabi, Pogeuni };

interface CharacterDefinition {
  key: string;
  name: string;
  kind: string;
  Component: ComponentType<CharacterProps>;
}

export const CHARACTER_REGISTRY = [
  { key: 'monggeul', name: '몽글이', kind: '구름', Component: Monggeul },
  { key: 'bodeuli', name: '보들이', kind: '토끼', Component: Bodeuli },
  { key: 'pogeuni', name: '포근이', kind: '아기 곰', Component: Pogeuni },
  { key: 'kongkong', name: '콩콩이', kind: '아기 공룡', Component: Kongkong },
  { key: 'nabi', name: '나비', kind: '아기 고양이', Component: Nabi },
  { key: 'jjokkomi', name: '쪼꼬미', kind: '병아리', Component: Jjokkomi },
] as const satisfies readonly CharacterDefinition[];

export type CharacterKey = (typeof CHARACTER_REGISTRY)[number]['key'];
export type CharacterEntry = (typeof CHARACTER_REGISTRY)[number];

const CHARACTER_BY_KEY = new Map<string, CharacterEntry>(CHARACTER_REGISTRY.map((entry) => [entry.key, entry]));

export function characterOf(key: string): CharacterEntry | undefined {
  return CHARACTER_BY_KEY.get(key);
}

export function isCharacterKey(key: string): key is CharacterKey {
  return CHARACTER_BY_KEY.has(key);
}

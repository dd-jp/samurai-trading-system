export const MI_SOURCES = {
  alpacaNews: 'alpaca-news',
  gdeltGkg: 'gdelt-gkg',
  polymarket: 'polymarket',
  x: 'x',
} as const;

export type MiSourceId = (typeof MI_SOURCES)[keyof typeof MI_SOURCES];

type MiHydrationPolicy = 'hydrate' | 'archive-only';

const MI_SOURCE_HYDRATION: Record<MiSourceId, MiHydrationPolicy> = {
  [MI_SOURCES.alpacaNews]: 'hydrate',
  [MI_SOURCES.gdeltGkg]: 'archive-only',
  [MI_SOURCES.polymarket]: 'archive-only',
  [MI_SOURCES.x]: 'hydrate',
};

export const HYDRATING_MI_SOURCES: readonly MiSourceId[] = Object.entries(MI_SOURCE_HYDRATION)
  .filter(([, policy]) => policy === 'hydrate')
  .map(([source]) => source as MiSourceId);

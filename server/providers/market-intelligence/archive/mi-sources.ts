export const MI_SOURCES = {
  alpacaNews: 'alpaca-news',
  gdeltGkg: 'gdelt-gkg',
  polymarket: 'polymarket',
  x: 'x',
} as const;

export type MiSourceId = (typeof MI_SOURCES)[keyof typeof MI_SOURCES];

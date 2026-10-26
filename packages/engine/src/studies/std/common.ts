import { choice } from '../../core/params';
import type { SeriesCtx } from '../../core/types';

export const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'] as const;
export type Source = (typeof SOURCES)[number];
export const sourceParam = (def: Source = 'close') => choice(SOURCES, def, { title: 'Source' });

export function src(x: SeriesCtx, i: number, s: Source): number {
  switch (s) {
    case 'close':
      return x.c[i];
    case 'open':
      return x.o[i];
    case 'high':
      return x.h[i];
    case 'low':
      return x.l[i];
    case 'hl2':
      return (x.h[i] + x.l[i]) / 2;
    case 'hlc3':
      return (x.h[i] + x.l[i] + x.c[i]) / 3;
    case 'ohlc4':
      return (x.o[i] + x.h[i] + x.l[i] + x.c[i]) / 4;
  }
}

export const tr = (x: SeriesCtx, i: number): number =>
  i > 0 ? Math.max(x.h[i], x.c[i - 1]) - Math.min(x.l[i], x.c[i - 1]) : x.h[i] - x.l[i];

/** Cross helpers on previous/current pairs. */
export const crossUp = (a0: number, a1: number, b0: number, b1: number): boolean => a0 <= b0 && a1 > b1;
export const crossDown = (a0: number, a1: number, b0: number, b1: number): boolean => a0 >= b0 && a1 < b1;

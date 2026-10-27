/**
 * Signal palettes. Every DeMark-style marker also carries text, so meaning never depends on colour alone
 * (SPEC §10); the colorblind palette follows Okabe–Ito (distinguishable under protan/deutan/tritan).
 */
export type ThemeName = 'dark' | 'light';
export type PaletteName = 'standard' | 'colorblind';

export interface SignalPalette {
  bull: string;
  bear: string;
  bullAlt: string;
  bearAlt: string;
  neutral: string;
  warn: string;
  info: string;
  accent: string;
  muted: string;
  up: string; // candle up
  down: string; // candle down
}

const STANDARD: Record<ThemeName, SignalPalette> = {
  dark: { bull: '#22c55e', bear: '#f43f5e', bullAlt: '#4ade80', bearAlt: '#fb7185', neutral: '#94a3b8', warn: '#f59e0b', info: '#38bdf8', accent: '#a78bfa', muted: '#64748b', up: '#22c55e', down: '#f43f5e' },
  light: { bull: '#16a34a', bear: '#e11d48', bullAlt: '#15803d', bearAlt: '#be123c', neutral: '#64748b', warn: '#d97706', info: '#0284c7', accent: '#7c3aed', muted: '#94a3b8', up: '#16a34a', down: '#e11d48' },
};

const COLORBLIND: Record<ThemeName, SignalPalette> = {
  dark: { bull: '#56b4e9', bear: '#e69f00', bullAlt: '#0072b2', bearAlt: '#d55e00', neutral: '#999999', warn: '#f0e442', info: '#009e73', accent: '#cc79a7', muted: '#6b7280', up: '#56b4e9', down: '#e69f00' },
  light: { bull: '#0072b2', bear: '#d55e00', bullAlt: '#005a8c', bearAlt: '#a64a00', neutral: '#6b7280', warn: '#b8860b', info: '#009e73', accent: '#cc79a7', muted: '#9ca3af', up: '#0072b2', down: '#d55e00' },
};

export function palette(theme: ThemeName, name: PaletteName): SignalPalette {
  return (name === 'colorblind' ? COLORBLIND : STANDARD)[theme];
}

/** Resolve a semantic colour role (or a literal colour) to CSS. */
export function resolveColor(c: string, p: SignalPalette): string {
  return (p as unknown as Record<string, string>)[c] ?? c;
}

/** Link-group colours for synced chart panes. */
export const LINK_COLORS = { red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308', purple: '#a855f7' } as const;
export type LinkGroup = keyof typeof LINK_COLORS;

export function withAlpha(hex: string, a: number): string {
  if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) return hex;
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

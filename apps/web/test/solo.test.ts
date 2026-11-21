import { describe, expect, it } from 'vitest';
import { SOLO_FADE, fadeColor } from '../src/chart/render';

describe('fadeColor — other studies fade back while one is soloed', () => {
  it('fades hex, short hex and hex-with-alpha colours', () => {
    expect(fadeColor('#ff0000')).toBe(`rgba(255, 0, 0, ${SOLO_FADE})`);
    expect(fadeColor('#0f0')).toBe(`rgba(0, 255, 0, ${SOLO_FADE})`);
    expect(fadeColor('#0000ff80', 0.5)).toBe('rgba(0, 0, 255, 0.251)');
  });
  it('multiplies the opacity of rgb() and rgba() colours', () => {
    expect(fadeColor('rgb(1, 2, 3)', 0.2)).toBe('rgba(1, 2, 3, 0.2)');
    expect(fadeColor('rgba(1, 2, 3, 0.16)', 0.5)).toBe('rgba(1, 2, 3, 0.08)');
  });
  it('passes through colours it cannot parse', () => {
    expect(fadeColor('transparent')).toBe('transparent');
  });
});

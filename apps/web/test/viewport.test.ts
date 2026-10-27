import { describe, expect, it } from 'vitest';
import { DEFAULT_SPAN, RIGHT_MARGIN, anchoredRange, following, viewOf } from '../src/chart/viewport';

describe('chart viewport anchoring', () => {
  it('opens a new chart with the newest bar at the right edge', () => {
    const r = anchoredRange(1500, null, 'latest');
    expect(r.to).toBe(1499 + RIGHT_MARGIN);
    expect(r.to - r.from).toBe(DEFAULT_SPAN + RIGHT_MARGIN);
  });

  it('keeps the zoom but snaps to the newest bar in latest mode', () => {
    const prior = viewOf({ from: 200, to: 260 }, 1000); // scrolled far back, 60 bars wide
    const r = anchoredRange(500, prior, 'latest');
    expect(r).toEqual({ from: 499 + RIGHT_MARGIN - 60, to: 499 + RIGHT_MARGIN });
  });

  it('keeps the distance from the newest bar in keep mode', () => {
    const prior = viewOf({ from: 800, to: 900 }, 1000); // newest bar 99 bars off-screen right
    expect(prior.offset).toBe(-99);
    expect(anchoredRange(2000, prior, 'keep')).toEqual({ from: 1800, to: 1900 });
  });

  it('never scrolls a shorter series entirely off screen', () => {
    const prior = viewOf({ from: 0, to: 100 }, 5000);
    const r = anchoredRange(50, prior, 'keep');
    expect(r.to).toBeGreaterThanOrEqual(9);
  });

  it('treats a view whose newest bar is on screen as following', () => {
    expect(following(viewOf({ from: 840, to: 1002 }, 1000))).toBe(true);
    expect(following(viewOf({ from: 700, to: 900 }, 1000))).toBe(false);
  });
});

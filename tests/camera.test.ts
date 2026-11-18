import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  anchoredScroll,
  centreScroll,
  clampZoom,
  halfViewInset,
  mapPxFromClient,
  parseStoredZoom,
  tileFromClient,
  zoomFactorFromWheel,
} from '../src/lib/camera';

describe('clampZoom', () => {
  it('keeps in-range values', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.5)).toBe(0.5);
  });

  it('clamps to the supported range', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(10)).toBe(ZOOM_MAX);
    expect(ZOOM_MIN).toBe(0.35);
    expect(ZOOM_MAX).toBe(2);
  });

  it('falls back to 1 for non-finite input', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('parseStoredZoom', () => {
  it('reads a stored value and clamps it', () => {
    expect(parseStoredZoom('1.5')).toBe(1.5);
    expect(parseStoredZoom('9')).toBe(ZOOM_MAX);
    expect(parseStoredZoom('0')).toBe(ZOOM_MIN);
  });

  it('defaults when nothing usable is stored', () => {
    expect(parseStoredZoom(null)).toBe(1);
    expect(parseStoredZoom(undefined)).toBe(1);
    expect(parseStoredZoom('')).toBe(1);
    expect(parseStoredZoom('abc')).toBe(1);
  });
});

describe('zoomFactorFromWheel', () => {
  it('zooms in for negative deltaY (wheel up) and out for positive', () => {
    expect(zoomFactorFromWheel(-100, 0, 800)).toBeGreaterThan(1);
    expect(zoomFactorFromWheel(100, 0, 800)).toBeLessThan(1);
  });

  it('makes one 100px notch about x1.12 (and its inverse going back)', () => {
    expect(zoomFactorFromWheel(-100, 0, 800)).toBeCloseTo(1.12, 10);
    expect(zoomFactorFromWheel(100, 0, 800)).toBeCloseTo(1 / 1.12, 10);
  });

  it('is an exact inverse for equal and opposite travel', () => {
    const up = zoomFactorFromWheel(-37, 0, 800);
    const down = zoomFactorFromWheel(37, 0, 800);
    expect(up * down).toBeCloseTo(1, 12);
  });

  it('scales line and page delta modes', () => {
    // deltaMode 1: one line is about 16px, so 6.25 lines is one 100px notch.
    expect(zoomFactorFromWheel(-6.25, 1, 800)).toBeCloseTo(1.12, 10);
    // deltaMode 2: one page is the container height.
    expect(zoomFactorFromWheel(-1, 2, 500)).toBeCloseTo(zoomFactorFromWheel(-500, 0, 500), 12);
  });

  it('returns 1 for no movement or bad input', () => {
    expect(zoomFactorFromWheel(0, 0, 800)).toBe(1);
    expect(zoomFactorFromWheel(Number.NaN, 0, 800)).toBe(1);
  });

  it('keeps small trackpad deltas small', () => {
    const f = zoomFactorFromWheel(-2, 0, 800);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThan(1.01);
  });
});

describe('anchoredScroll', () => {
  it('keeps the point under the cursor fixed when the canvas origin does not move', () => {
    // Canvas starts at scroll-space 16 (container padding). Cursor is 200px into the view,
    // scrolled 300px. That is base px (300 + 200 - 16) / 1 = 484 at zoom 1.
    const next = anchoredScroll(300, 200, 1, 2, 16);
    // At zoom 2 that base point sits at 16 + 484*2 in scroll space, so scroll = that - 200.
    expect(next).toBeCloseTo(16 + 484 * 2 - 200, 10);
  });

  it('keeps the point fixed when zooming out', () => {
    const next = anchoredScroll(900, 120, 2, 0.5, 16);
    const basePoint = (900 + 120 - 16) / 2;
    expect(next + 120).toBeCloseTo(16 + basePoint * 0.5, 10);
  });

  it('accounts for a moved canvas origin (centring when smaller than the view)', () => {
    const next = anchoredScroll(0, 300, 1, 0.5, 100, 40);
    // base point = (0 + 300 - 100) / 1 = 200; new = 40 + 200*0.5 - 300 = -160
    expect(next).toBeCloseTo(-160, 10);
  });

  it('is a no-op when the zoom does not change', () => {
    expect(anchoredScroll(250, 80, 1.3, 1.3, 16)).toBeCloseTo(250, 10);
  });

  it('round trips: zooming in then back out restores the scroll', () => {
    const zoomedIn = anchoredScroll(420, 150, 1, 1.5, 16);
    const back = anchoredScroll(zoomedIn, 150, 1.5, 1, 16);
    expect(back).toBeCloseTo(420, 8);
  });
});

describe('centreScroll', () => {
  it('places the target in the middle of the view', () => {
    // Target at base px 500 (tile ~10), zoom 1, canvas origin 16, view 800 wide.
    const left = centreScroll(500, 800, 16, 1);
    // Scroll-space point of the target is 16 + 500 = 516; it should sit at view centre 400.
    expect(516 - left).toBeCloseTo(400, 10);
  });

  it('scales with zoom', () => {
    const left = centreScroll(500, 800, 16, 0.5);
    expect(16 + 500 * 0.5 - left).toBeCloseTo(400, 10);
  });

  it('can go negative when the target is near the leading edge (the caller clamps)', () => {
    expect(centreScroll(10, 800, 0, 1)).toBeLessThan(0);
  });
});

describe('halfViewInset', () => {
  it('is half the view, rounded down, and never negative', () => {
    expect(halfViewInset(800)).toBe(400);
    expect(halfViewInset(601)).toBe(300);
    expect(halfViewInset(-5)).toBe(0);
  });

  it('makes a kart at any tile centrable: the inset covers the half view past each edge', () => {
    // With an inset of half the view on the leading side, a target at scroll-space offset
    // `origin + t` can always reach centre because scroll = origin + t - view/2 >= 0
    // whenever origin >= view/2, which is what the inset guarantees.
    const view = 800;
    const origin = halfViewInset(view) + 16;
    for (const t of [0, 48, 500]) {
      expect(centreScroll(t, view, origin, 1)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('tileFromClient', () => {
  it('maps the canvas rect to tiles at zoom 1', () => {
    // Canvas 10 tiles wide, starting at client x 100, 480px wide (48px tiles).
    expect(tileFromClient(100, 100, 480, 10)).toBe(0);
    expect(tileFromClient(147, 100, 480, 10)).toBe(0);
    expect(tileFromClient(148, 100, 480, 10)).toBe(1);
    expect(tileFromClient(579, 100, 480, 10)).toBe(9);
  });

  it('stays correct when the canvas is zoomed (rect is smaller)', () => {
    // Same 10-tile map at zoom 0.5: rect 240px wide, tiles are 24px on screen.
    expect(tileFromClient(100 + 23, 100, 240, 10)).toBe(0);
    expect(tileFromClient(100 + 24, 100, 240, 10)).toBe(1);
    // Zoomed in to 2x: rect 960px, tiles are 96px.
    expect(tileFromClient(100 + 95, 100, 960, 10)).toBe(0);
    expect(tileFromClient(100 + 96, 100, 960, 10)).toBe(1);
  });

  it('gives negative tiles for points left of or above the canvas', () => {
    expect(tileFromClient(99, 100, 480, 10)).toBe(-1);
  });

  it('returns -1 when the canvas has no layout', () => {
    expect(tileFromClient(50, 100, 0, 10)).toBe(-1);
  });
});

describe('mapPxFromClient', () => {
  it('converts client coordinates into base map pixels', () => {
    // Map 10 tiles = 480 base px, displayed at zoom 0.5 => 240 screen px.
    expect(mapPxFromClient(100 + 120, 100, 240, 480)).toBeCloseTo(240, 10);
    expect(mapPxFromClient(100, 100, 240, 480)).toBe(0);
  });

  it('agrees with tileFromClient after dividing by the tile size', () => {
    const rectStart = 40;
    const rectSize = 960; // zoom 2 on a 10-tile, 48px map
    const client = 40 + 500;
    const px = mapPxFromClient(client, rectStart, rectSize, 480);
    expect(Math.floor(px / 48)).toBe(tileFromClient(client, rectStart, rectSize, 10));
  });
});

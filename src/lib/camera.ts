/**
 * Pure camera and zoom maths for the map view. No DOM access here, so everything is unit
 * tested; SpatialCanvas.vue reads the layout and feeds these functions.
 *
 * Coordinate conventions used throughout:
 * - "base px" are unzoomed map pixels (tile * CELL_SIZE), the same units the drawing code uses.
 * - "screen px" are CSS pixels as laid out (base px * zoom).
 * - "scroll space" is the scrollable content of the scroll container: scrollLeft 0 is the
 *   container's leading edge, and an element's scroll-space offset is its position there.
 * - "contentOffset" is the scroll-space position of the canvas's top-left corner.
 */

export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2;
export const ZOOM_DEFAULT = 1;
export const ZOOM_STORAGE_KEY = 'peerspace_map_zoom';

/** One mouse-wheel notch (about 100px) multiplies the zoom by this. */
const WHEEL_NOTCH_PX = 100;
const WHEEL_NOTCH_FACTOR = 1.12;
const WHEEL_ZOOM_RATE = Math.log(WHEEL_NOTCH_FACTOR) / WHEEL_NOTCH_PX;

/** Approximate pixels for one wheel "line" (deltaMode 1). */
const WHEEL_LINE_PX = 16;

/** Clamp a zoom level into the supported range. Non-numbers fall back to the default. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Parse a persisted zoom value (localStorage string). Missing or junk values give the default. */
export function parseStoredZoom(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return ZOOM_DEFAULT;
  return clampZoom(Number(raw));
}

/**
 * Multiplicative zoom factor for one wheel event. Positive deltaY (scroll down) zooms out.
 * Exponential so zooming in and back out by the same wheel travel is an exact inverse, and
 * so a trackpad's many small deltas add up smoothly.
 */
export function zoomFactorFromWheel(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  let px = deltaY;
  if (deltaMode === 1) px *= WHEEL_LINE_PX;
  else if (deltaMode === 2) px *= Math.max(1, pageHeight);
  return Math.exp(-px * WHEEL_ZOOM_RATE);
}

/**
 * Scroll position that keeps the map point under the cursor where it was.
 *
 * @param oldScroll      scrollLeft (or scrollTop) before the zoom
 * @param anchorClient   cursor position measured from the container's visible leading edge
 * @param oldZoom        zoom before
 * @param newZoom        zoom after
 * @param contentOffset  canvas origin in scroll space before the zoom
 * @param newContentOffset canvas origin in scroll space after the zoom (it moves when the
 *                       map is smaller than the view and is centred). Defaults to contentOffset.
 */
export function anchoredScroll(
  oldScroll: number,
  anchorClient: number,
  oldZoom: number,
  newZoom: number,
  contentOffset: number,
  newContentOffset: number = contentOffset,
): number {
  if (!(oldZoom > 0)) return oldScroll;
  const basePx = (oldScroll + anchorClient - contentOffset) / oldZoom;
  return newContentOffset + basePx * newZoom - anchorClient;
}

/**
 * Scroll position that puts a base-pixel target in the middle of the view.
 *
 * @param targetPx      target in base px (unzoomed), relative to the canvas origin
 * @param viewSize      visible size along this axis (clientWidth or clientHeight)
 * @param contentOffset canvas origin in scroll space
 * @param zoom          current zoom
 */
export function centreScroll(targetPx: number, viewSize: number, contentOffset: number, zoom: number): number {
  return contentOffset + targetPx * zoom - viewSize / 2;
}

/**
 * Padding added on each side of the scrollable content while driving, so the kart can sit in
 * the middle of the view even when it is near a map edge. Half the view on each side is the
 * exact amount needed for that.
 */
export function halfViewInset(viewSize: number): number {
  return Math.max(0, Math.floor(viewSize / 2));
}

/**
 * Map a client (viewport) coordinate to a tile index. `rectStart`/`rectSize` describe the
 * canvas's bounding rect, which already includes zoom, so this stays correct at any zoom.
 * Returns -1 when the canvas has no layout yet, which is outside every map.
 */
export function tileFromClient(clientPos: number, rectStart: number, rectSize: number, mapTiles: number): number {
  if (!(rectSize > 0)) return -1;
  return Math.floor(((clientPos - rectStart) / rectSize) * mapTiles);
}

/**
 * Map a client coordinate to the canvas's internal (base px) coordinate, for sub-tile hit tests
 * such as the sprite under the cursor. `mapPxSize` is the canvas's internal size on that axis.
 */
export function mapPxFromClient(clientPos: number, rectStart: number, rectSize: number, mapPxSize: number): number {
  if (!(rectSize > 0)) return -1;
  return ((clientPos - rectStart) / rectSize) * mapPxSize;
}

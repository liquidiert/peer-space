/**
 * Shared pixel-art colour vocabulary.
 *
 * Every surface in the app - tiles, furniture, avatars - is shaded by the same rule: one
 * light source from the top-left, and ramps that shift *hue* rather than just brightness,
 * with shadows rotating toward a cool blue and highlights toward a warm cream. Flat
 * darkening reads as muddy; the hue shift is what makes a flat colour look lit.
 */

export interface Ramp {
  dark: string;
  base: string;
  light: string;
  hi: string;
}

/**
 * Accent colours for object and avatar details.
 *
 * Deliberately a step or two off full saturation. Pure hues at this size stop reading as a
 * lit material and start reading as a flat decal stuck on top of the scene.
 */
export const ACCENT = {
  red: '#e0705f',
  orange: '#e79355',
  yellow: '#e8c268',
  lime: '#a8c563',
  green: '#68b877',
  teal: '#54b8b4',
  sky: '#63a8dd',
  blue: '#5b86cf',
  violet: '#9585d6',
  pink: '#d67fa4',
  cream: '#f4efe3',
  ink: '#1e2536',
};

export const SHADOW_TINT = '#2b3150';
export const LIGHT_TINT = '#fff2d4';

/** Guards against a malformed or missing user-supplied colour. */
export function safeHex(hex: string | undefined, fallback: string): string {
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : fallback;
}

export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => {
    const x = (pa >> shift) & 255;
    const y = (pb >> shift) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/**
 * Build a cel ramp from a colour that isn't known ahead of time - i.e. whatever skin, hair
 * and outfit a user picked in the Avatar Studio - applying the same hue shift the
 * hand-authored ramps use.
 */
export function rampFrom(hex: string): Ramp {
  return {
    dark: mixHex(hex, SHADOW_TINT, 0.45),
    base: hex,
    light: mixHex(hex, LIGHT_TINT, 0.3),
    hi: mixHex(hex, LIGHT_TINT, 0.58),
  };
}

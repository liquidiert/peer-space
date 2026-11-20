"""Bake a cleaned pixel-art body spritesheet into a TypeScript data module.

Input: a 128x128 RGBA spritesheet, 4x4 grid of 32x32 frames. Rows: 0 = down, 1 = side,
2 = second side row (facing check only), 3 = up. Columns 0-2 are the walk cycle; column 3
is ignored.

Steps (each prints diagnostics):
  1. load and split into frames
  2. classify every opaque pixel into a body role (outline, skin, shirt, pants, shoes)
  3. eye smudges -> skin (with the shade of the nearest skin pixel)
  4. per-role shade ramps (code chars per role and shade)
  5. facing of the side rows from eye/skin position inside the head
  6. canonical head per view, stamped into all three walk frames
  6b. pants re-shaded by rule (dark where the right neighbour is rim, else base)
  6c. neck: lone skin px -> outline; chin holes filled from the skin above; idle column's neck row copied to the other columns (down, side)
  6d. chin and neck shading (down, side): chin row base skin with the right-most cell dark; neck row all dark skin
  7. trim all baked frames to one shared box
  8. anchors per frame, then write the TypeScript module and review images

Run from pixel_generator/:
    .venv/Scripts/python.exe -m pixel_generator.bake_avatar
"""

from __future__ import annotations

import argparse
import colorsys
from collections import Counter, deque
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

PROJECT_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = PROJECT_DIR.parent
DEFAULT_INPUT = PROJECT_DIR / 'outputs' / 'spike' / 'px' / 'lora_seed1_px.png'
DEFAULT_OUTPUT_DIR = PROJECT_DIR / 'outputs' / 'bake'
DEFAULT_TS = REPO_ROOT / 'src' / 'lib' / 'avatarBodyData.ts'

CELL = 32
WALK_COLS = (0, 1, 2)
ROW_DOWN, ROW_SIDE, ROW_SIDE_OTHER, ROW_UP = 0, 1, 2, 3
HEAD_MAX_Y = 16  # upper half of a 32px cell
FOOT_ROWS = 4  # bottom rows of a figure: shoe detection and leg measurements
NEIGH = ((1, 0), (-1, 0), (0, 1), (0, -1))

# Pixel role ids. EYE is a provisional role that step 3 turns into SKIN.
OUT, SKIN, SHIRT, PANTS, SHOES, EYE = 0, 1, 2, 3, 4, 5
ROLE_NAMES = {OUT: 'outline', SKIN: 'skin', SHIRT: 'shirt', PANTS: 'pants', SHOES: 'shoes'}
# Code letters: outline 'o', skin a-d, shirt e-h, pants i-l, shoes q-t. Shoes start at q
# because the brief's m-p range would reuse 'o' for shoes shade 2, colliding with the outline.
CODE_BASE = {'skin': 0, 'shirt': 4, 'pants': 8, 'shoes': 16}
VIEW_ROWS = {'down': ROW_DOWN, 'side': ROW_SIDE, 'up': ROW_UP}
ATTRIBUTION = (
    'Character art generated with FLUX.2-klein-base-4B and the '
    'svntax-dev/pixel_spritesheet_4walk_small_lora_v1 LoRA (Apache-2.0), whose training data '
    "is based on George Bailey's 16x16 game assets template (CC BY 4.0, "
    'https://opengameart.org/content/16x16-game-assets).'
)


def code_char(role: str, shade: int) -> str:
    if role == 'outline':
        return 'o'
    return chr(ord('a') + CODE_BASE[role] + shade)


def all_codes() -> dict[str, tuple[str, int]]:
    """Code char -> (role, shade) for every code the module defines."""
    codes = {'o': ('outline', 1)}
    for role in CODE_BASE:
        for shade in range(4):
            codes[code_char(role, shade)] = (role, shade)
    return codes


# ---------------------------------------------------------------------------
# Step 1: load
# ---------------------------------------------------------------------------


def load_sheet(path: Path) -> np.ndarray:
    im = Image.open(path).convert('RGBA')
    sheet = np.array(im)
    alpha_vals = sorted(set(np.unique(sheet[..., 3]).tolist()))
    print(f'[1] load {path}: size={im.size}, alpha values={alpha_vals}')
    if im.size != (4 * CELL, 4 * CELL):
        raise SystemExit(f'expected a {4 * CELL}x{4 * CELL} sheet, got {im.size}')
    return sheet


def cell(sheet: np.ndarray, row: int, col: int) -> np.ndarray:
    return sheet[row * CELL : (row + 1) * CELL, col * CELL : (col + 1) * CELL]


# ---------------------------------------------------------------------------
# Step 2: role classification
# ---------------------------------------------------------------------------


def hsv_of(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    return h * 360.0, s, v


def colour_class(rgb: tuple[int, int, int]) -> str:
    """Colour-level rule. 'unknown' is resolved later by nearest centroid."""
    h, s, v = hsv_of(rgb)
    warm = h <= 40 or h >= 345
    if v < 0.25:
        return 'dark'  # outline or shoes, decided per pixel by position
    if warm and v >= 0.75:
        return 'skin'
    if warm and s >= 0.2:
        return 'eye'  # reddish-brown smudges, merged into skin in step 3
    if 290 <= h < 345 and s >= 0.2:
        return 'shirt'
    if 160 <= h <= 200 and s >= 0.2:
        return 'pants'
    return 'unknown'


def resolve_classes(counts: Counter) -> dict[tuple[int, int, int], str]:
    classes = {rgb: colour_class(rgb) for rgb in counts}
    centroids = {}
    for cls in ('dark', 'skin', 'shirt', 'pants'):
        members = [(rgb, n) for rgb, n in counts.items() if classes[rgb] == cls]
        if members:
            total = sum(n for _, n in members)
            centroids[cls] = np.array(
                [sum(rgb[i] * n for rgb, n in members) / total for i in range(3)]
            )
    for rgb in counts:
        if classes[rgb] != 'unknown':
            continue
        nearest = min(centroids, key=lambda c: np.linalg.norm(np.array(rgb) - centroids[c]))
        print(f'    unknown colour #{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x} -> nearest centroid: {nearest}')
        classes[rgb] = nearest
    return classes


def is_edge(opaque: np.ndarray, y: int, x: int) -> bool:
    h, w = opaque.shape
    for dy, dx in NEIGH:
        ny, nx = y + dy, x + dx
        if not (0 <= ny < h and 0 <= nx < w) or not opaque[ny, nx]:
            return True
    return False


def pixel_roles(rgba: np.ndarray, classes: dict) -> np.ndarray:
    opaque = rgba[..., 3] > 0
    role = np.full(opaque.shape, -1, dtype=int)
    bottom = int(np.nonzero(opaque.any(axis=1))[0].max())
    for y, x in zip(*np.nonzero(opaque)):
        rgb = tuple(int(c) for c in rgba[y, x, :3])
        cls = classes[rgb]
        if cls == 'dark':
            shoe = not is_edge(opaque, y, x) and y >= bottom - (FOOT_ROWS - 1)
            role[y, x] = SHOES if shoe else OUT
        else:
            role[y, x] = {'skin': SKIN, 'eye': EYE, 'shirt': SHIRT, 'pants': PANTS}[cls]
    return role


# ---------------------------------------------------------------------------
# Connectivity helpers
# ---------------------------------------------------------------------------


def _grow(mask: np.ndarray, seeds: list[tuple[int, int]], seen: np.ndarray) -> list[tuple[int, int]]:
    h, w = mask.shape
    queue = deque(seeds)
    for y, x in seeds:
        seen[y, x] = True
    out = []
    while queue:
        y, x = queue.popleft()
        out.append((y, x))
        for dy, dx in NEIGH:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                queue.append((ny, nx))
    return out


def components(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    seen = np.zeros(mask.shape, dtype=bool)
    comps = []
    for y, x in zip(*np.nonzero(mask)):
        if not seen[y, x]:
            comps.append(_grow(mask, [(int(y), int(x))], seen))
    comps.sort(key=len, reverse=True)
    return comps


# ---------------------------------------------------------------------------
# Step 3 helper: head region (skin + eyes, upper half, largest component, holes filled)
# ---------------------------------------------------------------------------


def head_mask_of(role: np.ndarray) -> np.ndarray:
    ys = np.arange(CELL)[:, None]
    cand = np.isin(role, [SKIN, EYE]) & (ys < HEAD_MAX_Y)
    comps = components(cand)
    if not comps:
        raise SystemExit('no head region found')
    head = np.zeros(role.shape, dtype=bool)
    for y, x in comps[0]:
        head[y, x] = True
    outside = ~head
    seeds = [
        (y, x)
        for y in range(CELL)
        for x in range(CELL)
        if (y in (0, CELL - 1) or x in (0, CELL - 1)) and outside[y, x]
    ]
    reach = np.zeros(role.shape, dtype=bool)
    _grow(outside, seeds, reach)
    head |= outside & ~reach  # holes enclosed by the head
    return head


def centre_of(mask: np.ndarray) -> float:
    ys, xs = np.nonzero(mask)
    return (xs.min() + xs.max() + 1) / 2


# ---------------------------------------------------------------------------
# Step 4: shade ramps
# ---------------------------------------------------------------------------


def lum(rgb: tuple[int, int, int]) -> float:
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def build_shades(counts: Counter, role_name: str) -> dict[tuple[int, int, int], int]:
    if role_name == 'outline':
        return {rgb: 1 for rgb in counts}
    if not counts:
        return {}
    colours = sorted(counts, key=lum)
    n = len(colours)
    mapping: dict[tuple[int, int, int], int] = {}
    if n > 4:
        for i, rgb in enumerate(colours):
            mapping[rgb] = min(3, i * 4 // n)
    else:
        base = counts.most_common(1)[0][0]
        b = colours.index(base)
        for i, rgb in enumerate(colours):
            if rgb == base:
                mapping[rgb] = 1
            elif i < b:
                mapping[rgb] = 0
            else:
                mapping[rgb] = min(3, 2 + (i - b - 1))
    print(f'    {role_name}: {n} colour(s), ' + ', '.join(
        f'#{r:02x}{g:02x}{bb:02x}(lum {lum((r, g, bb)):.0f}, n={counts[(r, g, bb)]}) -> {mapping[(r, g, bb)]}'
        for r, g, bb in colours
    ))
    return mapping


# ---------------------------------------------------------------------------
# Step 6: bands (the head region of a frame, from the figure top down to the row above the shirt)
# ---------------------------------------------------------------------------


@dataclass
class Band:
    top: int
    bottom: int
    x0: int
    x1: int
    torso_start: int
    patch: np.ndarray  # head-only codes, rows top..bottom, columns x0..x1; -1 = not head

    @property
    def width(self) -> int:
        return self.x1 - self.x0 + 1

    @property
    def height(self) -> int:
        return self.bottom - self.top + 1

    @property
    def centre_x(self) -> float:
        return (self.x0 + self.x1 + 1) / 2


def longest_run(mask: np.ndarray) -> int:
    best = run = 0
    for v in mask:
        run = run + 1 if v else 0
        best = max(best, run)
    return best


def extract_band(codes: np.ndarray) -> Band:
    """Head band: figure top down to the row above the torso.

    The torso starts at the first row holding a run of >= 3 shirt pixels; single shirt pixels
    (sleeves reaching up to the shoulder) do not count. Shirt pixels inside the band rows are
    arm sleeves, not head, so they are excluded from the patch and left alone when stamping.
    """
    role = codes // 4
    top = int(np.nonzero((codes >= 0).any(axis=1))[0].min())
    torso = next(y for y in range(CELL) if longest_run(role[y] == SHIRT) >= 3)
    bottom = torso - 1
    head = codes[top : bottom + 1].copy()
    head[role[top : bottom + 1] == SHIRT] = -1
    cols = np.nonzero((head >= 0).any(axis=0))[0]
    x0, x1 = int(cols.min()), int(cols.max())
    return Band(top, bottom, x0, x1, torso, head[:, x0 : x1 + 1].copy())


def _is_clear(codes: np.ndarray, y: int, x: int, open_bottom: bool) -> bool:
    """Transparent or outside the array. open_bottom: below the array is not a silhouette edge."""
    h, w = codes.shape
    if not (0 <= y < h and 0 <= x < w):
        return not (open_bottom and y >= h)
    return codes[y, x] < 0


def _is_rim(codes: np.ndarray, y: int, x: int, open_bottom: bool) -> bool:
    """Outline or transparent: the silhouette rim used for cel shading."""
    if _is_clear(codes, y, x, open_bottom):
        return True
    h, w = codes.shape
    return 0 <= y < h and 0 <= x < w and codes[y, x] // 4 == OUT


def cel_shade(codes: np.ndarray, y: int, x: int, open_bottom: bool) -> int:
    """Skin shade from the rim. One light source top-left.

    Top or left rim -> light (2); bottom or right rim -> dark (0); both kinds -> base (1).
    """
    light = _is_rim(codes, y - 1, x, open_bottom) or _is_rim(codes, y, x - 1, open_bottom)
    dark = _is_rim(codes, y + 1, x, open_bottom) or _is_rim(codes, y, x + 1, open_bottom)
    if light and dark:
        return 1
    if light:
        return 2
    if dark:
        return 0
    return 1


def reshade_pants(codes: np.ndarray) -> int:
    """Pants shade by rule: dark (0) where the right neighbour is rim, else base (1). Returns cells changed."""
    role = codes // 4
    targets = [
        (int(y), int(x))
        for y, x in zip(*np.nonzero((codes >= 0) & (role == PANTS)))
    ]
    new_codes = [
        PANTS * 4 + (0 if _is_rim(codes, y, x + 1, open_bottom=False) else 1)
        for y, x in targets
    ]
    changed = 0
    for (y, x), code in zip(targets, new_codes):
        if codes[y, x] != code:
            codes[y, x] = code
            changed += 1
    return changed


def fix_specks(codes: np.ndarray, lo: int, hi: int, open_bottom: bool) -> tuple[int, int]:
    """SHIRT/PANTS cells in rows lo..hi: OUTLINE if on the silhouette edge, else SKIN (cel-shaded).

    Returns (cells converted to outline, cells converted to skin).
    """
    role = codes // 4
    specks = []
    for y in range(lo, hi + 1):
        for x in range(codes.shape[1]):
            if codes[y, x] >= 0 and role[y, x] in (SHIRT, PANTS):
                edge = any(
                    _is_clear(codes, y + dy, x + dx, open_bottom) for dy, dx in NEIGH
                )
                specks.append((y, x, edge))
    for y, x, edge in specks:
        codes[y, x] = OUT * 4 + 1 if edge else SKIN * 4 + 1
    for y, x, edge in specks:
        if not edge:
            codes[y, x] = SKIN * 4 + cel_shade(codes, y, x, open_bottom)
    n_out = sum(1 for _, _, e in specks if e)
    return n_out, len(specks) - n_out


def fix_isolated_skin(codes: np.ndarray, lo: int, hi: int) -> int:
    """SKIN cells in rows lo..hi with no SKIN 4-neighbour become OUTLINE. Returns cells changed."""
    h, w = codes.shape
    role = codes // 4
    lone = []
    for y in range(lo, hi + 1):
        for x in range(w):
            if role[y, x] != SKIN:
                continue
            has_skin = any(
                0 <= y + dy < h and 0 <= x + dx < w and role[y + dy, x + dx] == SKIN
                for dy, dx in NEIGH
            )
            if not has_skin:
                lone.append((y, x))
    for y, x in lone:
        codes[y, x] = OUT * 4 + 1
    return len(lone)


def fill_chin_holes(codes: np.ndarray, lo: int, hi: int) -> int:
    """Transparent cells in rows lo..hi with opaque left and right neighbours and a SKIN cell
    above take that upper cell's code. Returns cells filled."""
    h, w = codes.shape
    role = codes // 4
    holes = []
    for y in range(max(lo, 1), hi + 1):
        for x in range(1, w - 1):
            if codes[y, x] >= 0:
                continue
            if codes[y, x - 1] >= 0 and codes[y, x + 1] >= 0 and role[y - 1, x] == SKIN:
                holes.append((y, x, int(codes[y - 1, x])))
    for y, x, code in holes:
        codes[y, x] = code
    return len(holes)


def reshade_chin_neck(codes: np.ndarray, band: Band) -> int:
    """Chin and neck shading for a down or side frame. The chin row (band.bottom - 1) is base
    skin, its right-most skin cell dark (shadow side); the neck row (band.bottom) is all dark
    skin, shadowed by the chin. Only SKIN cells change. Returns cells changed."""
    role = codes // 4
    chin_y, neck_y = band.bottom - 1, band.bottom
    changed = 0
    chin_xs = [x for x in range(codes.shape[1]) if role[chin_y, x] == SKIN]
    if chin_xs:
        right = max(chin_xs)
        for x in chin_xs:
            want = SKIN * 4 + (0 if x == right else 1)
            if codes[chin_y, x] != want:
                codes[chin_y, x] = want
                changed += 1
    for x in range(codes.shape[1]):
        if role[neck_y, x] == SKIN and codes[neck_y, x] != SKIN * 4:
            codes[neck_y, x] = SKIN * 4
            changed += 1
    return changed


def reshade_canonical(band: Band, view: str) -> tuple[Band, str]:
    """Clean head shading for the canonical head: rim-based cel shading, specks fixed, catch-light."""
    patch = band.patch.copy()
    role = patch // 4
    n_out, n_skin = fix_specks(patch, 0, patch.shape[0] - 1, open_bottom=True)
    skin_cells = [(int(y), int(x)) for y, x in zip(*np.nonzero((patch >= 0) & (role == SKIN)))]
    for y, x in skin_cells:
        patch[y, x] = SKIN * 4 + cel_shade(patch, y, x, open_bottom=True)
    note = f'specks: {n_out} -> outline, {n_skin} -> skin; skin px re-shaded={len(skin_cells)}'
    if view != 'up' and skin_cells:
        skin_rows = sorted({y for y, _ in skin_cells})
        if len(skin_rows) >= 2:
            y = skin_rows[1]
            left = min(x for yy, x in skin_cells if yy == y)
            lit = []
            for x in range(left + 2, left + 5):
                if x < patch.shape[1] and patch[y, x] >= 0 and patch[y, x] // 4 == SKIN:
                    patch[y, x] = SKIN * 4 + 3
                    lit.append(x)
            note += f'; catch-light row {y} cols {lit}'
    return replace(band, patch=patch), note


def centre_left(cx: float, w: int) -> int:
    return int(np.floor(cx - w / 2 + 0.5))


def paint(canvas: np.ndarray, patch: np.ndarray, top: int, left: int) -> None:
    h, w = patch.shape
    y0, x0 = max(top, 0), max(left, 0)
    y1, x1 = min(top + h, CELL), min(left + w, CELL)
    if y1 <= y0 or x1 <= x0:
        return
    canvas[y0:y1, x0:x1] = patch[y0 - top : y1 - top, x0 - left : x1 - left]


def band_diff(a: np.ndarray, b: np.ndarray) -> int:
    return int((a != b).sum())


def neck_gap(codes: np.ndarray, bottom: int) -> int:
    """Columns under the head's bottom row where a transparent cell sits between head and body."""
    gap = 0
    if bottom + 2 >= CELL:
        return 0
    for x in range(CELL):
        if codes[bottom, x] >= 0 and codes[bottom + 1, x] < 0 and (codes[bottom + 2 :, x] >= 0).any():
            gap += 1
    return gap


def leg_span(codes: np.ndarray) -> int:
    role = codes // 4
    ys = np.nonzero((codes >= 0).any(axis=1))[0]
    low = ys.max()
    rows = slice(low - (FOOT_ROWS - 1), low + 1)
    xs = np.nonzero(np.isin(role[rows], [PANTS, SHOES]).any(axis=0))[0]
    return int(xs.max() - xs.min() + 1)


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------


def to_rows(codes: np.ndarray, box: tuple[int, int, int, int]) -> list[str]:
    x0, y0, x1, y1 = box
    rows = []
    for y in range(y0, y1 + 1):
        s = ''
        for x in range(x0, x1 + 1):
            c = int(codes[y, x])
            if c < 0:
                s += '.'
            else:
                s += code_char(ROLE_NAMES[c // 4], c % 4)
        rows.append(s)
    return rows


def ts_frame(frame: dict) -> list[str]:
    lines = ['    {', '      rows: [']
    lines += [f"        '{row}'," for row in frame['rows']]
    hb = frame['headBox']
    lines += [
        '      ],',
        f"      headBox: {{ x: {hb['x']}, y: {hb['y']}, w: {hb['w']}, h: {hb['h']} }},",
        f"      feetY: {frame['feetY']},",
        f"      centerX: {frame['centerX']},",
        '    },',
    ]
    return lines


def write_ts(path: Path, width: int, height: int, codes_table: dict, facing: str,
             frames: dict[str, list[dict]], passing: int, input_label: str) -> None:
    out = [
        '// Generated by pixel_generator/src/pixel_generator/bake_avatar.py',
        f'// from {input_label}.',
        '// Do not edit by hand: change the baker or its input and run it again.',
        '//',
        f'// {ATTRIBUTION}',
        '',
        "export type BodyRole = 'outline' | 'skin' | 'shirt' | 'pants' | 'shoes';",
        '',
        'export interface BodyFrame {',
        "  /** h strings of w chars. '.' = transparent; otherwise a code char, see BODY_CODES. */",
        '  rows: string[];',
        '  headBox: { x: number; y: number; w: number; h: number };',
        '  /** Lowest opaque row, in frame coordinates. */',
        '  feetY: number;',
        '  /** Centre line of the feet/legs, in pixel-edge coordinates (rounded down). */',
        '  centerX: number;',
        '}',
        '',
        f'export const BODY_W: number = {width};',
        f'export const BODY_H: number = {height};',
        '',
        '/** code char -> [role, shade 0..3] */',
        'export const BODY_CODES: Record<string, [BodyRole, 0 | 1 | 2 | 3]> = {',
    ]
    for ch, (role, shade) in codes_table.items():
        out.append(f"  {ch}: ['{role}', {shade}],")
    out += [
        '};',
        '',
        f"export const BODY_SIDE_FACING: 'left' | 'right' = '{facing}';",
        '',
        'export const BODY_FRAMES: { down: BodyFrame[]; side: BodyFrame[]; up: BodyFrame[] } = {',
    ]
    for view in ('down', 'side', 'up'):
        out.append(f'  {view}: [')
        for frame in frames[view]:
            out += ts_frame(frame)
        out.append('  ],')
    out += [
        '};',
        '',
        '/**',
        ' * Column 1 is the standing/idle frame (head 1px higher). The walk cycle is columns',
        ' * 0, 1, 2, 1.',
        ' */',
        f'export const BODY_PASSING_COLUMN: number = {passing};',
        '',
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(out), encoding='utf-8', newline='\n')
    print(f'[8] wrote {path}')


# ---------------------------------------------------------------------------
# Review images
# ---------------------------------------------------------------------------


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip('#')
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


PREVIEW_PALETTE = {
    'outline': ['#1e293b'] * 4,
    'skin': ['#d9957a', '#f9b795', '#fdd0b4', '#fff1e4'],
    'shirt': ['#1e3a8a', '#2563eb', '#60a5fa', '#bfdbfe'],
    'pants': ['#374151', '#6b7280', '#9ca3af', '#d1d5db'],
    'shoes': ['#1e293b'] * 4,
}
ROLES_PALETTE = {
    'outline': ['#111111'] * 4,
    'skin': ['#f5c542'] * 4,
    'shirt': ['#e53935'] * 4,
    'pants': ['#1e88e5'] * 4,
    'shoes': ['#43a047'] * 4,
}


def decode_rows(rows: list[str], table: dict) -> list[list[tuple[str, int] | None]]:
    return [[None if ch == '.' else table[ch] for ch in row] for row in rows]


def draw_grid(path: Path, sections: list[tuple[str, list[list[str]]]], table: dict,
              palette: dict, scale: int = 8) -> None:
    cols = max(len(frames) for _, frames in sections)
    cw = max(len(r) for _, frames in sections for f in frames for r in f) * scale
    ch = max(len(f) for _, frames in sections for f in frames) * scale
    gap, label_w, top_h = 10, 110, 22
    width = label_w + cols * (cw + gap)
    height = top_h + len(sections) * (ch + gap)
    img = Image.new('RGB', (width, height), (226, 232, 240))
    draw = ImageDraw.Draw(img)
    for c in range(cols):
        draw.text((label_w + c * (cw + gap) + 4, 6), f'walk {c}', fill=(15, 23, 42))
    for r, (label, frames) in enumerate(sections):
        y = top_h + r * (ch + gap)
        draw.text((6, y + ch // 2 - 6), label, fill=(15, 23, 42))
        for c, rows in enumerate(frames):
            x = label_w + c * (cw + gap)
            grid = decode_rows(rows, table)
            for yy, row in enumerate(grid):
                for xx, px in enumerate(row):
                    if px is None:
                        continue
                    role, shade = px
                    colour = hex_rgb(palette[role][shade])
                    draw.rectangle(
                        [x + xx * scale, y + yy * scale, x + (xx + 1) * scale - 1, y + (yy + 1) * scale - 1],
                        fill=colour,
                    )
    img.save(path)
    print(f'[8] wrote {path} ({width}x{height})')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', type=Path, default=DEFAULT_INPUT)
    ap.add_argument('--ts-out', type=Path, default=DEFAULT_TS)
    ap.add_argument('--out-dir', type=Path, default=DEFAULT_OUTPUT_DIR)
    args = ap.parse_args(argv)

    # 1. load
    sheet = load_sheet(args.input)
    frames_rgba = {(r, c): cell(sheet, r, c) for r in range(4) for c in WALK_COLS}
    print('    frames used: rows 0-3 x walk cols 0-2 (column 3 ignored)')

    # 2. classify colours, then pixels
    counts: Counter = Counter()
    for rgba in frames_rgba.values():
        counts.update(tuple(int(c) for c in px) for px in rgba[rgba[..., 3] > 0][:, :3])
    print(f'[2] {len(counts)} distinct opaque colours across the used frames')
    classes = resolve_classes(counts)
    roles = {key: pixel_roles(rgba, classes) for key, rgba in frames_rgba.items()}

    role_by_colour: dict[tuple[int, int, int], Counter] = {rgb: Counter() for rgb in counts}
    for key, rgba in frames_rgba.items():
        opaque = rgba[..., 3] > 0
        for y, x in zip(*np.nonzero(opaque)):
            rgb = tuple(int(c) for c in rgba[y, x, :3])
            role_by_colour[rgb][int(roles[key][y, x])] += 1
    print('[2] palette -> class -> role (pixel counts):')
    print('    colour   count   H       S     V     class    roles')
    for rgb, n in counts.most_common():
        h, s, v = hsv_of(rgb)
        rc = ', '.join(f'{ROLE_NAMES.get(k, "eye")}={m}' for k, m in role_by_colour[rgb].most_common())
        print(f'    #{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}  {n:5d}   {h:6.1f}  {s:.2f}  {v:.2f}  {classes[rgb]:7s}  {rc}')
    role_totals = Counter()
    for r in roles.values():
        role_totals.update(int(v) for v in r[r >= 0])
    print('    totals: ' + ', '.join(f'{ROLE_NAMES.get(k, "eye")}={v}' for k, v in sorted(role_totals.items())))

    # 5. facing evidence (before eye conversion) and head regions
    heads = {key: head_mask_of(roles[key]) for key in frames_rgba}
    print('[5] facing evidence (negative dx = toward the left):')
    facing_votes: dict[int, list[float]] = {ROW_SIDE: [], ROW_SIDE_OTHER: []}
    for row in (ROW_SIDE, ROW_SIDE_OTHER):
        for c in WALK_COLS:
            key = (row, c)
            head = heads[key]
            cx = centre_of(head)
            eye_xs = [x + 0.5 for y, x in zip(*np.nonzero((roles[key] == EYE) & head))]
            skin_xs = [x + 0.5 for y, x in zip(*np.nonzero((roles[key] == SKIN) & head))]
            eye_dx = (np.mean(eye_xs) - cx) if eye_xs else float('nan')
            skin_dx = (np.mean(skin_xs) - cx) if skin_xs else float('nan')
            facing_votes[row].append(eye_dx if eye_xs else skin_dx)
            print(f'    row {row} col {c}: head centre x={cx:.1f}, eye px={len(eye_xs)} '
                  f'eye dx={eye_dx:+.2f}, skin dx={skin_dx:+.2f}, head bbox ys=({np.nonzero(head)[0].min()}..{np.nonzero(head)[0].max()})')
    facing_of = {}
    for row, votes in facing_votes.items():
        median = float(np.nanmedian(votes))
        facing_of[row] = 'left' if median < 0 else 'right'
        print(f'    row {row}: median dx over walk cols={median:+.2f} -> faces {facing_of[row]}')
    if facing_of[ROW_SIDE] == facing_of[ROW_SIDE_OTHER]:
        print('    WARNING: rows 1 and 2 face the same way; only row 1 is baked, the app mirrors it.')
    side_facing = facing_of[ROW_SIDE]
    print(f'    baked side row (row 1) faces: {side_facing}')

    # 3. eyes -> skin. Shade ramps come from baked rows only, eye-free.
    baked_keys = [(row, c) for row in (ROW_DOWN, ROW_SIDE, ROW_UP) for c in WALK_COLS]
    print('[3] eye smudges (in head / outside head):')
    for key in baked_keys:
        head = heads[key]
        in_head = int(((roles[key] == EYE) & head).sum())
        outside = int(((roles[key] == EYE) & ~head).sum())
        print(f'    row {key[0]} col {key[1]}: in-head={in_head} outside-head={outside}')

    # 4. shade ramps per role
    print('[4] shade ramps (role: colour(lum, count) -> shade):')
    baked_role_colour: dict[str, Counter] = {name: Counter() for name in ROLE_NAMES.values()}
    for key in baked_keys:
        rgba = frames_rgba[key]
        for y, x in zip(*np.nonzero(rgba[..., 3] > 0)):
            r = int(roles[key][y, x])
            if r == EYE:
                continue
            baked_role_colour[ROLE_NAMES[r]][tuple(int(c) for c in rgba[y, x, :3])] += 1
    shade_maps = {name: build_shades(cnt, name) for name, cnt in baked_role_colour.items()}

    codes_of: dict[tuple[int, int], np.ndarray] = {}
    for key in baked_keys:
        rgba = frames_rgba[key]
        role = roles[key]
        codes = np.full(role.shape, -1, dtype=int)
        for y, x in zip(*np.nonzero(rgba[..., 3] > 0)):
            r = int(role[y, x])
            if r == EYE:
                continue
            rgb = tuple(int(c) for c in rgba[y, x, :3])
            shade = shade_maps[ROLE_NAMES[r]][rgb]
            codes[y, x] = r * 4 + shade
        skin_pts = list(zip(*np.nonzero(codes // 4 == SKIN)))
        for y, x in zip(*np.nonzero(role == EYE)):
            sy, sx = min(skin_pts, key=lambda p: (p[0] - y) ** 2 + (p[1] - x) ** 2)
            codes[y, x] = SKIN * 4 + int(codes[sy, sx] % 4)
        codes_of[key] = codes

    # 6. canonical head per view
    print('[6] canonical heads:')
    new_codes: dict[tuple[str, int], np.ndarray] = {}
    passing_votes = []
    for view, row in VIEW_ROWS.items():
        bands = [extract_band(codes_of[(row, c)]) for c in WALK_COLS]
        tops = [b.top for b in bands]
        heights = [b.height for b in bands]
        is_pass = tops[1] < tops[0] and tops[1] < tops[2]
        spans = [leg_span(codes_of[(row, c)]) for c in WALK_COLS]
        if is_pass:
            passing_votes.append(1)
        print(f'    {view}: head tops={tops} heights={heights} torso starts={[b.torso_start for b in bands]}')
        print(f'    {view}: col1 head top 1px higher than cols 0 and 2: {is_pass}; leg spans (feet/legs x-extent)={spans}')
        if is_pass:
            canon_i = 1
        else:
            canvases = []
            for b in bands:
                cv = np.full((CELL, CELL), -1, dtype=int)
                paint(cv, b.patch, 20 - b.height + 1, centre_left(16, b.width))
                canvases.append(cv)
            totals = [sum(band_diff(canvases[i], canvases[j]) for j in range(3) if j != i) for i in range(3)]
            canon_i = int(np.argmin(totals))
            print(f'    {view}: medoid totals={totals}')
        canon = bands[canon_i]
        print(f'    {view}: canonical head = walk col {canon_i} (h={canon.height}, w={canon.width})')
        shaded, shade_note = reshade_canonical(canon, view)
        print(f'    {view}: canonical clean-up: {shade_note}')
        for i, c in enumerate(WALK_COLS):
            band = bands[i]
            orig = np.full((CELL, CELL), -1, dtype=int)
            paint(orig, band.patch, band.top, band.x0)
            left = centre_left(band.centre_x, canon.width)
            top = band.bottom - canon.height + 1
            placed = np.full((CELL, CELL), -1, dtype=int)
            paint(placed, canon.patch, top, left)
            diff = band_diff(orig, placed)
            gap_before = neck_gap(codes_of[(row, c)], band.bottom)
            new = codes_of[(row, c)].copy()
            lo = min(top, band.top)
            window = new[lo : band.bottom + 1]
            keep_shirt = window // 4 == SHIRT  # arm sleeves stay
            stamped = np.full((CELL, CELL), -1, dtype=int)
            paint(stamped, shaded.patch, top, left)
            new[lo : band.bottom + 1] = np.where(keep_shirt, window, stamped[lo : band.bottom + 1])
            n_out, n_skin = fix_specks(new, lo, band.bottom, open_bottom=False)
            gap_after = neck_gap(new, band.bottom)
            new_codes[(view, c)] = new
            print(f'    {view} col {c}: head diff vs canonical = {diff} px '
                  f'(orig opaque={int((orig >= 0).sum())}, placed opaque={int((placed >= 0).sum())}); '
                  f'neck gap before={gap_before} after={gap_after}; '
                  f'leftover sleeve specks -> outline {n_out}, -> skin {n_skin}; '
                  f'bottom row={band.bottom}, placed at x={left}, y={top}')

    if passing_votes:
        passing = Counter(passing_votes).most_common(1)[0][0]
    else:
        passing = 1
    print(f'    passing column (head top 1px higher than both neighbours) per view: '
          f'{len(passing_votes)}/3 views agree -> BODY_PASSING_COLUMN={passing}')

    # 6b. pants shade by rule
    pants_changed = 0
    for codes in new_codes.values():
        pants_changed += reshade_pants(codes)
    print(f'[6b] pants re-shaded: {pants_changed} cells changed')

    # 6c. neck: lone skin px -> outline (head band only), then the idle column's neck row is
    # copied to the other walk columns of the down and side views (same head x0 required)
    isolated = 0
    chin = 0
    for codes in new_codes.values():
        band = extract_band(codes)
        isolated += fix_isolated_skin(codes, band.top, band.bottom)
        chin += fill_chin_holes(codes, band.top, band.bottom)
    copied = []
    for view in ('down', 'side'):
        idle = new_codes[(view, passing)]
        idle_band = extract_band(idle)
        for c in WALK_COLS:
            if c == passing:
                continue
            target = new_codes[(view, c)]
            target_band = extract_band(target)
            if target_band.x0 != idle_band.x0:
                print(f'    WARNING: {view} col {c} head x0={target_band.x0} != idle col {passing} '
                      f'x0={idle_band.x0}; neck row not copied')
                continue
            target[target_band.bottom, :] = idle[idle_band.bottom, :]
            copied.append((view, c))
    print(f'[6c] neck: {isolated} isolated skin px -> outline; {chin} chin holes filled from the skin above; '
          f'neck row copied from col {passing} into {copied}')

    # 6d. chin and neck shading on the down and side frames (the up view has no visible chin)
    reshaded = 0
    for (view, _c), codes in new_codes.items():
        if view == 'up':
            continue
        reshaded += reshade_chin_neck(codes, extract_band(codes))
    print(f'[6d] chin and neck reshaded: {reshaded} cells changed')

    # 7. trim
    frames_list = [new_codes[(v, c)] for v in VIEW_ROWS for c in WALK_COLS]
    union = np.zeros((CELL, CELL), dtype=bool)
    for f in frames_list:
        union |= f >= 0
    ys, xs = np.nonzero(union)
    box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    width = box[2] - box[0] + 1
    height = box[3] - box[1] + 1
    print(f'[7] union box over 9 frames: x={box[0]}..{box[2]}, y={box[1]}..{box[3]} -> {width}x{height}; origin=({box[0]},{box[1]})')

    # 8. anchors and output
    out_frames: dict[str, list[dict]] = {}
    for view in VIEW_ROWS:
        out_frames[view] = []
        for c in WALK_COLS:
            codes = new_codes[(view, c)]
            rows = to_rows(codes, box)
            opaque = codes >= 0
            body_ys = np.nonzero(opaque.any(axis=1))[0]
            feet = int(body_ys.max())
            top_y = int(body_ys.min())
            foot_rows = opaque[feet - (FOOT_ROWS - 1) : feet + 1]
            foot_xs = np.nonzero(foot_rows.any(axis=0))[0]
            centre_x = int((int(foot_xs.min()) + int(foot_xs.max()) + 1) // 2)
            band = extract_band(codes)
            head = {'x': band.x0 - box[0], 'y': band.top - box[1], 'w': band.width, 'h': band.height}
            frame = {
                'rows': rows,
                'headBox': head,
                'feetY': feet - box[1],
                'centerX': centre_x - box[0],
            }
            out_frames[view].append(frame)
            print(f'    anchors {view} col {c}: headBox={head} feetY={frame["feetY"]} centerX={frame["centerX"]} '
                  f'(figure top {top_y - box[1]})')

    table = all_codes()
    used_table = {ch: table[ch] for ch in table}
    input_label = args.input.relative_to(REPO_ROOT).as_posix() if args.input.is_relative_to(REPO_ROOT) else args.input.name
    write_ts(args.ts_out, width, height, used_table, side_facing, out_frames, passing, input_label)

    # Review images, decoded back from the baked strings.
    args.out_dir.mkdir(parents=True, exist_ok=True)
    def view_rows(view: str) -> list[list[str]]:
        return [f['rows'] for f in out_frames[view]]

    def mirror(rows_list: list[list[str]]) -> list[list[str]]:
        return [[row[::-1] for row in frame] for frame in rows_list]

    sections = [
        ('down', view_rows('down')),
        (f'side ({side_facing})', view_rows('side')),
        ('up', view_rows('up')),
        ('side mirrored', mirror(view_rows('side'))),
    ]
    draw_grid(args.out_dir / 'preview.png', sections, table, PREVIEW_PALETTE)
    draw_grid(args.out_dir / 'roles.png', sections, table, ROLES_PALETTE)


if __name__ == '__main__':
    main()

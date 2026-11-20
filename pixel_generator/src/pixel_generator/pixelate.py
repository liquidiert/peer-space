"""Turn diffusion-generated fake pixel art into clean, pixel-perfect sprite sheets.

Pipeline: k-centroid downscale -> background removal -> palette quantize -> grid split.

Run from the project root::

    python -m pixel_generator.pixelate INPUT.png --factor 4 --colors 24 --rows 4 --cols 4 --out-dir DIR
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

# Fixed Lloyd iterations for the per-block k-means; enough for 4x4 to 8x8 blocks.
_KMEANS_ITERS = 6
_LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def _assign(blocks: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """Return the nearest-centre index per pixel; blocks (n, p, c), centers (n, k, c) -> (n, p)."""
    dist = ((blocks[:, :, None, :] - centers[:, None, :, :]) ** 2).sum(axis=-1)
    return dist.argmin(axis=-1)


def k_centroid_downscale(img: Image.Image, factor: int, k: int = 2) -> Image.Image:
    """Downscale by `factor` using per-block k-means and keep the centroid of the largest cluster.

    Every factor x factor block is clustered in RGB(A) space, all blocks at once. Centres
    start at evenly spaced luminance ranks, so the result is deterministic. Averaging would
    blend colours across edges; the dominant cluster keeps a true palette colour instead.
    """
    if factor < 1 or k < 1:
        raise ValueError("factor and k must be >= 1")
    mode = "RGBA" if "A" in img.getbands() else "RGB"
    arr = np.asarray(img.convert(mode), dtype=np.float32)
    h, w, c = arr.shape
    if h % factor or w % factor:
        raise ValueError(f"image size {w}x{h} is not divisible by factor {factor}")

    bh, bw, p = h // factor, w // factor, factor * factor
    # (n, p, c): one row per output pixel, one column per source pixel in its block.
    blocks = arr.reshape(bh, factor, bw, factor, c).transpose(0, 2, 1, 3, 4).reshape(-1, p, c)
    n = blocks.shape[0]

    # Deterministic init: k pixels at evenly spaced luminance ranks within each block.
    order = np.argsort(blocks[..., :3] @ _LUMA, axis=1, kind="stable")
    ranks = np.linspace(0, p - 1, k).round().astype(int)
    centers = blocks[np.arange(n)[:, None], order[:, ranks]]  # (n, k, c)

    for _ in range(_KMEANS_ITERS):
        onehot = (_assign(blocks, centers)[..., None] == np.arange(k)).astype(np.float32)
        counts = onehot.sum(axis=1)[..., None]  # (n, k, 1)
        sums = np.einsum("npk,npc->nkc", onehot, blocks)
        centers = np.where(counts > 0, sums / np.maximum(counts, 1.0), centers)

    labels = _assign(blocks, centers)  # (n, p)
    sizes = (labels[..., None] == np.arange(k)).sum(axis=1)  # (n, k)
    best = sizes.argmax(axis=1)  # ties resolve to the lowest index
    member = (labels == best[:, None]).astype(np.float32)  # (n, p)
    out = (blocks * member[..., None]).sum(axis=1) / member.sum(axis=1, keepdims=True)

    out = np.clip(np.rint(out), 0, 255).astype(np.uint8).reshape(bh, bw, c)
    return Image.fromarray(out)


def remove_background(img: Image.Image, tolerance: int = 24) -> Image.Image:
    """Make the border-connected region matching the dominant border colour transparent.

    The background colour is the most common border colour, counted within `tolerance` so that
    noisy pixels still vote together: the border pixel with the most border neighbours within
    tolerance wins, and the median of those neighbours is used. A 4-connected flood fill from
    the border marks pixels within `tolerance` (max abs channel diff) as transparent.
    Same-coloured pixels that are not connected to the border stay opaque.
    """
    rgba = np.asarray(img.convert("RGBA"), dtype=np.uint8).copy()
    h, w = rgba.shape[:2]
    rgb = rgba[..., :3].astype(np.int16)

    border = np.concatenate([rgb[0], rgb[-1], rgb[1:-1, 0], rgb[1:-1, -1]])
    border_close = np.abs(border[:, None, :] - border[None, :, :]).max(axis=-1) <= tolerance
    centre = border_close.sum(axis=1).argmax()
    background = np.median(border[border_close[centre]], axis=0)
    similar = (np.abs(rgb - background).max(axis=-1) <= tolerance).ravel()

    border_idx = np.unique(
        np.concatenate(
            [
                np.arange(w),
                np.arange((h - 1) * w, h * w),
                np.arange(1, h - 1) * w,
                np.arange(1, h - 1) * w + (w - 1),
            ]
        )
    )
    seeds = border_idx[similar[border_idx]].tolist()

    # Iterative flood fill over flat indices (no recursion, no scipy).
    similar_list = similar.tolist()
    reached = bytearray(h * w)
    stack = seeds
    for s in seeds:
        reached[s] = 1
    total = h * w
    while stack:
        pos = stack.pop()
        x = pos % w
        neighbours = []
        if pos >= w:
            neighbours.append(pos - w)
        if pos < total - w:
            neighbours.append(pos + w)
        if x > 0:
            neighbours.append(pos - 1)
        if x < w - 1:
            neighbours.append(pos + 1)
        for q in neighbours:
            if similar_list[q] and not reached[q]:
                reached[q] = 1
                stack.append(q)

    background_mask = np.frombuffer(bytes(reached), dtype=np.uint8).reshape(h, w).astype(bool)
    rgba[..., 3] = np.where(background_mask, 0, rgba[..., 3])
    return Image.fromarray(rgba)


def quantize_palette(img: Image.Image, max_colors: int = 24) -> Image.Image:
    """Reduce opaque pixels to at most `max_colors` colours without dithering.

    The alpha mask is preserved exactly and thresholded at 128 to 0 or 255. Transparent
    pixels get RGB (0, 0, 0).
    """
    rgba = np.asarray(img.convert("RGBA"), dtype=np.uint8)
    h, w = rgba.shape[:2]
    opaque = rgba[..., 3] >= 128
    out = np.zeros((h, w, 4), dtype=np.uint8)

    pixels = rgba[opaque]
    if pixels.size:
        # Quantise a one-row RGBA strip holding only opaque pixels, so transparent pixels never
        # influence the palette. FASTOCTREE keeps rare colours (e.g. eyes) that MEDIANCUT's
        # population-based splits tend to absorb into neighbouring colours.
        strip = Image.fromarray(pixels[None, :, :])
        quantised = strip.quantize(
            colors=max_colors,
            method=Image.Quantize.FASTOCTREE,
            dither=Image.Dither.NONE,
        )
        indices = np.asarray(quantised, dtype=np.intp)[0]
        palette = np.array(quantised.getpalette(), dtype=np.uint8).reshape(-1, 3)
        out[opaque, :3] = palette[indices]

    out[..., 3] = np.where(opaque, 255, 0)
    return Image.fromarray(out)


def split_grid(img: Image.Image, rows: int, cols: int) -> list[list[Image.Image]]:
    """Split `img` into rows x cols equal cells, returned as cells[row][col]."""
    if rows < 1 or cols < 1:
        raise ValueError("rows and cols must be >= 1")
    w, h = img.size
    if w % cols or h % rows:
        raise ValueError(f"image size {w}x{h} is not divisible into {rows} rows x {cols} cols")
    cell_w, cell_h = w // cols, h // rows
    return [
        [img.crop((c * cell_w, r * cell_h, (c + 1) * cell_w, (r + 1) * cell_h)) for c in range(cols)]
        for r in range(rows)
    ]


def upscale_preview(img: Image.Image, scale: int) -> Image.Image:
    """Nearest-neighbour upscale by an integer `scale`, for inspection."""
    if scale < 1:
        raise ValueError("scale must be >= 1")
    w, h = img.size
    return img.resize((w * scale, h * scale), Image.Resampling.NEAREST)


def _count_opaque_colours(img: Image.Image) -> int:
    """Count distinct RGB values among fully opaque pixels."""
    arr = np.asarray(img.convert("RGBA"), dtype=np.uint8)
    return int(np.unique(arr[arr[..., 3] == 255][:, :3], axis=0).shape[0])


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: run the full pipeline and write sheet, preview and frames."""
    parser = argparse.ArgumentParser(description="Clean a fake pixel-art spritesheet into sprites.")
    parser.add_argument("input", type=Path, help="input PNG")
    parser.add_argument("--factor", type=int, default=4, help="real-pixel block size (default 4)")
    parser.add_argument("--colors", type=int, default=24, help="max opaque colours (default 24)")
    parser.add_argument("--rows", type=int, default=4, help="sprite rows in the sheet (default 4)")
    parser.add_argument("--cols", type=int, default=4, help="sprite cols in the sheet (default 4)")
    parser.add_argument("--out-dir", type=Path, default=Path("outputs"), help="output directory")
    parser.add_argument("--no-bg-removal", action="store_true", help="keep the background opaque")
    parser.add_argument("--preview-scale", type=int, default=8, help="preview upscale factor (default 8)")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    stem = args.input.stem
    args.out_dir.mkdir(parents=True, exist_ok=True)

    try:
        with Image.open(args.input) as src:
            sheet = k_centroid_downscale(src.convert("RGBA"), args.factor)
        if not args.no_bg_removal:
            sheet = remove_background(sheet)
        sheet = quantize_palette(sheet, args.colors)
        cells = split_grid(sheet, args.rows, args.cols)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    sheet_path = args.out_dir / f"{stem}_px.png"
    preview_path = args.out_dir / f"{stem}_px_preview.png"
    frames_dir = args.out_dir / f"{stem}_frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    sheet.save(sheet_path)
    upscale_preview(sheet, args.preview_scale).save(preview_path)
    frame_paths: list[Path] = []
    for r, row in enumerate(cells):
        for c, cell in enumerate(row):
            frame_path = frames_dir / f"r{r}_c{c}.png"
            cell.save(frame_path)
            frame_paths.append(frame_path)

    elapsed = time.perf_counter() - started
    print(f"sheet size: {sheet.width}x{sheet.height}")
    print(f"opaque colours: {_count_opaque_colours(sheet)} (max {args.colors})")
    print(f"sheet: {sheet_path}")
    print(f"preview: {preview_path}")
    print(f"frames: {len(frame_paths)} in {frames_dir}")
    for frame_path in frame_paths:
        print(f"  {frame_path}")
    print(f"runtime: {elapsed:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

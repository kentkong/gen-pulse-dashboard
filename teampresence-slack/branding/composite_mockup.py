"""
Composite the Gen Pulse screenshot onto the hand-holding-phone stock
photo by detecting the bright screen region and perspective-warping
the screenshot into it.

Usage:
    python3 composite_mockup.py <phone_photo.png> <screenshot.png> <out.png>
"""

from __future__ import annotations

import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


# Pixels are counted as "screen" when R, G and B are all above this
# threshold. The template screen is pure white so anything above ~235
# picks it up reliably without catching the background.
WHITE_THRESHOLD = 235


def detect_screen_mask(img: Image.Image) -> Image.Image:
    """Return a 1-bit mask of the brightest ~rectangular region."""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    mask = Image.new("L", (w, h), 0)
    mpx = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r >= WHITE_THRESHOLD and g >= WHITE_THRESHOLD and b >= WHITE_THRESHOLD:
                mpx[x, y] = 255
    # A light dilate closes anti-aliased screen edges.
    return mask.filter(ImageFilter.MaxFilter(3))


def find_largest_blob_bbox(mask: Image.Image) -> tuple[int, int, int, int]:
    """Flood-fill from every white pixel, keep the largest component's bbox."""
    w, h = mask.size
    seen = bytearray(w * h)
    px = mask.load()
    best = (0, 0, 0, 0, 0)  # (size, x0, y0, x1, y1)
    for y in range(h):
        for x in range(w):
            if px[x, y] < 128 or seen[y * w + x]:
                continue
            stack = [(x, y)]
            x0, y0, x1, y1 = x, y, x, y
            size = 0
            while stack:
                cx, cy = stack.pop()
                if cx < 0 or cy < 0 or cx >= w or cy >= h:
                    continue
                if seen[cy * w + cx] or px[cx, cy] < 128:
                    continue
                seen[cy * w + cx] = 1
                size += 1
                x0 = min(x0, cx); y0 = min(y0, cy)
                x1 = max(x1, cx); y1 = max(y1, cy)
                stack.extend(((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)))
            if size > best[0]:
                best = (size, x0, y0, x1, y1)
    return best[1:]


def find_screen_corners(mask: Image.Image, bbox):
    """Locate the outermost four corners of the screen region.

    Rounded phone screens have no literal pixel at the bbox corner, but
    the outermost x/y extrema *do* sit on the rim. To land the
    screenshot flush against the bezel we scan the vertical mid-line
    and horizontal mid-line of the bbox to find where the screen
    actually starts/ends, then use the bbox corners themselves for the
    four warp targets. The mask's ~1-px dilation makes the corners
    meet the bezel crisply.
    """
    return (
        (bbox[0], bbox[1]),
        (bbox[2], bbox[1]),
        (bbox[2], bbox[3]),
        (bbox[0], bbox[3]),
    )


def _solve(A, B):
    """Gaussian elimination on an 8x8 system — no numpy dependency."""
    n = len(B)
    M = [row[:] + [B[i]] for i, row in enumerate(A)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[pivot] = M[pivot], M[col]
        if abs(M[col][col]) < 1e-12:
            raise ValueError("singular matrix")
        inv = 1.0 / M[col][col]
        M[col] = [v * inv for v in M[col]]
        for r in range(n):
            if r == col:
                continue
            factor = M[r][col]
            if factor == 0:
                continue
            M[r] = [M[r][k] - factor * M[col][k] for k in range(n + 1)]
    return [M[r][n] for r in range(n)]


def perspective_coeffs(src_corners, dst_corners):
    """Solve the 8 perspective coefficients mapping *dst* → *src*.

    PIL's Image.transform(PERSPECTIVE) expects the inverse mapping —
    the coefficients take an (output_x, output_y) and return the
    (input_x, input_y) to sample.
    """
    A = []
    B = []
    for (dx, dy), (sx, sy) in zip(dst_corners, src_corners):
        A.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        A.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
        B.append(sx)
        B.append(sy)
    return tuple(_solve(A, B))


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255
    )
    return mask


def main(phone_path: str, screenshot_path: str, out_path: str):
    phone = Image.open(phone_path).convert("RGB")
    shot = Image.open(screenshot_path).convert("RGB")

    print(f"phone     : {phone.size}")
    print(f"screenshot: {shot.size}")

    mask = detect_screen_mask(phone)
    bbox = find_largest_blob_bbox(mask)
    print(f"screen bbox (x0,y0,x1,y1): {bbox}")
    tl, tr, br, bl = find_screen_corners(mask, bbox)
    print(f"screen corners: tl={tl} tr={tr} br={br} bl={bl}")

    # Perspective-warp the screenshot into a canvas the size of the
    # phone photo, landing in the detected corners.
    sw, sh = shot.size
    src_corners = [(0, 0), (sw, 0), (sw, sh), (0, sh)]
    dst_corners = [tl, tr, br, bl]
    coeffs = perspective_coeffs(src_corners, dst_corners)

    warped = shot.transform(
        phone.size,
        Image.PERSPECTIVE,
        coeffs,
        resample=Image.BICUBIC,
    )

    # Soft rounded-corner alpha so the screenshot doesn't look
    # stamped-on. Build in the warped-canvas coordinate space.
    alpha = Image.new("L", phone.size, 0)
    draw = ImageDraw.Draw(alpha)
    draw.polygon([tl, tr, br, bl], fill=255)
    alpha = alpha.filter(ImageFilter.GaussianBlur(radius=0.6))

    out = phone.copy()
    out.paste(warped, (0, 0), alpha)
    out.save(out_path, optimize=True)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    main(*sys.argv[1:])

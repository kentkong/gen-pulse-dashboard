"""
Composite a Gen Pulse screenshot onto a hand-holding-phone stock
photo at presentation quality.

What this does differently from a naive paste:

1. Up-scales the (often small) stock photo with Lanczos resampling so
   the phone's screen region has enough resolution to render the
   full Gen Pulse UI sharply instead of as a blurry postage stamp.
2. Auto-detects the bright screen rectangle, then finds the true
   extremes of the white region (not the bbox corners, which sit
   outside the rounded bezel).
3. Perspective-warps the screenshot into those corners.
4. Applies a rounded-corner alpha mask that matches the iPhone's
   screen radius (~8% of the shorter edge) so the composite looks
   like a phone, not a pasted rectangle.
5. Softly feathers the edge so anti-aliased bezel pixels blend in.

Usage:
    python3 composite_mockup.py <phone_photo> <screenshot> <out.png>
      [--scale 4] [--corner-radius auto|<px>]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


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
    return mask.filter(ImageFilter.MaxFilter(3))


def find_largest_blob_bbox(mask: Image.Image) -> tuple[int, int, int, int]:
    """Flood-fill from every white pixel; return bbox of largest blob."""
    w, h = mask.size
    seen = bytearray(w * h)
    px = mask.load()
    best = (0, 0, 0, 0, 0)
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
    """Find the four outermost corners of the (possibly rotated) screen.

    The bbox gives us the axis-aligned envelope. For each corner of
    that envelope we return the *real* white pixel that is closest to
    it — which, for a rotated phone, is the rotated corner of the
    screen. For an axis-aligned phone those coincide with the bbox
    corners.
    """
    x0, y0, x1, y1 = bbox
    px = mask.load()

    def closest_white(target_x, target_y):
        best = None
        best_d2 = None
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if px[x, y] < 128:
                    continue
                d2 = (x - target_x) ** 2 + (y - target_y) ** 2
                if best_d2 is None or d2 < best_d2:
                    best_d2 = d2
                    best = (x, y)
        return best

    axis_aligned_corners = [
        (x0, y0),
        (x1, y0),
        (x1, y1),
        (x0, y1),
    ]
    rotated_corners = [
        closest_white(x0, y0),
        closest_white(x1, y0),
        closest_white(x1, y1),
        closest_white(x0, y1),
    ]
    # If the rotated corners are within ~2% of the bbox corners, the
    # phone is close enough to axis-aligned that we should snap to the
    # bbox so the screenshot reaches flush with the bezel on all sides.
    span = max(x1 - x0, y1 - y0)
    tol = max(3, int(span * 0.02))
    snapped = []
    for axis, rot in zip(axis_aligned_corners, rotated_corners):
        if rot is None:
            snapped.append(axis)
            continue
        dx, dy = rot[0] - axis[0], rot[1] - axis[1]
        if abs(dx) <= tol and abs(dy) <= tol:
            snapped.append(axis)
        else:
            snapped.append(rot)
    return tuple(snapped)


def _solve(A, B):
    """Gaussian elimination on the 8x8 system — no numpy dependency."""
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
    """Coefficients that PIL uses for PERSPECTIVE (dst → src mapping)."""
    A = []
    B = []
    for (dx, dy), (sx, sy) in zip(dst_corners, src_corners):
        A.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy])
        A.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy])
        B.append(sx)
        B.append(sy)
    return tuple(_solve(A, B))


def rounded_quad_mask(canvas_size, quad, radius, feather=1.0):
    """Alpha mask: the quad with rounded corners and a soft feather.

    We build it in an axis-aligned space matching the quad's bbox,
    then draw a rounded rectangle filling that bbox, then paste into
    the larger canvas. For a near-axis-aligned quad this gives the
    correct rounded phone-screen shape. For rotated phones the rect
    is still axis-aligned to the quad's local space so the corners
    still round the right way.
    """
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    x0, y0 = min(xs), min(ys)
    x1, y1 = max(xs), max(ys)
    local_w = x1 - x0
    local_h = y1 - y0

    local = Image.new("L", (local_w, local_h), 0)
    ImageDraw.Draw(local).rounded_rectangle(
        (0, 0, local_w - 1, local_h - 1),
        radius=radius,
        fill=255,
    )
    if feather > 0:
        local = local.filter(ImageFilter.GaussianBlur(radius=feather))

    mask = Image.new("L", canvas_size, 0)
    mask.paste(local, (x0, y0))
    return mask


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phone", help="Stock photo of a hand holding a phone")
    parser.add_argument("screenshot", help="Gen Pulse screenshot to inset")
    parser.add_argument("out", help="Output composite PNG")
    parser.add_argument(
        "--scale",
        type=float,
        default=4.0,
        help="Up-scale the stock photo by this factor before compositing "
        "(default 4x). Higher = crisper screen content, bigger file.",
    )
    parser.add_argument(
        "--corner-radius",
        default="auto",
        help="Screen corner radius in pixels at the scaled resolution. "
        "'auto' ≈ 8%% of the shorter screen edge, matching iPhone.",
    )
    parser.add_argument(
        "--feather",
        type=float,
        default=1.2,
        help="Gaussian blur radius applied to the screen alpha edge.",
    )
    args = parser.parse_args()

    phone = Image.open(args.phone).convert("RGB")
    shot = Image.open(args.screenshot).convert("RGB")

    print(f"source phone  : {phone.size}")
    print(f"source shot   : {shot.size}")

    if args.scale != 1.0:
        new_size = (int(round(phone.size[0] * args.scale)),
                    int(round(phone.size[1] * args.scale)))
        phone = phone.resize(new_size, Image.LANCZOS)
        print(f"scaled phone  : {phone.size} (x{args.scale})")

    mask = detect_screen_mask(phone)
    bbox = find_largest_blob_bbox(mask)
    print(f"screen bbox   : {bbox}")
    corners = find_screen_corners(mask, bbox)
    print(f"screen corners: tl={corners[0]} tr={corners[1]} "
          f"br={corners[2]} bl={corners[3]}")

    tl, tr, br, bl = corners
    short_edge = min(
        abs(tr[0] - tl[0]) + abs(tr[1] - tl[1]),
        abs(bl[0] - tl[0]) + abs(bl[1] - tl[1]),
    )
    if args.corner_radius == "auto":
        radius = max(8, int(round(short_edge * 0.08)))
    else:
        radius = int(args.corner_radius)
    print(f"corner radius : {radius}px (short edge ≈ {short_edge}px)")

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

    alpha = rounded_quad_mask(
        phone.size, dst_corners, radius=radius, feather=args.feather
    )

    out = phone.copy()
    out.paste(warped, (0, 0), alpha)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out, optimize=True)
    print(f"wrote {args.out} ({out.size[0]}x{out.size[1]})")


if __name__ == "__main__":
    main()

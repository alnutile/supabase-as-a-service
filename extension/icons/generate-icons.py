#!/usr/bin/env python3
"""Generate the extension's PNG icons.

Chrome MV3 will not accept an SVG icon, so the mark that lives as SVG in
`public/favicon.svg` is rasterized here instead of being hand-drawn in a paint
program. Pure stdlib (zlib + struct) so it runs anywhere; shapes are drawn at
4x and box-filtered down, which is what gives the rounded corners and the dot
clean edges. Re-run after changing the mark:

    python3 extension/icons/generate-icons.py
"""
import os
import struct
import zlib

SS = 4  # supersampling factor

TEAL = (0x15, 0x79, 0x5B)
GREEN = (0x3E, 0xCF, 0x8E)
WHITE = (0xFF, 0xFF, 0xFF)


def blend(dst, src, a):
    return tuple(round(d + (s - d) * a) for d, s in zip(dst, src))


def rounded_rect(px, w, h, x0, y0, x1, y1, r, color):
    for y in range(max(0, int(y0)), min(h, int(y1) + 1)):
        for x in range(max(0, int(x0)), min(w, int(x1) + 1)):
            cx = min(max(x + 0.5, x0 + r), x1 - r)
            cy = min(max(y + 0.5, y0 + r), y1 - r)
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r:
                px[y][x] = color


def circle(px, w, h, cx, cy, r, color):
    for y in range(max(0, int(cy - r)), min(h, int(cy + r) + 1)):
        for x in range(max(0, int(cx - r)), min(w, int(cx + r) + 1)):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r:
                px[y][x] = color


def render(size):
    """The mark: a teal rounded square holding a white page with text lines,
    and the accent dot from the favicon in the top-right corner."""
    w = h = size * SS
    u = w / 32.0  # one favicon unit, in supersampled pixels
    px = [[None] * w for _ in range(h)]

    rounded_rect(px, w, h, 0, 0, w - 1, h - 1, 7 * u, TEAL)
    # The page.
    rounded_rect(px, w, h, 7 * u, 6 * u, 21 * u, 26 * u, 1.6 * u, WHITE)
    # Its lines of text.
    for i, (x0, x1) in enumerate([(10, 18), (10, 18), (10, 15)]):
        top = (10.5 + i * 4) * u
        rounded_rect(px, w, h, x0 * u, top, x1 * u, top + 1.6 * u, 0.8 * u, TEAL)
    # The accent dot.
    circle(px, w, h, 23.5 * u, 10 * u, 5 * u, TEAL)
    circle(px, w, h, 23.5 * u, 10 * u, 3.4 * u, GREEN)

    # Box-filter down to the target size, keeping transparency outside the mark.
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type 0
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    p = px[y * SS + sy][x * SS + sx]
                    if p is not None:
                        r += p[0]
                        g += p[1]
                        b += p[2]
                        a += 255
            n = SS * SS
            if a:
                cover = a / (255 * n)
                out += bytes((round(r / (a / 255)), round(g / (a / 255)), round(b / (a / 255)), round(cover * 255)))
            else:
                out += b"\0\0\0\0"
    return bytes(out)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, size):
    raw = render(size)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 32, 48, 128):
        write_png(os.path.join(here, f"icon{s}.png"), s)

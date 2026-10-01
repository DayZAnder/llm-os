#!/usr/bin/env python3
"""Look at a VM screen dump (QEMU screendump, PPM) without extra packages.

  screen-check.py <screen.ppm> [out.png]      → JSON summary, optional PNG copy
  screen-check.py diff <a.ppm> <b.ppm>        → fraction of pixels that differ

The summary tells a text console (mostly pure black) from the LLM OS shell
(dark blue-violet surfaces, a lighter accent).
"""
import json, struct, sys, zlib


def read_ppm(path):
    with open(path, 'rb') as f:
        data = f.read()
    parts, pos = [], 0
    while len(parts) < 4:  # magic, width, height, maxval (comments skipped)
        while data[pos:pos + 1].isspace():
            pos += 1
        if data[pos:pos + 1] == b'#':
            pos = data.index(b'\n', pos) + 1
            continue
        end = pos
        while not data[end:end + 1].isspace():
            end += 1
        parts.append(data[pos:end])
        pos = end
    assert parts[0] == b'P6', 'not a binary PPM'
    w, h = int(parts[1]), int(parts[2])
    return w, h, data[pos + 1:pos + 1 + w * h * 3]


def write_png(path, w, h, rgb):
    raw = b''.join(b'\x00' + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))


def summary(w, h, rgb):
    n = w * h
    black = bluish = bright = total = 0
    for i in range(0, len(rgb), 3 * 4):  # every 4th pixel is plenty
        r, g, b = rgb[i], rgb[i + 1], rgb[i + 2]
        total += 1
        if r < 8 and g < 8 and b < 8:
            black += 1
        if b > r + 4 and b > g + 4:
            bluish += 1
        if r + g + b > 300:
            bright += 1
    return {'width': w, 'height': h, 'black': round(black / total, 3), 'bluish': round(bluish / total, 3),
            'bright': round(bright / total, 3), 'gui': bluish / total > 0.3 and black / total < 0.5}


if __name__ == '__main__':
    if sys.argv[1] == 'diff':
        wa, ha, a = read_ppm(sys.argv[2])
        wb, hb, b = read_ppm(sys.argv[3])
        if (wa, ha) != (wb, hb):
            print(1.0)
        else:
            step = 3 * 4
            diff = sum(1 for i in range(0, len(a), step) if abs(a[i] - b[i]) + abs(a[i + 1] - b[i + 1]) + abs(a[i + 2] - b[i + 2]) > 24)
            print(round(diff / (len(a) // step), 4))
    else:
        w, h, rgb = read_ppm(sys.argv[1])
        if len(sys.argv) > 2:
            write_png(sys.argv[2], w, h, rgb)
        print(json.dumps(summary(w, h, rgb)))

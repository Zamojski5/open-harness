#!/usr/bin/env python3
"""WCAG 2.x contrast ratio between colours.

Usage:
  contrast.py FG BG            -> ratio and pass/fail for AA/AAA, normal/large text
  contrast.py --grid HEX HEX ... -> every pair, best pairs first
Hex as #RRGGBB, RRGGBB or #RGB.
"""
import itertools
import sys


def parse(h):
    h = h.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ValueError(f"bad hex: {h}")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def luminance(rgb):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = sorted((luminance(parse(a)), luminance(parse(b))), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def verdict(r):
    return (f"AA text {'pass' if r >= 4.5 else 'FAIL'} | AA large/UI {'pass' if r >= 3 else 'FAIL'} | "
            f"AAA text {'pass' if r >= 7 else 'FAIL'}")


def main(argv):
    if len(argv) >= 3 and argv[0] == "--grid":
        pairs = sorted(((ratio(a, b), a, b) for a, b in itertools.combinations(argv[1:], 2)), reverse=True)
        for r, a, b in pairs:
            print(f"{a} on {b}: {r:.2f}:1  {verdict(r)}")
        return 0
    if len(argv) == 2:
        r = ratio(*argv)
        print(f"{argv[0]} on {argv[1]}: {r:.2f}:1  {verdict(r)}")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

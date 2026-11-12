#!/usr/bin/env python3
"""Burn-in captions without libass/freetype: render SRT cues to transparent PNGs
with Pillow, then emit an ffmpeg filtergraph that overlays each PNG only while
its cue is active (enable='between(t,start,end)').

Usage:
  caption_png.py subs.srt --size 1920x1080 --out takes/caps [--font PATH]
                 [--font-size 0] [--position bottom|top|center] [--margin 0.08]
                 [--box] [--max-width 0.86]

Writes <out>/cue_001.png ... plus <out>/overlay.fg (filtergraph) and
<out>/inputs.txt (one PNG path per line, in input order 1..N). Prints a ready
ffmpeg argument list (JSON) for input video "IN.mp4" -> "OUT.mp4".
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Verdana Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]

TIME = r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})"


def seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def parse_srt(text: str) -> list[tuple[float, float, str]]:
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            m = re.match(TIME + r"\s*-->\s*" + TIME, line.strip())
            if m:
                g = m.groups()
                body = "\n".join(lines[i + 1 :]).strip()
                body = re.sub(r"<[^>]+>", "", body)  # drop <i>, <b> tags
                if body:
                    cues.append((seconds(*g[:4]), seconds(*g[4:]), body))
                break
    return cues


def wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    out = []
    for para in text.split("\n"):
        words, line = para.split(), ""
        for w in words:
            trial = (line + " " + w).strip()
            if draw.textlength(trial, font=font) <= max_w or not line:
                line = trial
            else:
                out.append(line)
                line = w
        if line:
            out.append(line)
    return out


def render(cue: str, w: int, h: int, font, args) -> Image.Image:
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lines = wrap(d, cue, font, int(w * args.max_width))
    asc, desc = font.getmetrics()
    lh = int((asc + desc) * 1.15)
    block_h = lh * len(lines)
    margin = int(h * args.margin)
    if args.position == "top":
        y = margin
    elif args.position == "center":
        y = (h - block_h) // 2
    else:
        y = h - margin - block_h
    stroke = max(2, font.size // 14)
    for line in lines:
        tw = d.textlength(line, font=font)
        x = (w - tw) / 2
        if args.box:
            pad = font.size // 4
            d.rectangle([x - pad, y - pad // 2, x + tw + pad, y + lh - pad // 2], fill=(0, 0, 0, 160))
            d.text((x, y), line, font=font, fill=(255, 255, 255, 255))
        else:
            d.text((x, y), line, font=font, fill=(255, 255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
        y += lh
    return img


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("srt")
    p.add_argument("--size", required=True, help="video WxH, e.g. 1080x1920")
    p.add_argument("--out", required=True)
    p.add_argument("--font")
    p.add_argument("--font-size", type=int, default=0, help="px; default = 5%% of the shorter side, 7%% of width for portrait")
    p.add_argument("--position", choices=["bottom", "top", "center"], default="bottom")
    p.add_argument("--margin", type=float, default=0.08, help="fraction of height from the edge")
    p.add_argument("--max-width", type=float, default=0.86, help="fraction of width per line")
    p.add_argument("--box", action="store_true", help="semi-opaque box instead of outline")
    args = p.parse_args()

    w, h = (int(v) for v in args.size.lower().split("x"))
    font_path = args.font or next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)
    size = args.font_size or int(w * 0.07 if h > w else min(w, h) * 0.05)
    font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default(size)

    with open(args.srt, encoding="utf-8-sig") as fh:
        cues = parse_srt(fh.read())
    if not cues:
        print("no cues found in " + args.srt, file=sys.stderr)
        return 1
    os.makedirs(args.out, exist_ok=True)

    paths, chain, prev = [], [], "0:v"
    for i, (start, end, body) in enumerate(cues, 1):
        path = os.path.join(args.out, f"cue_{i:03d}.png")
        render(body, w, h, font, args).save(path)
        paths.append(path)
        label = "vout" if i == len(cues) else f"c{i}"
        chain.append(f"[{prev}][{i}:v]overlay=0:0:enable='between(t,{start:.3f},{end:.3f})'[{label}]")
        prev = label
    fg = ";\n".join(chain)
    with open(os.path.join(args.out, "overlay.fg"), "w") as fh:
        fh.write(fg + "\n")
    with open(os.path.join(args.out, "inputs.txt"), "w") as fh:
        fh.write("\n".join(paths) + "\n")

    ff = ["-i", "IN.mp4"]
    for path in paths:
        ff += ["-i", path]
    ff += ["-/filter_complex", os.path.join(args.out, "overlay.fg"), "-map", "[vout]", "-map", "0:a?",
           "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "OUT.mp4"]
    print(f"{len(cues)} cues -> {args.out} (font {font_path or 'PIL default'}, {size}px)")
    print(json.dumps(ff))
    return 0


if __name__ == "__main__":
    sys.exit(main())

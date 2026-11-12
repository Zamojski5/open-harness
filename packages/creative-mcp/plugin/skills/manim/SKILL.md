---
name: manim
description: Animate maths, diagrams and explainers with Manim Community — scenes in Python, a project theme, Text/Typst formulas without LaTeX, SVG/raster art, draft and final renders, stills and transparent MOVs. Use for equation walkthroughs, graphs, geometric or algorithm explainers.
---

# Manim (Community Edition)

Status: **untested here** (not installed; PyPI `manim` 0.22.1; Homebrew `cairo` is present, `pango`/`pkg-config` may also be needed). Open source (MIT).

## Setup (consent first)

```bash
cd <piece>/manim && uv venv && uv pip install manim     # or python3 -m venv .venv && .venv/bin/pip install manim
.venv/bin/manim --version
```

Layout: `scenes.py` with one class per Scene, plus `theme.py` that the user can edit — font, palette, spacing, timing constants and an `apply_theme(scene)` that sets the background colour and `Text.set_default(...)`. Every `construct()` starts by calling it. Project fonts in `fonts/` are registered with `manimpango.register_font(path)` first. Asset paths stay relative to the project.

## Render

```bash
manim -ql scenes.py Intro            # draft (480p15)
manim -qh scenes.py Intro            # final (1080p60); -qk for 4K; -r 1920,1080 --fps 30 to be explicit
manim -s -qh scenes.py Intro         # PNG of the last frame
manim -qh -t --format mov scenes.py Intro   # transparent MOV
```

Results appear under `media/videos/…`; copy finals into `takes/` under a new name. Run long renders in the background and wait for them rather than starting a second copy.

## Things that bite

- `Tex`/`MathTex` require LaTeX, which isn't installed here. Use `Text` for words; for formulas use the Typst mobjects (`MathTypst`/`Typst`) if this version has them — test with `python -c "from manim import MathTypst"`.
- Several helpers quietly depend on LaTeX: `DecimalNumber`, and the number labels of `NumberLine` and axes. In a LaTeX-free scene give `DecimalNumber` a `mob_class=Text` and pass `label_constructor=Text` through the axis configuration.
- Typst formulas don't inherit Pango font registration or `Text.set_default`; configure their fonts via the Typst options (font paths, preamble). To recolour or move individual terms, label groups in the Typst source and select them, rather than counting glyph indices.
- Recognisable real-world objects: animate licensed artwork loaded with `SVGMobject` (its parts are separate submobjects) or `ImageMobject`; licences per `craft` rights-and-sources.
- Examples online often target ManimGL (3Blue1Brown's fork) or old CE releases; match them to `manim --version`.

## Review

`media_inspect` + `media_frames` on the MP4; on-screen text holds per `make-motion-graphics` §4b.

## Limits

No managed runtime: we install manim per project, without a bundled Typst guarantee, and protect earlier outputs ourselves.

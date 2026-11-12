---
name: inkscape
description: Automate Inkscape (open-source vector editor) from the command line — export SVG to PNG/PDF/EPS at exact sizes or DPI, convert text to paths, batch-export objects/pages, run actions (align, boolean ops, fit canvas). Use for vector deliverables (logos, print PDFs, icons, laser/plotter files) or when the user works in Inkscape.
---

# Inkscape

Status: **untested here** (Inkscape not installed). Syntax below is Inkscape **1.x** (0.92 used different flags like `-e` / `--export-png`).

## Install / detect
- `/Applications/Inkscape.app/Contents/MacOS/inkscape` (`inkscape --version`).
- Install only with consent: `brew install --cask inkscape`.
- Without Inkscape: write SVG by hand and render to PNG with `make-static-graphic/scripts/html-to-png.sh` (tested route).

## Export
```bash
# all untested
inkscape in.svg --export-type=png --export-filename=out.png --export-width=2048      # by width
inkscape in.svg -o out.png --export-dpi=300                                           # by DPI
inkscape in.svg -o out.pdf --export-text-to-path                                      # print PDF, fonts outlined
inkscape in.svg -o out.png --export-id=logo-mark --export-id-only                     # one object
inkscape in.svg -o out.png --export-area-drawing --export-background=white --export-background-opacity=1
inkscape in.svg --export-type=png,pdf                                                 # several formats
inkscape *.svg --export-type=png                                                      # batch (same folder)
inkscape doc.svg --export-type=pdf --export-page=all                                  # multipage docs (1.2+)
inkscape in.svg --export-plain-svg -o clean.svg                                       # strip inkscape: metadata
```

## Actions (headless edits, `--actions` list separated by `;`)
```bash
inkscape --action-list                                   # discover
inkscape in.svg --actions="select-all;object-to-path;export-filename:out.svg;export-plain-svg;export-do"
inkscape in.svg --actions="select-by-id:icon;fit-canvas-to-selection;export-filename:icon.png;export-width:512;export-do"
```
For many edits, open a shell once: `inkscape --shell`, then type actions (faster than relaunching).

## Use it for
Final logo/icon files (SVG + PDF + PNG sizes), print PDFs with outlined text and bleed, tracing a bitmap (`Path → Trace Bitmap` is GUI only; for CLI tracing use `potrace` if available).

## Pitfalls
- Fonts must be installed on the system for correct text; outline (`--export-text-to-path`) before handing off.
- Units: SVG `viewBox` + `width/height` in px; for print set mm and export at 300 DPI.
- Check the PNG with `Read`.

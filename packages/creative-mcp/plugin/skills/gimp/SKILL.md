---
name: gimp
description: Automate GIMP (open-source raster editor) in batch mode — resize, crop, colour-correct, convert, run filters, process folders of images, edit XCF/PSD layers via Script-Fu or Python-Fu. Use when the user wants GIMP specifically or needs raster edits beyond what ffmpeg handles (layer masks, heal, unsharp, perspective, PSD layers).
---

# GIMP

Status: **untested here** (GIMP not installed). GIMP **2.10 and 3.0 differ** — check `gimp --version` first.

## Install / detect
- `/Applications/GIMP.app/Contents/MacOS/gimp` (3.x may name it `gimp-3.0`; 2.10 `gimp-2.10`). Add an alias in the shell command, not globally.
- Install only with user consent: `brew install --cask gimp`.
- Many simple jobs don't need GIMP: resize/crop/grade/format conversion → `ffmpeg` (installed). Use GIMP when ffmpeg can't.

## Batch: Script-Fu (works in 2.10, and in 3.0 with the 3.0 PDB names)
```bash
# untested — GIMP 2.10 syntax
gimp -i -b '(let* ((img (car (gimp-file-load RUN-NONINTERACTIVE "in.jpg" "in.jpg")))
                   (drw (car (gimp-image-get-active-drawable img))))
  (gimp-image-scale img 1600 1067)
  (plug-in-unsharp-mask RUN-NONINTERACTIVE img drw 1.5 0.5 0)
  (file-png-save RUN-NONINTERACTIVE img drw "out.png" "out.png" 0 9 0 0 0 0 0)
  (gimp-image-delete img))' -b '(gimp-quit 0)'
```
GIMP 3.0: `gimp-image-get-active-drawable` is gone — use `(vector-ref (car (gimp-image-get-selected-drawables img)) 0)`; save with `(gimp-file-save RUN-NONINTERACTIVE img "out.png")`; run with `gimp-console-3.0 -i --batch-interpreter=plug-in-script-fu-eval -b '...'`. *(untested)*

## Batch: Python (GIMP 3.0, GObject introspection)
```bash
# untested
gimp-console-3.0 -i --batch-interpreter=python-fu-eval -b '
from gi.repository import Gimp, Gio
img = Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path("/abs/in.jpg"))
img.scale(1600, 1067)
Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, img, Gio.File.new_for_path("/abs/out.png"), None)
img.delete()
' -b 'Gimp.get_pdb().run_procedure("gimp-quit", [True])'
```
GIMP 2.10 Python-Fu is Python 2 (`from gimpfu import *`, `pdb.gimp_file_load(...)`) and is often missing in macOS builds.

## Discover procedures
Filters → Script-Fu/Python Console → Browse (Procedure Browser) lists every PDB call with arguments — look up names there rather than guessing.

## Pitfalls
- Always `-i` (no UI) and end with quit or the process hangs.
- Quote carefully: wrap Script-Fu in single quotes, paths in double quotes; use absolute paths.
- Folder batches: loop in bash and call GIMP once per file only if few files; otherwise one Script-Fu call using `file-glob`.
- Verify output by `Read`-ing the PNG.

---
name: krita
description: Automate Krita (open-source painting app) — batch-process .kra/PSD/PNG files, apply filters, manage layers, export layered paintings, run Python in Krita. Use when the user works in Krita or needs painterly brush work, layered .kra files, or texture painting that Blender/HTML can't do.
---

# Krita

Status: **untested here** (Krita not installed on the dev machine). Commands follow Krita 5.x; verify on first use and adjust.

## Install / detect
- Detect: `ls /Applications/krita.app` · binary `/Applications/krita.app/Contents/MacOS/krita`.
- Install only after the user agrees: `brew install --cask krita`.

## Headless options
1. **Export without UI** (simple conversion, flattens):
   `krita in.kra --export --export-filename out.png` *(untested)*
   Sequence of an animation: `krita in.kra --export-sequence --export-filename frames/f.png` *(untested)*
2. **Python via kritarunner** (runs a module's `__main__`-style function without the main window):
   `/Applications/krita.app/Contents/MacOS/kritarunner -s myscript -f main` *(untested; script must be on Krita's Python path, e.g. `~/Library/Application Support/krita/pykrita/`)*
3. **Inside the GUI**: Tools → Scripts → Scripter, paste Python (best for interactive work with the user watching).

## Minimal script (Krita Python API)
```python
from krita import Krita  # untested
app = Krita.instance()
doc = app.openDocument("/abs/in.kra")
doc.setBatchmode(True)                    # no dialogs
root = doc.rootNode()
for n in root.childNodes():
    print(n.name(), n.type(), n.visible())
layer = doc.createNode("Overlay", "paintlayer")
root.addChildNode(layer, None)
f = app.filter("blur"); f.apply(layer, 0, 0, doc.width(), doc.height())
doc.refreshProjection()
info = __import__("krita").InfoObject()
doc.exportImage("/abs/out.png", info)     # export flattened
doc.saveAs("/abs/out.kra")
doc.close()
```
Pixel data: `node.pixelData(x, y, w, h)` / `setPixelData(...)` (raw bytes in the layer's colour space).

## Use it for
Hand-painted textures for Blender, overpaint on renders (import render as a layer, paint lighting/FX on top), layered illustration deliverables (.kra / .psd for the client).

## Pitfalls
- Always `setBatchmode(True)` in scripts or export dialogs block.
- Colour space: new docs default to sRGB 8-bit; match the source (16-bit for painting over renders).
- Check results by exporting a PNG and `Read`-ing it; Krita has no remote control channel.

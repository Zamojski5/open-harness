---
name: vectorcraft
description: Drive VectorCraft (open-source Illustrator-class vector editor) through its MCP tools or CLI - open and convert AI, EPS, PDF, SVG, Affinity and DXF files, draw shapes and paths, set fills/strokes, type, live effects, pathfinder, transforms, image trace, recolor, graphs, symbols, artboards, and export SVG/PDF/PNG/AI/EPS/DXF. Load before any mcp__vectorcraft__* call, and whenever a task means editing or converting vector artwork (logos, icons, print files).
---

# VectorCraft

VectorCraft is a vector illustration editor. Every menu action is an engine command (about 820, e.g. `object.align`, `imageTrace.make`, `recolor.apply`, `document.export`) with JSON params. Written against `vectorcraft-cli 0.18.0`; workflows come from its help and catalogue and are **untested here**.

Pick it for logos, icons, print-ready vectors and format conversion of vector files (an `.ai` the user sent, an EPS from a printer). Raster editing belongs in `photocraft`, multi-page layout in `designcraft`.

## Connect

- The `vectorcraft` MCP server runs **headless** (`vectorcraft-cli mcp --headless --automation-read-root DIR --automation-write-root DIR`). Without `--headless` the CLI first tries a running app on 127.0.0.1:7979 and only then falls back to headless — so always pass it (the root flags imply it). Files the agent opens/places must be under a read root, files it saves/exports under a write root.
- Desktop-only tools fail headless: `ui_screenshot`, `ui_inspect`/`inspect_ui`, `type_text`, `answer_dialog`, `open_panel`, `screenshot {window:true}`. Look with `render_preview` or `screenshot` (artboard render).
- To show the user: `save_file` (native `.vectorcraft`) or `export` to an absolute path under the write root, then `craft_launch {app:"vectorcraft", files:[path]}`.
- Shell alternative `~/.open-herness/bin/vectorcraft-cli`: `info FILE` (import warnings, artboards, fonts, object counts) · `convert IN OUT [--scale N] [--artboard I | --range R] [--outline-text] [--decimals N] [--ai-version 7|pdf]` · `run --in FILE --cmd ID --params '{json}' … --export FILE [--scale N]` (or `--commands FILE|-` with a JSON array / JSON lines) · `commands` (whole catalogue as JSON).

## Tools (headless)

`doc_inspect` / `inspect_document` · `command_list {filter|query|menu}` (narrow it; the catalogue is large) → `command_run` / `run_command` / `command_batch {steps, atomic?, label?}` · `draw_shape` (rectangle, ellipse, polygon, star…) · `draw_path {points | d}` · `set_paint {fill, stroke, strokeWeight}` · `add_text` (point or area type) · `apply_effect` (omit `effect` to list the catalogue) · `pathfinder` · `transform` · `create_graph` · `text_wrap` · `select_tool` + `pointer_gesture` / `press_key` (tool-driven drawing) · `open_file` · `save_file` · `export` · `render_preview` / `screenshot` · `undo` / `redo`. MCP prompts (`prompts/list`) offer ready workflows; resources `vectorcraft://object/{id}`, `…/command/{id}`, `…/effect/{id}`, `…/swatch/{name}` read one item instead of the whole document.

## Rules

1. **Coordinates are points, y down**, origin at the first artboard's top-left; a new document is 612×792 pt.
2. **New objects become the selection; most commands act on the selection** or explicit `ids`. Read ids from `doc_inspect` before acting on existing art.
3. **Read import warnings** (`info` or `open_file` reply) — they say what did not come in as authored (e.g. an EPS read from its preview, hidden text). Tell the user when the source was lossy; never overwrite it.
4. **Group a logical change** with `command_batch {atomic:true, label}` so one undo reverts it.
5. **Text for delivery**: outline type (`type.createOutlines`, or `--outline-text` on convert) when the receiver may lack the font; keep a live-text master.
6. **Look after each step** with `render_preview` (max_side 1024 default, up to 4096).

## Workflow

1. Open (`open_file`) or create (`command_run file.new {preset?, width, height, units, artboards}`); `doc_inspect`.
2. Build or edit: shapes/paths, `set_paint`, swatches (`swatch.*`), type, `pathfinder`, `transform`, `object.align`/`object.distribute`, live effects via `apply_effect`.
3. Raster to vector: place the image, `imageTrace.make {preset?, params?}` (`imageTrace.presets`), then `imageTrace.expand`.
4. Colour variants: `recolor.colors` → `recolor.apply {map}`; `recolor.reduce` for limited palettes.
5. Export: `export {path, format}` — svg/svgz, pdf, ai, eps, png/jpg/webp/gif/tiff (raster scale via `scale`), dxf, emf, psd; multi-size assets via `document.exportForScreens`; packaging with `file.package`.

## Known limits

Alpha-stage upstream: PDF-compatible `.ai` files read well, but full Illustrator round-trip is incomplete; EPS can fall back to an embedded preview (with a warning); 3D/materials and some raster effects are not implemented.

## Professional workflow

Distilled from how a studio-grade agent drives Illustrator: address the document explicitly, learn its coordinate system, keep the editable source separate from exports, and measure the clipping path rather than the clipped group. Ids below were checked against `vectorcraft-cli` 0.18; behaviour beyond their documented params is untested.

**Ask first** (skip what the brief answers): which document (open or file path), deliver editable `.vectorcraft`/`.ai`, SVG, PDF or PNG (size, `scale`), keep type live or outline it, vectorising a raster (use `imageTrace.make`, or generate a vector with `make-image` then `file.place`).

**Session loop**

1. Read before writing: `info FILE` for import warnings, artboards, fonts, counts; `doc_inspect` for ids; `document.info` for units. Confirm origin and units (`document.setUnits`, `document.setRulerOrigin`); read artboard bounds, they differ between files. Coordinates are points, y down.
2. Address by `ids`, not the selection, when art already exists. Object counts from a flat listing include nested items: do not count a child twice through its group.
3. Group each logical change in `command_batch {atomic:true, label}`; check the reply, then `render_preview` at 100 % of the area you touched (up to `max_side` 4096).
4. Exports can dirty or retarget the live document: keep the editable master by `file.saveAs` to `.vectorcraft` (or `.ai`) first, then `document.export` to a separate path. Never overwrite the source file; save versions (`-v02`).

**Path hygiene** (before delivery)

- `object.path.cleanUp {strayPoints:true, unpaintedObjects:true, emptyTextPaths:true}`; `select.object.strayPoints` / `select.object.openPaths` to find the leftovers first.
- Reduce points with `object.path.simplify {level | auto:true, cornerAngle}`; close gaps with `path.join` / `path.average`; merge shapes with `object.pathfinder.unite|minusFront|intersect|divide|trim`; keep holes with `object.compoundPath.make`.
- Strokes to outlines for scalable logos: `object.path.outlineStroke`; round numbers: `object.makePixelPerfect` for icons on a pixel grid.
- Naming: name layers (`layer.new`, `layer.setProps`) and use symbols (`symbol.new`, `symbol.place`) for repeated marks.

**Type**: set with `text.create` / `text.setStyle`; check `text.missingFonts` and `text.replaceFont`; for delivery to others `type.createOutlines` on a copy (`--outline-text` on CLI `convert`), keep the live-text master.

**Clipping and masks**: put the artwork and the frontmost clipping path in place first, then `object.clippingMask.make {ids}`; the clipped group's bounds include the hidden art, so measure the clipping path. Release with `object.clippingMask.release`.

**Artboards**: `artboard.new {x, y, width, height, name}`, `artboard.setProps`, `artboard.fitToArt`, `artboard.rearrange`; one master artboard plus variants (`artboard.duplicate`) for a banner or icon system. Multi-size export: `document.exportForScreens {folder, artboards | assets, zip}`. Note built-in SVG export covers one artboard; use `exportForScreens` for sets.

**Colour**: global swatches (`swatch.new`, `swatch.addUsedColors`, `swatch.merge`), recolour a variant with `recolor.colors` then `recolor.apply {map}`; reduce palettes with `recolor.reduce`; print: `file.documentColorMode {mode:"cmyk"}` and `view.overprintPreview`. Appearance stacks: `appearance.addFill|addStroke|addEffect`; bake with `object.expand` before handing to a printer.

**Trace workflow**: place raster, `imageTrace.presets` to choose, `imageTrace.make {preset}`, check, `imageTrace.expand`, `object.path.simplify`, `recolor.reduce`. Always compare the trace with the original at 100 %; high-fidelity traces create thousands of anchors.

**Export checks**: SVG: `document.export {format:"svg"}` then reopen with `info` for warnings; PDF: print-ready exports through `file.package` for fonts and links; PNG: pass `scale` for retina assets; after export verify bounds and a transparent background by looking at the PNG.

**Gaps**: no document preflight command (check fonts, links, stray points manually with the ids above), no outline-view toggle for visual path inspection (use `render_preview` of a stroke-only copy), no 3D or full Illustrator `.ai` round-trip, no multi-artboard SVG.

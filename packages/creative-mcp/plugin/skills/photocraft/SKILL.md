---
name: photocraft
description: Drive PhotoCraft (open-source Photoshop-class layered image editor) through its MCP tools or CLI - open/create PSD, PSB and .pcraft documents, edit the layer tree, type layers, adjustment and fill layers, masks, smart objects (replace contents for templates), filters, selections, content-aware fill, actions/batches, data-set variants, and export PNG/JPEG/TIFF/WebP/EXR/PSD. Load before any mcp__photocraft__* call, and whenever a task means editing a layered PSD or templated raster artwork.
---

# PhotoCraft

PhotoCraft edits layered raster documents. Every edit is an engine command (`layer.newAdjustmentLayer.curves`, `type.edit`, `filter.blur.gaussianBlur`…) with JSON params; each command is one history step. Written against `photocraft-cli 0.17.0`; the workflows come from its help and command registry and are **untested here** — verify with previews.

Pick it for PSD templates (swap a headline or photo, export variants), layered retouching and raster finishing. For raw photo development use `lightcraft`; for vector art `vectorcraft`; for page layout `designcraft`.

## Connect

- The `photocraft` MCP server runs **headless** (`photocraft-cli mcp --automation-read-root DIR --automation-write-root DIR`). The roots are the only folders the agent may read from / write to; a missing root denies that direction. File paths in tool calls must lie under those roots (prefer absolute paths).
- Headless has no window: `ui_*`, `control_call` and window screenshots are bridge-only. Look with `render_preview` / `doc_render_preview`.
- To show the user: `doc_save` to an absolute path under the write root (`.pcraft` or `.psd` for an editable file, plus a PNG), then `craft_launch {app:"photocraft", files:[path]}`.
- Shell alternative `~/.open-herness/bin/photocraft-cli`: `info FILE --compact` (layer tree JSON) · `run FILE|--new '{json}' --cmd ID --params '{json}' … --out FILE` (each `--params` belongs to the `--cmd` before it; `--out` equal to the input is refused unless `--in-place`) · `convert IN OUT` · `batch --actions F --in DIR --out DIR` (JSON steps, an actions set, or a Photoshop `.atn`) · `droplet` · `commands --json --filter WORD` · `serve` (a persistent JSON-lines session).

## Tools (headless)

`doc_new` (default 1920×1080 RGB 8-bit) · `doc_open {path}` · `doc_inspect` (layer tree top→bottom, history, selection, active layer) · `session_list` / `doc_select` / `doc_close` · `command_list` → `command_run {id, params}` / `command_batch` · `render_preview` / `doc_render_preview` · `doc_save {path?}` / `doc_export` · `doc_place {path, scale?, fit?, center?}` (embedded smart object) · `doc_replace_smart_object {layer, path}` · `doc_export_layers` · `doc_import_data_sets` / `doc_export_data_sets` (CSV-driven variants) · `jobs_list` / `jobs_cancel` for long filters. Live state is also readable as resources `photocraft://document` and `photocraft://commands`.

## Rules

1. **Orient first**: `doc_inspect` (or CLI `info`) before any edit; reference layers by the names/ids it returns.
2. **Command ids change between releases** — find them with `command_list` (filter by word) and read the params doc; don't reuse ids from memory.
3. **Non-destructive by default**: prefer `layer.newAdjustmentLayer.*` (curves, levels, exposure, hueSaturation, colorBalance, gradientMap, colorLookup…) over the destructive `image.adjustments.*`, fill layers over painted pixels, smart objects over rasterised placements.
4. **Long commands run as jobs** (filters, content-aware fill/scale, merges): poll `jobs_list` before saving.
5. **Never overwrite the source PSD**: save to a new versioned name; the CLI refuses in-place writes without `--in-place`.
6. **Fonts**: a missing font warns and is substituted. Check `type.info` / `type.fonts`, resolve with `type.resolveMissingFonts` or pick an installed family, and look at the preview.

## Workflow

1. Open or create: `doc_open` / `doc_new`; `doc_inspect`.
2. Template swap: text via `type.edit` / `type.setStyle` (create with `type.create`); photos via `doc_replace_smart_object` (keeps transform and filters) or `doc_place` + mask.
3. Retouch/colour: adjustment layers with masks (`select.subject`, other `select.*`, then a mask command from `command_list --filter mask`); `edit.contentAwareFill` for removals; `filter.*` (124 filters) for blur, sharpen, noise, distort, render.
4. Size: `image.imageSize`, `image.canvasSize`; per-format variants via the CLI `run`/`batch` or data sets.
5. Preview, fix, then `doc_save` (`.pcraft` lossless native, `.psd` for exchange) and export PNG/JPEG/WebP (`--quality`), TIFF (`--tiff-layers` keeps layers), EXR, TGA, DPX, DDS as needed.

## Known limits

Alpha-stage upstream: PSDs written by PhotoCraft are not yet guaranteed to open cleanly in Adobe Photoshop — if the user needs Photoshop round-trip, say so and deliver a flat PNG/TIFF alongside.

## Professional workflow

Distilled from how a studio-grade agent drives Photoshop: ask what is delivered, target layers by id, keep everything non-destructive, set one property per command, read it back with tolerance, export as a copy. Command ids were checked against `photocraft-cli` 0.17; behaviour beyond the params documented here is untested.

**Ask first** (skip what the brief answers): which document (open session or file path), deliver layered `.psd`/`.pcraft` or flattened export (format, pixel size, colour space) or both, and whether any layer needs new imagery (generate it with `make-image`, then `doc_place`). Never overwrite a source PSD or one with unsaved work.

**Session loop**

1. `doc_inspect` first; target by layer id (ids change when a file is reopened, so re-inspect after `doc_open`). Leave unrelated layers and other open documents alone.
2. One property per step when it matters: set rename, opacity, blend in separate calls or verify each (`layer.setProps {layer, name | opacity | fill | blend | clipped | locked}`; opacity is 0..1). After each, re-`doc_inspect` and compare with a tolerance (96 % can read back as 96.078).
3. Preview after every visible change (`render_preview`); zoom to 100 % on edges, skin, type.
4. Long filters and fills run as jobs: poll `jobs_list` before saving or exporting.
5. Save a versioned `.pcraft` (lossless native) before risky steps; export as a copy.

**Non-destructive recipes**

- Structure: a group per subject (`layer.new.group` / `layer.groupLayers`), adjustments inside the group, clipped to the layer they affect with `layer.createClippingMask`. Name every layer (`layer.setProps {name}`).
- Adjustments never touch pixels: `layer.newAdjustmentLayer.{curves, levels, exposure, hueSaturation, colorBalance, selectiveColor, gradientMap, photoFilter, colorLookup, vibrance, blackWhite}`; with a selection active the adjustment is born masked. Colour fills: `layer.newFillLayer.solidColor` / `.gradient`. Avoid the destructive `image.adjustments.*` unless flattening is intended.
- Smart objects keep edits reversible: `layer.smartObjects.convertToSmartObject` before filters or scaling; swap content with `layer.smartObjects.replaceContents` (or `doc_replace_smart_object`), `.editContents` / `.saveContents` for nested work; `layer.smartFilter.*` handles filter masks on them.
- Layer styles for depth: `layer.layerStyle.dropShadow|innerShadow|outerGlow|stroke|colorOverlay|gradientOverlay|bevelEmboss`; reuse with `layer.layerStyle.copyLayerStyle` / `pasteLayerStyle`.

**Cut-out and edge refinement**

1. `select.subject` (or `select.object`, `select.colorRange`, `select.sky`, `select.quick`); inspect the selection in a preview.
2. Clean the selection: `select.modify.smooth`, `select.modify.contract` 1 to 2 px, `select.modify.feather` 0.5 to 1.5 px for photo edges.
3. `select.refineEdge {radius, smartRadius:true, smooth, feather, shiftEdge, decontaminate:true, output:"layerMask"}` writes the result straight into a layer mask (hair and fur: raise radius, paint `refineStrokes`). Alternative: `layer.layerMask.revealSelection` then tune `layer.layerMask.edit {density, feather}` (mask pixels are kept).
4. Judge the cut-out on a dark and a light fill layer (`layer.newFillLayer.solidColor`) at 100 %; halos mean `decontaminate`, `shiftEdge -10..-30`, or a clipped `Hue/Saturation` desaturating the edge. Gap: no dedicated Select and Mask workspace with live view modes; iterate with previews.
5. Hand the mask off: `layer.layerMask.apply` only for final flatten; otherwise keep it live. `layer.layerMask.fromTransparency` builds a mask from existing alpha.

**Retouch**: removals with `edit.contentAwareFill {sampling, margin}` or `paint.remove`; spots with `paint.spotHealing` / `paint.healingBrush` / `paint.patch`, always on an empty layer with sample-all; dodge and burn as a 50 % grey `Overlay` layer using `paint.dodge` / `paint.burn`; frequency separation with two copies and `filter.blur.gaussianBlur` + `filter.other.highPass` (untested); `image.adjustments.shadowsHighlights` is destructive: do it on a smart object.

**Relight and match grade**: `filter.render.relight {angle, elevation, intensity, ambient, warmth, softness}` on a smart-object copy for a quick key-light cue; match to a reference with `image.adjustments.matchColor {source, luminance, intensity, fade, neutralize}` on a duplicate, then rebuild the look as adjustment layers (`curves` for contrast, `colorBalance` for tint, `selectiveColor`, a `photoFilter` for temperature) so it stays editable. A `gradient` layer clipped with `Soft Light` (`layer.newFillLayer.gradient` + `layer.setProps {blend}`) gives directional light. Check against the reference side by side in one preview.

**Sharpen and size**: resize to delivery first (`image.imageSize`, resample bicubicSharper for reduction, `file.automate.fitImage`), then sharpen last (`filter.sharpen.smartSharpen {amount, radius, reduceNoise}` or `filter.other.highPass` set to `Overlay`) on a smart object copy.

**Type**: `type.create` / `type.edit`; check `type.fonts` before delivery (`type.resolveMissingFonts`); outline only in a delivery copy (`type.convertToShape`).

**Export**: `doc_save` to `.pcraft` and a `.psd` for exchange; flats by `doc_export` or CLI; `layer.exportAs {layer, path, scale}` for single assets; `file.export.artboardsToFiles {dir, format}` for social sets; `file.export.quickExport`; batch variants via data sets (`doc_import_data_sets`) or the CLI `batch`. Verify every export: open the PNG, check pixel size, transparency (corner alpha) and colour space; do not trust the reply alone. Alongside a PSD for Photoshop users always ship a flat PNG/TIFF.

**Gaps**: no Camera Raw filter command (develop raw in `lightcraft` and place the TIFF), no Neural filters, no live Select-and-Mask UI, PSD round-trip into real Photoshop is not guaranteed.

---
name: lightcraft
description: Drive LightCraft (open-source Lightroom-class photo library and raw developer) through its MCP tools or CLI - import raw/JPEG photos, develop them (white balance, exposure, tone, curves, colour mixer, grading, detail, lens corrections, crop, masks, spot healing, presets), sync one edit across a batch, HDR/panorama merge, and export JPEG/PNG/TIFF/AVIF/JXL/DNG. Load before any mcp__lightcraft__* call, and whenever a task means developing or batch-correcting photographs.
---

# LightCraft

LightCraft is a non-destructive photo library plus raw developer. Every action is an engine command with an id (`develop.set`, `app.export`, `mask.add`…) and JSON params; the MCP tools wrap those commands. Written against `lightcraft-cli 0.15.0`; workflows below come from the CLI's own help and command catalogue and are **untested here** — check replies and previews, and re-read `command_list` after an update.

Pick it for photographs that need developing (raw files, exposure/colour fixes, a consistent look over a set). For layered compositing or type use `photocraft`; for synthetic graphics use other tools (see `choose-tool`).

## Connect

- The `lightcraft` MCP server runs **headless** (`lightcraft-cli mcp`, an in-process library with no window). Without a `--library DIR` the library lives in memory and disappears with the server, so the deliverable is always an **exported file**.
- To show the user a result: export to an absolute path inside the project, then `craft_launch {app:"lightcraft", files:[path]}` (or open the exported JPEG/PNG with any viewer).
- Bridge-style control of a running app exists (`mcp --connect 127.0.0.1:7980`, app started with `lightcraft --control 7980`) but is not how our server is wired; UI commands are absent headless.
- Shell alternative: `~/.open-herness/bin/lightcraft-cli` — `render IN -o OUT --set light.exposure=0.5 [--set …] [--preset ID] [--size N] [--quality Q] [--opt KEY=VALUE]` develops one file; `run --import PATH cmd key=value … cmd …` chains commands (one JSON line per result; `--library DIR` keeps edits); `controls --json` lists every slider with range; `commands --json` lists ids and params; `merge hdr|panorama|hdr-panorama|hdr-batch FILES…` merges brackets to DNG.

## Tools (headless)

`import {paths}` · `query_photos` · `select_photos {ids, active?}` · `list_controls` · `get_develop {id?}` · `set_develop {values:{control:value}}` · `apply_preset {id, amount?}` · `crop {rect, angle}` · `render_preview` / `render_photo {path?, max_side}` · `export {path | dir, …}` · `doc_inspect` · `command_list` → `command_run {id, params}` / `command_batch {steps}` for everything else (`list_commands`/`run_command` are aliases taking `command`). Started with `--compact` only these helpers are listed; otherwise every command is also a `cmd_<id>` tool.

## Rules

1. **Photos have integer ids; most develop commands act on the active photo.** After `import`, call `query_photos`, then `select_photos` (or pass `id`) before editing. `set_develop`, `crop` and `export` with an explicit id make that photo the only selection.
2. **Discover ranges, don't guess.** `list_controls` (or CLI `controls --json`) gives each slider id, min/max and default. Ids are dotted: `wb.temp`, `light.exposure` (−5…5 EV), `light.highlights|shadows|whites|blacks|contrast` (−100…100), `curve.*`, `color.vibrance|saturation`, `mixer.<colour>.hue|sat|lum`, `grading.shadows|midtones|highlights|global.hue|sat|lum`, `effects.texture|clarity|dehaze`, `vignette.*`, `grain.*`, `detail.sharpen*`, `detail.nr*`, `optics.*`, `geometry.*`, `crop.angle`.
3. **Coordinates are normalised 0..1, origin top-left** — crop rects, mask points, brush strokes, spots.
4. **Look after every step**: `render_preview` (max side 1024–1600) and compare with the original; judge skin, highlights and shadows, not just the histogram.
5. **One edit, many photos**: develop one hero frame, then `develop.copy` → select the rest → `develop.paste`, or `develop.sync {groups?}` across the selection. `develop.matchExposure` evens out a bracket-shot set. Copy skips crop, masks and spot removal by default.
6. **Never overwrite originals.** `export` writes new files; `library.import` with `mode:add` references files in place. Version outputs (`-v01`, `-v02`).

## Workflow

1. `import {paths:[abs folder or files]}` → `query_photos` → pick a hero frame.
2. Base: `command_run develop.wb {mode: asShot|auto|daylight|…|custom, temp?, tint?}`; `develop.profile {id}` (ids from `profiles.list`); `develop.auto` as a starting point, then refine.
3. Tone: exposure → highlights/shadows → whites/blacks → contrast; `develop.curve {channel, points}` for a point curve.
4. Colour: vibrance before saturation; `mixer.*` for individual hues; `grading.*` for split toning; `develop.treatment {bw:true}` + `develop.autoBwMix` for monochrome.
5. Geometry/optics: `crop.autoStraighten`, `geometry.upright {mode:auto|level|vertical|full}`, `optics.*` for distortion, vignetting, chromatic aberration and defringe.
6. Local work: `mask.add {kind: linear|radial|brush|sky|subject|background|luminanceRange|colorRange|object|prompt, …}` then `mask.adjust {values:{exposure, …}}`. Sky/subject/object/prompt masks need the segmentation model (`segment.model.status` / `download`).
7. Cleanup: `spot.findDust`, `spot.add {mode: heal|clone|remove|fill, points}`; `redeye.add`. AI denoise: `denoise.toggle` (needs an installed model, `denoise.models.list`).
8. Batch: copy/paste or sync as in rule 5; or `apply_preset` to the selection.
9. Export: `export {path}` for one or `{dir}` for many, with `format` (jpeg|png|tiff|webp|avif|jxl|psd|dng), `longEdge`/`shortEdge`/`percent` (default long edge 3000; 0 = full size), `quality`, `colorSpace` (srgb for web, displayP3/adobeRgb for print), `bitDepth`. A contact sheet PDF: `export.contactSheet {path, columns, rows}`.
10. Merges: `merge.hdr {ids, deghost}`, `merge.panorama {ids, projection}`, or the CLI `merge` subcommand; results are DNGs next to the first source.

## Known limits

Alpha-stage upstream: camera colour calibration is incomplete (`calibrate` builds per-model profiles from raws plus their embedded JPEGs); some compressed raw variants may fall back to the embedded preview; non-AI subject/sky masks are heuristic. Check the rendered preview, not just the reply.

## Professional workflow

Distilled from how studio-grade agents drive Lightroom-class tools: develop one hero frame carefully, check it numerically and visually, then propagate. Ids below were checked against `lightcraft-cli` 0.15; behaviour beyond their documented params is untested.

1. **Orient**: `import {paths}`, `query_photos`, pick a hero frame, `select_photos`. Never edit by "current photo" after a bulk change; pass `id`.
2. **Base**: `develop.wb {mode:"asShot"|"auto"|"custom"}`, `develop.profile`, `develop.auto` as a start, then manual: exposure, highlights/shadows, whites/blacks, contrast, then vibrance before saturation (`set_develop` with ranges from `list_controls`).
3. **Check, don't trust the eye alone**: `render_preview` at 1024 to 1600 on the original and the edit; judge highlights (no clipped sky), shadows (not plugged), skin (natural hue). Compare with a before copy (`photo.virtualCopy`). Gap: no histogram read id; use the preview and a quick `ffmpeg signalstats` / `sips` check on the render.
4. **Local work**: `mask.add {kind:"subject"|"sky"|"linear"|"radial"|"brush"}`, `mask.refine`, `mask.adjust {values}`, `mask.invert`; for dust and blemishes `spot.findDust`, `spot.add`.
5. **Look consistency**: `develop.copy` from the hero, select the set, `develop.paste` or `develop.sync`; `develop.matchExposure` for brackets; `preset.apply` for house looks; re-check outliers one by one.
6. **Cull and organise** (when asked): `photo.rate`, `photo.flag`, albums (`album.create`), keywords (`keyword.create`, `keyword.suggest`).
7. **Deliver**: `export {path|dir, format, longEdge, quality, colorSpace}` (srgb web, displayP3/adobeRgb print); contact sheet `export.contactSheet`; verify by opening the JPEG: dimensions, colour, no clipping. Version exports; never overwrite originals. Hand an edit to PhotoCraft for layered work by exporting a 16-bit TIFF.

**Gaps**: no snapshots or compare view, no histogram id, no camera calibration beyond what `calibrate` offers, no tethering.

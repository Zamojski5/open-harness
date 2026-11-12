---
name: illustrator
description: Script Adobe Illustrator with ExtendScript — edit an open document or an .ai by path, place and clip artwork, export SVG/PDF/PNG while keeping the editable .ai, vectorize rasters. Use when the user works in Illustrator or needs .ai deliverables.
---

# Illustrator

Status: **untested here** (Illustrator not installed). Proprietary (Adobe subscription). Open alternative: `inkscape`; hand-written SVG for simple marks.

## Clarify up front (skip what the request already says)

- Which document — the one currently open, or a path on disk?
- Output: editable `.ai`, SVG, PDF, PNG (pixel size?) — and should type stay live or be converted to outlines?
- Raster to vector? Options: Illustrator's Image Trace (`placedItem.trace()`, then `tracing.expandTracing()`), local `potrace` (installed here via Homebrew), or a vectorize model through `media_generate` if `media_models` lists one.

## Running scripts

`osascript -e 'tell application "Adobe Illustrator" to do javascript file "/abs/takes/work/edit.jsx"'`. ExtendScript is ES3 without `JSON`; have the script write its findings to a file.

## Rules

- Locate the document by its path (`doc.fullName` across `app.documents`) instead of trusting `app.activeDocument`; don't disturb other open files.
- **Exporting mutates the open document.** After a PNG export the file shows as modified; after an SVG export the document may now point at the `.svg`. Keep the source by calling `doc.saveAs(new File("/abs/x.ai"), new IllustratorSaveOptions())` — `save()` alone after an SVG export writes nothing to the `.ai`. The built-in SVG exporter handles a single artboard per call.
- Coordinate systems vary per file: read `app.coordinateSystem`, `doc.rulerOrigin` and each artboard's rect before positioning.
- Clipping groups: put the art in the group, add the clip path as the topmost item, and only then set `group.clipped = true`. Measure the clip path, not the group — the group's bounds still count the hidden art.
- `doc.pageItems` lists nested items too; iterating groups as well double-counts.
- An `.ai` open with unsaved edits is never overwritten; save a new revision.
- Check SVG/PNG output with `Read` (and `media_inspect` for rasters).

## Limits

No Illustrator MCP here; hosted vectorizing only if a suitable model is available to `media_generate`.

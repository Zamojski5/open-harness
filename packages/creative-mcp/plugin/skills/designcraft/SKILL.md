---
name: designcraft
description: Drive DesignCraft (open-source InDesign-class page-layout app) through its MCP tools or CLI - multi-page documents, parent pages, margins/columns, text and graphic frames, threaded stories, paragraph/character/object/table styles, tables, placed images, data merge, footnotes, TOC, preflight, and export to print PDF (PDF/X-4, X-1a), PNG/JPEG, EPUB, HTML, PPTX and IDML, plus packaging. Load before any mcp__designcraft__* call, and whenever a task means laying out a brochure, flyer, magazine, report, catalogue or other multi-page print/PDF document.
---

# DesignCraft

DesignCraft is a page-layout editor. Every user action is a command (about 540: `frame.create`, `style.paragraph.apply`, `table.*`, `data.merge`, `file.exportPdf`…) with JSON params. Written against `designcraft-cli 0.14.0` from its help and command catalogue; **untested here**.

Pick it for typeset, multi-page or print-ready documents. Single-image social graphics stay with `make-static-graphic`; vector logos with `vectorcraft`; photo retouch with `photocraft`.

## Connect

- The `designcraft` MCP server runs **headless** (`designcraft-cli mcp --automation-read-root DIR --automation-write-root DIR`): reads (open, placed images, data sources, libraries) must be under a read root, writes (save, export, package) under a write root. Roots and `--connect PORT` (drive a running app) are mutually exclusive.
- Desktop-only tools fail headless: `screenshot`, `click`, `drag`, `menu_list`, `ui_inspect`, `ui_set`, `dialog_*`. Look with `render_page`.
- To show the user: `save_document` (native `.designcraft`) and/or export a PDF under the write root, then `craft_launch {app:"designcraft", files:[path]}`.
- Shell alternative `~/.open-herness/bin/designcraft-cli`: `run [--in FILE | --sample] --cmd ID=JSON … [--page N] [--scale S] [--export OUT] [--all-pages DIR]` · `script FILE|- [--in FILE] [--save OUT] [--export OUT]` · `commands [FILTER]` · `describe ID` · `validate-pdf FILE.pdf` (built-in PDF/X-4 checks, incl. unembedded fonts).

## Tools (headless)

`new_document {width, height, …, sample?}` · `open_document` · `inspect_document` (pages, spreads, items with ids/bounds, stories with overset flag, styles) · `list_commands` → `execute {command, params}` / `batch` (stops at the first error; earlier steps stay applied) · `get_story` / `set_story_text {story, text}` (`\n` = paragraph break) · `place_image {path | base64, frame?}` · `render_page {page}` · `export_png` · `save_document` · `select_tool` + `pointer` / `key` / `type_text` / `ime` for tool-driven editing.

## Rules

1. **Units are points (72 pt = 1 in), y down**, in spread coordinates; on a single-page spread the page's top-left is (0,0). Default Letter page 612×792. Set `units`/`preset` (A4, Letter…) in `file.new` from the brief.
2. **Plan the grid first**: margins, columns, gutter and bleed in `file.new` / `layout.marginsAndColumns`; repeated elements on parent pages (`layout.parents.*`, `layout.pages.applyParent`).
3. **Style, don't format by hand**: create paragraph/character styles (`style.paragraph.create`, `style.character.create`) and apply them; use `type.char` only for one-offs.
4. **Check overset** after every text change — `inspect_document` flags overset stories; fix by threading frames, editing copy or adjusting styles, never by shrinking text silently.
5. **Images**: place at sufficient resolution; `preflight.run {minPpi}` reports low-res images, missing fonts/links and other issues.
6. **Look at every page** you touched with `render_page` before export.

## Workflow

1. `new_document` / `execute file.new {preset, units, pages, facingPages, columns, gutter, margins, bleed}`.
2. Parent pages and grid; then frames: `execute frame.create {rect:[x0,y0,x1,y1], content: text|graphic, text?}`.
3. Copy into stories (`set_story_text`), styles applied; tables via `table.*`; images via `place_image` / `file.place`.
4. Variable documents (cards, catalogues, certificates): `data.source.select` → `data.placeholder.add` → `data.merge {csv|path, …}`; read its overset and missing-image counts.
5. Long docs: `toc.*`, `footnote.*`, `xref.*`, `book.*`, `index.*`.
6. `preflight.run`, fix, render pages.
7. Export: `file.exportPdf {path, standard: x4|x1a|none, bleed, marks, pages?}` (then CLI `validate-pdf`); `export_png` per page or CLI `--all-pages DIR`; `file.exportEpub` / `file.exportHtml` / `file.exportPptx` / `file.exportIdml`; hand-off folder with `file.package {dir, idml, pdf}`.

## Professional workflow

Distilled from how studio-grade agents drive InDesign-class layout: grid first, styles not hand formatting, overset and preflight as gates, then a verified PDF. Ids below were checked against `designcraft-cli` 0.14; behaviour beyond their documented params is untested.

1. **Spec**: confirm size, pages, facing pages, bleed, colour (RGB or CMYK), and output (print PDF/X-4, screen PDF, EPUB). `file.new {preset, units, pages, facingPages, columns, gutter, margins, bleed}`.
2. **Grid and parents**: `layout.marginsAndColumns`, parents with `layout.parents.new` / `layout.parents.edit` (folios, running heads, grid lines), apply with `layout.pages.applyParent`; add and reorder pages with `layout.pages.insert|move|duplicateSpread`. Override parent items only deliberately (`layout.overrideParentItems`). Gap: no baseline-grid command found; set `type.gridSettings` / text leading to a common multiple.
3. **Styles**: `style.paragraph.create|edit|apply`, `style.character.*`, `style.object.*`, `style.table.*` and `style.cell.*`; never format by hand except one-offs (`type.char`). Build a type scale (for example 10/14 body, 20/24 H2, 32/36 H1) and a swatch set (`swatch.new`).
4. **Place**: frames with `frame.create`; copy via `set_story_text`; images with `file.place`/`place_image` and `object.fit` / `object.fittingOptions`; tables with `table.insert`, `table.setCell`, `table.setRowHeight`; threads with `text.thread`.
5. **Variable data**: `data.source.select`, `data.placeholder.add`, `data.merge`; read overset and missing-image counts in the reply.
6. **Gates**: `inspect_document` after each text change (overset flag); `preflight.run {minPpi}` for low-res images, missing fonts and links; fix, then `render_page` for every touched page and inspect at 100 % (orphans, widows, rivers, text near the trim).
7. **Export**: `file.exportPdf {path, standard:"x4", bleed, marks}` then CLI `validate-pdf`; `file.exportEpub` for reflow; `file.package` for hand-off with fonts and links; per-page PNG via `export_png`. Verify the PDF by rasterising page 1 and the last page and by `validate-pdf` (fonts embedded).

**Gaps**: no verified one-call "fit frame to content", no TOC/book id checked here, no baseline-grid command, PDF/X validation is built in but a printer's preflight profile is not.

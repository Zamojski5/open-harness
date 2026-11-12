---
name: photoshop
description: Script Adobe Photoshop — edit an open document or a .psd by path with ExtendScript or UXP, manage layers/masks, place generated imagery, deliver layered PSD and flattened exports. Use when the user works in Photoshop or wants a layered .psd deliverable.
---

# Photoshop

Status: **untested here** (Photoshop not installed). Proprietary (Adobe subscription). Open alternatives: `gimp`, `krita`.

## Clarify up front (skip what the request already says)

- Are we working on the document that's open right now, or on a file at some path?
- What comes out: the layered `.psd`, a flat export (which format, how many pixels), or both?
- Is new imagery needed in a layer? Create it with `make-image`, then place it.

## Running scripts

- **ExtendScript (JSX)**: `osascript -e 'tell application "Adobe Photoshop 2025" to do javascript file "/abs/takes/work/edit.jsx"'` (use the installed app name). ES3: no `JSON` object; whatever the final expression evaluates to is returned to AppleScript. The DOM has holes (layer masks, many adjustments) — fill them with **Action Manager** calls (`executeAction`, `executeActionGet`, `stringIDToTypeID`).
- **UXP (`.psjs`)**: `open -a "/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app" /abs/script.psjs`. `open` returns as soon as the file is handed over, not when the script finishes — so the script must leave a result file behind, which we poll for.
- Keep a script on one API. Coverage differs between them (one install lacked `ArtLayer.adjustHueSaturation` while `adjustColorBalance` was there) — test for the call and fall back to Action Manager.

## Rules

- Pick documents and layers by **ID**, and touch nothing else the user has open. Photoshop may restore an unrelated document from crash recovery, and IDs are reassigned when a file is reopened — confirm path and ID right before editing.
- One property change per command. A descriptor that set name and opacity together only renamed the layer. Opacity comes back slightly off (96 → 96.078…), so compare with a tolerance.
- PNG out without switching the working file to it: `doc.saveAs(file, new PNGSaveOptions(), true, Extension.LOWERCASE)` (the `true` = save as copy).
- Never write over a `.psd` the user has open with pending edits; save `name_v002.psd` instead.
- Look at exports with `Read` / `media_inspect`.

## Limits

No Photoshop MCP here. First run needs the user's Adobe sign-in and a macOS Automation permission prompt for the terminal app.

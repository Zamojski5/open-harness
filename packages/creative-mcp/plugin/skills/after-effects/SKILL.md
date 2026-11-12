---
name: after-effects
description: Drive Adobe After Effects from the agent — inspect a project's comps and layers, run ExtendScript (JSX) edits, render frames or a comp with aerender. Use when the user works in After Effects, hands over an .aep, or wants motion graphics delivered as an editable AE project rather than an EffectCraft/Remotion render.
---

# After Effects

Status: **untested here** (After Effects not installed). Proprietary (Adobe subscription). For our own motion work prefer EffectCraft (`effectcraft`), which has a live bridge.

## Detect

`ls -d /Applications/Adobe\ After\ Effects*/` → that folder contains `Adobe After Effects <year>.app` and the **`aerender`** command-line renderer. For AppleScript, the application name equals the folder name (e.g. `"Adobe After Effects 2025"`).

## One-time setup by the user

- In AE's Settings, section _Scripting & Expressions_, the user enables the option that lets scripts write files and use the network. Without it our scripts can't hand results back.
- Right after launch AE may sit on a dialog (crash recovery with Safe Mode/Continue, sign-in). Scripts get no answer until it's dismissed — ask the user to choose **Continue**. We don't launch or quit AE while it holds their work.

## Running JSX (AppleScript → ExtendScript)

```bash
# untested
osascript -e 'tell application "Adobe After Effects 2025" to DoScriptFile "/abs/takes/work/edit.jsx"'
```

Shape of every script we send:

1. Inputs come from a JSON file we wrote. ExtendScript is ES3 — there's no built-in `JSON`, so ship a small parser (e.g. json2.js) next to the script or `eval` data we generated ourselves.
2. Mutations sit between `app.beginUndoGroup(name)` and `app.endUndoGroup()`. That gives the user one Undo step; it does **not** roll back on an exception.
3. Results go to a file (`new File(path)`, `open("w")`, `write`, `close`) that we read afterwards.
   Send calls one after another. If `osascript` times out, AE is probably still working — wait for the result file; re-running doubles the edit.

## Look before changing

The first script lists the project path, each comp (id, name, size, fps, duration) and, for the comp we'll touch, its layers (index, id, name, kind, in/out, parent) with property trees walked through `numProperties` / `property(i)` / `matchName`. Limit depth and record where you stopped, so missing branches aren't mistaken for empty ones.

## JSX notes

- Find things by id: `app.project.itemByID(id)` and `app.project.layerByID(id)` (AE 22+); confirm which comp a layer belongs to.
- Address properties by match name — `ADBE Transform Group`, `ADBE Position`, `ADBE Scale`, `ADBE Opacity`. Rotation of a 2D layer lives at `ADBE Rotate Z`. Effects: `layer.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2")`.
- `KeyframeEase` arrays: Position (spatial) wants a single ease object per side; a 3D Scale wants three.
- `boxText` and `pointText` on a TextDocument can only be read. Create a paragraph layer with `comp.layers.addBoxText([w, h], text)`. Before adding hold keys to Source Text later in time, key the starting text at time 0. After writing an expression, inspect `expressionError`.
- Import and reference media with absolute paths (`app.project.importFile(new ImportOptions(new File("/abs/x.png")))`).
- Opening or creating a project can trigger AE's "save changes?" prompt, which script dialog settings don't suppress. Save first to an explicit path; only close throwaway projects with `CloseOptions.DO_NOT_SAVE_CHANGES`. Never write over an `.aep` that is open with unsaved edits — save `name_v002.aep`.

## Rendering

- Review frames: `comp.saveFrameToPng(t, new File(...))`, then `Read` / `media_frames`.
- Final: `"/Applications/Adobe After Effects 2025/aerender" -project /abs/p.aep -comp "Main" -RStemplate "Best Settings" -OMtemplate "<template exactly as named>" -output /abs/takes/main.mov`; `-s`/`-e` limit the frame range. Read the available output-module template names from the project's render queue in JSX rather than guessing.
- Check the output with `media_inspect`, `media_frames`, `media_review`.

## Limits

No AE bridge or MCP here: every step is AppleScript `DoScriptFile` + files + `aerender`. Long jobs have no job id to poll — watch for the result/output file.

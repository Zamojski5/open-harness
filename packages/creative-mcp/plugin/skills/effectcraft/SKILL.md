---
name: effectcraft
description: Drive EffectCraft (open-source After Effects-class compositor) through its MCP tools - comps, precomps, text animators, shape layers, masks and track mattes, 3D camera/lights, expressions, effects (glow, light rays, particles, fog, lightning, grading, film look), footage/Blender plates, render queue to MP4/ProRes/PNG/GIF/Lottie. Load before any mcp__effectcraft__* call or effectcraft_launch, and whenever a task involves motion graphics, titles, compositing or finishing a render in EffectCraft.
---

# EffectCraft

EffectCraft is an After Effects-style compositor. Every action is an engine command with a stable id and JSON params; the MCP tools wrap those commands. The scripting model (`run_script`) mirrors After Effects ExtendScript (`app.project`, `comp.layers.addText`, `property("ADBE Transform Group")`…).

## Connect

- In Open Herness the `effectcraft` MCP server is **bridged** to the desktop app (port 9877). Call `effectcraft_launch` (creative MCP) first — it opens EffectCraft with its control channel or reuses the running one; pass `files` to open an `.ecproj` or import media (only on a fresh launch — if the app is already running, `files` are ignored; use `open_project` / `file.import` instead). Then use `mcp__effectcraft__*` tools. The user sees every change live.
- Bridge-only tools: `screenshot {panel?}`, `ui_*`, `control`. Headless sessions do not have them; use `render_preview` there.
- **Headless CLI** for work that must not touch the user's window (experiments, long renders, batch variants): `~/.open-herness/bin/effectcraft-cli` (`run`, `set`, `get`, `props`, `render-frame`, `render`, `script --eval`, `mcp`). Every invocation is a fresh engine; persist with `--save-as F.ecproj` / `--save`. Without `--empty`/a project it opens the demo project. See [references/footage-and-render.md](references/footage-and-render.md#headless-cli).
- Render long sequences with the CLI in the background (`run_in_background`) from a saved project instead of blocking the bridged window.
- More CLI entry points: `exec <id> --params '{json}' --project F.ecproj --save` runs one engine command; `script FILE.jsx --empty --save-as F.ecproj` builds a project from an After Effects-style JavaScript file (good for generated variants); `render --project F --comp NAME --out F.webm --format webm --channels rgba` gives transparent web video.
- Headless MCP launch flags (0.17): `mcp [--empty | --demo | --project F] [--autosave] [--gpu] [--automation-read-root DIR] [--automation-write-root DIR]`. With roots set, reads must sit under a read or write root and writes under a write root, and **scripts are refused** — `run_script` is unavailable in a confined session. `--bridge PORT` instead attaches to a running app (our setup, above).
- Not supported: After Effects project files (`.aep` / `.aepx`) and After Effects plug-ins. Rebuild the comp from its parts (footage, text, shapes) instead of trying to open one; tell the user up front.

## Rules that prevent most failures

1. **Orient first**: `doc_inspect` (or `get_project` → `get_comp`). Never assume an empty project; never `open_project`/`file.newProject` over unsaved user work — `save_project` first or ask.
2. **Name every layer at creation** (`name` param on `layer.new*`) and reference layers by name. Layer ids are not sequential (a comp may give ids 4, 35, 66…).
3. **Discover before guessing**: `command_list {filter}` → `describe_command {command}` for params; `list_effects {filter}` for effect ids and parameter ids; `get_layer {layer, flat:true}` for exact property paths. Unknown param keys are rejected with the accepted list — read the error and fix.
4. **Effect points are in effect space**, pixels — not the normalized defaults `list_effects` shows. On solids, adjustment layers and footage that is the layer's pixel grid (= comp pixels for a comp-sized layer). On **text and shape layers** the effect space is comp-sized but centred on the layer's origin: `[w/2, h/2]` means the layer's anchor. Put point-driven generators (light rays, lens flare, lightning) on a solid or adjustment layer.
5. **Time**: `add_keyframe`/`set_property` take layer time (= comp time unless the layer is offset; pass `timeBase:"comp"` otherwise). `render_preview`/`get_property` take comp time. `run_script` `setValueAtTime` uses comp time.
6. **Look after every step**: `render_preview {time, max_side: 640–960}` at the frame where the change matters (mid-animation, not only the end), and `screenshot` when the UI state matters. Check `evaluated` and `expressionError` in replies after setting expressions.
7. **Save at milestones**: `save_project {path: "<project>/effectcraft/<name>.ecproj"}`. Version file names for takes (`title-v01.ecproj`, `-v02`); never overwrite a take.
8. **One logical edit = one undo step**: group multi-step builds with `batch {steps:[{command, params}]}` (atomic, `"$1.layer"` refers to step 1's result) or `run_script` wrapped in `app.beginUndoGroup()/endUndoGroup()`.

## Workflow

1. Plan: comp size/fps/duration from the delivery spec (see make-motion-graphics for platform specs). 1920×1080 @ 30 fps default; 24 fps for cinematic; 1080×1920 for vertical.
2. Build structure: background → plates/footage → elements → controller null(s) → adjustment layers for grade and film look on top. Precompose groups that move together or get a shared effect.
3. Animate with eased keyframes; drive repeating or linked motion with expressions tied to Slider Controls on a `CTRL` null.
4. Effects last, from the recipes, tuned against previews.
5. Preview 3–5 key frames, fix, then render a draft (half resolution) and review with `media_frames`; final render at full resolution.
6. Save `.ecproj`; report the output paths.

## References (tested recipes, exact ids and paths)

- [project-structure.md](references/project-structure.md) — comps, precomps, nulls/parenting, adjustment layers, timing, blend modes, masks, track mattes, 3D layers, camera, lights, motion blur.
- [text-and-shapes.md](references/text-and-shapes.md) — text layers, fonts (Polish diacritics OK), text animators + range selectors, shape layers, trim paths, repeater, gradients.
- [animation-and-expressions.md](references/animation-and-expressions.md) — keyframes, easing (easyEase, velocity/influence, hold), expressions (wiggle, time, loopOut, Slider links), `run_script`.
- [effect-recipes.md](references/effect-recipes.md) — glow, light rays, light sweep/sheen, particles, fractal-noise fog, lightning + flash, grading stack, film look (grain, vignette, aberration, letterbox), shadows, blurs.
- [footage-and-render.md](references/footage-and-render.md) — importing Blender renders (PNG/EXR sequences, MP4), render queue (H.264, ProRes 4444 alpha, PNG sequence, GIF, WebM), Lottie export, saving, CLI.
- [known-issues.md](references/known-issues.md) — what is broken, weak or surprising in EffectCraft 0.17; read before blaming your own params.

## Professional workflow

Distilled from how a studio-grade agent drives After Effects: inspect with bounded output, edit under a receipt, look at several frames, render to a staging name, verify the file. Command ids below were checked against the `effectcraft-cli` catalogue; parameter behaviour not already covered by the references is untested.

**Ask or settle first** (skip what the brief answers): delivery (size, fps, duration, alpha or not, loop), project path to use or create, which assets are real files (absolute paths) and which are generated.

**Session loop (every task)**

1. Orient with bounded reads: `doc_inspect` / `comp.info` for ids, then `layer.tree` or `get_layer {layer, flat:true}` for one layer. If a tree reply is truncated, narrow to one layer or raise depth; omitted data is not absent data.
2. Target by name or id, never "the selected layer". Before editing a saved project confirm the open project is the one you mean (`file.save` target path from `doc_inspect`); never `file.newProject` / `open_project` over unsaved work.
3. Snapshot before a large change: `file.incrementAndSave` (writes `name-v02.ecproj`). Edits are undo steps, not transactions: a failed multi-step build leaves earlier steps applied, so wrap builds in `batch` or `run_script` with `app.beginUndoGroup()` / `endUndoGroup()` and read the result object it returns.
4. Read the receipt: the reply of every edit carries `evaluated` / `expressionError` / warnings. A scripted build should end with a plain-data `result` (ids, names, final values) you check, not just "no error".
5. Look: `render_preview` at three or more times (first frame, mid-animation, last frame; a contact sheet if you can) at `max_side` 960; review at 100 % of the area that matters (type edges, glow banding, mattes). Gap: no built-in contact-sheet command; render the frames with `render-frame --time` in a loop and tile them with `ffmpeg -i f%d.png -filter_complex tile=3x1`.
6. Never block on a long job twice: start the CLI `render` in the background, poll for the file, do not relaunch because it is slow.

**Structure recipe** (see [project-structure.md](references/project-structure.md))

- Layer order bottom to top: background solid, plates/footage, hero elements, precomps, one `CTRL` null (`layer.newNull`) holding slider controls, adjustment layers for grade and film look (`layer.newAdjustment`).
- Precompose anything that moves together or needs one shared effect: `layer.precompose {layers, name, mode:"move"}`. Name comps by role (`Main`, `Title Pre`, `Bg Pre`) and keep one hero comp as the render target. Parent with `layer.setParent`; centre pivots first with `layer.centerAnchor` before rotating or scaling.
- Trim waste: `comp.trimToWorkArea`, `file.removeUnusedFootage`; collect assets for hand-off with `file.collectFiles {folder}`.

**Motion recipe** (see [animation-and-expressions.md](references/animation-and-expressions.md))

- Every move gets easing: `add_keyframe {interpolation:"easyEase"}`, or shape the curve with `keys.setEase {layer, path, time, side, speed, influence}` and `keys.velocity`. Entrances: out-influence 0 to 33 on the first key, in-influence 75 to 90 on the last (fast in, soft landing). Never leave default linear on position or scale except for constant-speed loops. `keys.smooth` and `keys.wiggle` clean up or add jitter to a sampled path; `motion.sketch` records a hand-drawn path.
- Stagger instead of copying: offset layers with `layer.timing` / `layer.slip`, or drive offsets with an expression reading a Slider on `CTRL`. Loops: `loopOut("cycle")` and keys that match at both ends.
- Motion blur needs both switches: `layer.setSwitch {switch:"motionBlur"}` on the layer and `comp.setSwitch {switch:"motionBlur", value:true}`; shutter is `comp.settings {shutterAngle}` (180 is film default, 360 for fast whips).
- Time remap and speed: `layer.enableTimeRemap`, `layer.timeStretch {percent | duration}`, `layer.freezeFrame`.
- Expressions: set through `set_property {expression}`; always read back `evaluated` and `expressionError`; use `layer.revealExpressionErrors` to list failing ones. A missing reference fails soft and renders the static value.

**Look recipe** (see [effect-recipes.md](references/effect-recipes.md)): grade on an adjustment layer at the top, grain and vignette last, 8-bit banding checked on gradients (add noise or grain before delivery); blend modes via `layer.setBlendMode`; mattes via `layer.setTrackMatte {layer, matte, kind}`; masks via `layer.addMask` / `mask.new` with `layer.mask.featherFalloff` for soft edges.

**Render recipe** (see [footage-and-render.md](references/footage-and-render.md))

1. Draft: `renderQueue.add {comp, format:"h264", resolution:"half", quality:"draft", output:<abs path>-draft.mp4}` then `renderQueue.render`, or CLI `render --resolution half --quality draft`. Check with `renderQueue.list`.
2. Final: `renderQueue.setRenderSettings {quality:"best", resolution:"full", motionBlur:true, colorDepth:...}` and `renderQueue.setOutputModule {format, channels:"rgba" for alpha, proresProfile:"4444", bitrate}`; reuse settings with `renderQueue.saveTemplate` / `renderQueue.applyTemplate`. Query `renderQueue.templates` and `renderQueue.formats` instead of assuming names. Segments: `timeSpan` / CLI `--start --end`.
3. Stills and covers: `comp.saveFrameAs {path, time}`, `comp.setPosterTime`. Lottie: `file.exportLottie {comp, path}` and read its warnings.
4. Verify, do not assume: `ffprobe` size, fps, duration, codec, alpha (`pix_fmt` with alpha for ProRes 4444/WebM); decode one frame (`ffmpeg -v error -i out.mp4 -frames:v 1 -f null -`); pull a frame at 100 % and inspect. Never overwrite an existing take: new versioned output name each time.

**Gaps**: no `.aep` import, no contact-sheet or job-status verb (poll the output file), no per-comp render-farm job ids, scripts unavailable in confined headless sessions. When `ae`-style ExtendScript is wanted, `run_script` / CLI `script FILE.jsx` is the equivalent; remember ExtendScript is ES3 style (no JSON global; use the return value) and AE property match names such as `ADBE Transform Group`.

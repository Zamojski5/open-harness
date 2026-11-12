---
name: craft-pro
description: Cross-app studio recipes for the open-source Craft apps (PhotoCraft, VectorCraft, LightCraft, EffectCraft, FilmCraft, DesignCraft) - key-visual composite, social motion piece, banner/asset system and edited video - with the hand-offs between apps and the verification to run at each step (what to render, screenshot or probe, and at what zoom). Load when a job spans two or more Craft apps or must reach professional, deliverable quality; load the per-app skill for command details.
---

# Craft Pro: studio pipelines on the Craft apps

Use this when the job crosses apps. Each app's own skill (`photocraft`, `vectorcraft`, `lightcraft`, `effectcraft`, `filmcraft`, `designcraft`) holds command ids and its "Professional workflow" section; this skill holds the order of work, the hand-offs and the gates.

## Principles (apply to every recipe)

1. **One brief, written down**: size, fps, duration, formats, colour space, safe zones, copy, brand tokens (`brand-kit`). Reread it before every export.
2. **Every stage ends in a file on disk**, with an absolute path, versioned (`-v01`, `-v02`), kept under `takes/` or the project folder. Never overwrite a source or an earlier take. Hand-offs between apps are files, not memory.
3. **Look before you move on.** After each stage render the thing and view it; a reply saying "ok" is not evidence. Zoom to 100 % on the places that fail first: edges and cut-outs, small type, gradients (banding), alpha edges, cut points, corners of the frame.
4. **Probe every deliverable** with tools, not eyes only: `ffprobe` (size, fps, duration, codec, pixel format with alpha, audio streams), a decode test (`ffmpeg -v error -i FILE -f null -`), image size and alpha of PNGs (`sips -g pixelWidth -g pixelHeight -g hasAlpha FILE`), PDF checks (`designcraft-cli validate-pdf`).
5. **Receipts**: end each stage by writing down, in your reply, the input files, the commands or ids that made the output, the output path, size, and what you checked and found. If a check fails, say so and fix; do not report success on a blind step.
6. **Headless apps have no window.** Use each app's render or preview tool for looking (`render_preview`, `render_frame`, `render_page`); the live screenshot tools exist only when an app is bridged (currently EffectCraft). Show the user results with `craft_launch {app, files}` after saving.
7. **Serial, not parallel, on one project.** One writer per project file; long renders go to the background CLI from a saved project and are polled, not repeated.
8. **Text stays live until the last step**, then outline or flatten on a delivery copy and keep the master.

## Recipe A: key visual (KV) composite

Goal: a still hero image with photo, cut-out subject, vector brand marks and type, delivered in several sizes.

1. **Develop the photo** (LightCraft): `import`, base tone and colour on the hero frame, local masks for subject and sky, `export` a 16-bit TIFF (full size, srgb or displayP3). Check: preview of before and after; no clipped highlights.
2. **Brand marks** (VectorCraft): build or clean the logo and graphic shapes on a 1:1 artboard; outline type; `document.export` SVG and a PNG at 2x with transparency. Check: PNG corners are transparent; shapes crisp at 100 %.
3. **Composite** (PhotoCraft): new document at the largest delivery size; place the TIFF as a smart object (`doc_place`); cut the subject (`select.subject` then `select.refineEdge` with `output:"layerMask"` and `decontaminate`); put backdrop, shadow and light layers beneath (`layer.newFillLayer.gradient`, `layer.layerStyle.dropShadow`, a clipped Soft Light gradient); match grade with adjustment layers clipped to groups; place the logo PNG as a smart object; type via `type.create`. Check: edge halo test on a dark and a light fill at 100 %; type at 100 %; look at the whole at fit size for balance and focal point.
4. **Variants**: duplicate the group structure per ratio (`image.canvasSize`, `file.export.artboardsToFiles`, or CLI `batch`), reposition per safe zone; a data-set CSV for copy variants (`doc_import_data_sets`). Check: contact sheet of all sizes side by side (tile with `ffmpeg -filter_complex tile`), titles inside safe areas.
5. **Deliver**: `doc_save` `.pcraft` master (and `.psd` for exchange), flat PNG/JPEG per size (sRGB). Probe sizes and file weight; open each export.

## Recipe B: social motion piece (vertical, 6 to 15 s)

Goal: a branded vertical video with animated type, footage or stills, music optional.

1. **Assets**: stills from Recipe A (flat PNG, or layers exported with `layer.exportAs`), logos from VectorCraft as SVG/PNG, footage from `edit-video`. Absolute paths only.
2. **Build** (EffectCraft): `comp.new` 1080x1920, 30 fps; bg, plates, hero elements, `CTRL` null, grade adjustment layer, grain/vignette last. Titles with text animators; every move eased (`keys.setEase`), motion blur on layer and comp. Check: `render_preview` at the first frame, the end of each entrance, the hold and the last frame; type inside the platform UI safe area (about 150 px top, 340 px bottom on 1080x1920).
3. **Draft render** (half resolution) through `renderQueue` or CLI `render --resolution half --quality draft`; watch frames with `media_frames`/`ffmpeg` at several times; check pacing against the music beat if any.
4. **Final**: full resolution H.264 with a loudness-safe audio mix (add the track in FilmCraft or mux with ffmpeg); for overlays ProRes 4444 or WebM with alpha. Verify with `ffprobe` and one decoded frame; check loop continuity by comparing first and last frames if it is a loop.
5. **Version and report**: `.ecproj` saved, outputs in `takes/`, paths listed.

## Recipe C: banner and asset system

Goal: one master design expanded to many sizes, each pixel-exact.

1. **Master in VectorCraft**: one artboard per size (`artboard.new`, `artboard.duplicate`), global swatches and fonts from the brand kit, symbols for the logo, type outlined only in the delivery copy.
2. **Raster pieces** (photo, texture) come from PhotoCraft or LightCraft as PNG/JPEG at 2x, placed (`file.place`) and clipped (`object.clippingMask.make`).
3. **Export set**: `document.exportForScreens {folder, scale}` for PNG/WebP/SVG; convert to JPEG where needed. For animated banners, rebuild the master in EffectCraft with the same layout and export GIF or WebM (`renderQueue.add` format `gif`), keeping file size under the network limit (check with `ls -l`).
4. **Checks**: contact sheet of every size; per size confirm exact pixel dimensions (`sips -g pixelWidth -g pixelHeight`), legible type at the smallest size at 100 %, logo clear-space respected, file weight under limit. For print, DesignCraft: `file.exportPdf standard:"x4"` with bleed, `preflight.run`, `validate-pdf`.

## Recipe D: edit (interview, promo or recap)

Goal: an editable cut with titles, grade and mix, plus delivery files.

1. **Select the takes** by reviewing footage locally first (`edit-video`), not by guessing; keep a list of in/out points.
2. **Assemble** (FilmCraft): `file.newSequence` at the delivery spec; `media_import`; `timeline.place`; link audio; roughly cut, then trim (`timeline.trim`, `timeline.roll`, `edit.rippleDelete`, `sequence.closeGap`). Check: `render_frame` on both sides of each cut; no flash frames, jump cuts hidden or intentional.
3. **Graphics**: lower thirds and titles with `graphics.newText` (live text) or an EffectCraft render with alpha placed on V3 (`file.import`, ProRes 4444). Check: titles at 100 % inside safe margins.
4. **Colour**: `lumetri.applyMatch` across shots, a look, then scopes: `scopes.read`. Check skin and whites.
5. **Sound**: tag clips (`essentialSound.setType`), level dialogue (`essentialSound.autoMatch`), duck music (`essentialSound.generateDucking`), fades at the ends. Check by exporting and measuring loudness (`ffmpeg -i out.mp4 -af ebur128 -f null -`), peak below -1 dBTP.
6. **Export** (`file.exportMedia {preset}`) a master and a delivery; for sidecar captions use `captions.export`. Verify: `ffprobe`, decode test, first/last frame, playback of the cuts and the end card; report paths.

## Verification checklist (before saying done)

- Output opens (decode test passes) and has the required size, fps, duration, codec, alpha, colour space.
- Viewed at 100 % in the areas that usually break; contact sheet viewed for sets.
- Text is correct in every language used (diacritics render), no overset, no missing fonts, no placeholder copy.
- Source files untouched; every take versioned; absolute paths reported.
- Known limits of the apps stated to the user (Photoshop/Illustrator round-trip, EffectCraft `.aep`, FilmCraft XML import, no headless screenshot).

- AI boosts (relight, detail, upscale, inpaint, matte, interpolate, HDR...) on a finished asset: see `ai-boost` for the order, settings and mandatory before/after checks.

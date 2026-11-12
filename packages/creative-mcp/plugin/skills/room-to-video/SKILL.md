---
name: room-to-video
description: Reconstruct a real room from 2-48 overlapping phone photos or video frames (hosted VGGT) into an editable Blender scene of calibrated cameras and observed surface patches, author a camera tour, render RGB/depth guide videos, and optionally restyle the tour with a render-to-real video model. Use when the user wants a walkthrough/flythrough of their actual room or flat, a 3D version of a captured space, or a restyled interior video from their own photos.
---

# Room to video

Tools: `media_generate` (any fal endpoint) + `media_estimate` + `jobs_wait`, `blender_script` / `blender_exec` / `blender_render` / `blender_save`, ffmpeg, and [scripts/prepare_capture.py](scripts/prepare_capture.py) (Pillow). Blender's own Python has NumPy for the import step. Paid jobs follow [paid generation](../choose-media-model/references/paid-generation.md).

## Capture

- **2–48 overlapping views**, in a deliberate order. From phone video, extract the frames you want (`ffmpeg -ss <t> -i phone.mp4 -frames:v 1 …`) and keep the source video and each frame's timestamp in the ordered source list.
- **Connected rooms**: include the doorway/hallway transitions and reconstruct them as one set. A room label only names frames; it does nothing for alignment. Two separate reconstructions have no common scale or layout, so don't quietly merge them into something presented as a measured plan.
- More on choosing captures and diagnosing geometry: [references/capture-and-geometry.md](references/capture-and-geometry.md).

## Pipeline

1. **Prepare** into a new folder: `python3 scripts/prepare_capture.py --project room-project --sources capture-sources.json` → preserved sources, upright 518×518 model inputs, `capture.json`, `request.json`.
2. **Reconstruct**: `media_estimate` then `media_generate` with exactly that request (model `fal-ai/vggt-1b`, the prepared frames as references in manifest order, prediction data + depth maps + point cloud exported, base64 arrays). Submit unchanged — no extra crops, rotations or provider-side video sampling — so cameras and depth stay tied to the right images. Check `media_model_schema fal-ai/vggt-1b` first and confirm in `media_provenance` that the frames went to `image_urls` in order (if not, pass them in `input.image_urls`). **Known gap:** `media_generate` downloads the URL outputs (prediction JSON, depth PNGs, point-cloud GLB) but does not keep the raw response body, where VGGT returns the per-frame `extrinsics`/`intrinsics`. Before paying, check whether the prediction JSON files carry the cameras; if they don't, the import has no cameras — tell the user this pipeline step is blocked rather than guessing poses.
3. **Import into Blender** (`blender_script`, new `.blend` name): calibrated source cameras + per-view observed surface meshes — method and numbers in [references/reconstruction-and-render.md](references/reconstruction-and-render.md). Changing mesh sampling later re-imports from the kept outputs into a new scene name; no second paid reconstruction.
4. **Author the tour camera**: a new camera (e.g. "Room tour") keyed from the source cameras' positions, saved under a new scene name so the previous revision survives. Check coverage from that camera: unseen surfaces show as holes.
5. **Render the guide**: RGB (and, for a depth-controlled model, a depth pass) through `blender_render` to new output names — numbers in the reference.
6. **Restyle (optional, paid)**: a render-to-real video model with a first-frame style image — see the reference.

## What the reconstruction is

What you get is calibrated cameras plus textured **observed surface patches**: no walls-and-doors semantics, no closed volumes. The materials carry the captured appearance and lighting. Reflections, blur, unseen surfaces and inconsistent observations leave holes or overlaps. Keep anything you infer (patched walls, added furniture) in the `Inferred additions` collection, separate from captured evidence. Its units are model units, not checked metres — only an external scale reference plus validation supports a measurement.

## Preserve and deliver

New scene and output names every time; never overwrite a render. Tell the user which of three things they are getting: the editable captured room, geometry you inferred, or a generated restyle video. The restyle leaves the Blender scene unchanged; a restyled _editable_ room needs actual scene and material work, reviewed separately.

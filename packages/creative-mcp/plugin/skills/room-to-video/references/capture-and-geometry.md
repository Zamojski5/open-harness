# Capture, geometry and fidelity

## The image-to-geometry contract

- Preparation copies each selected image and each source video once, makes it upright from its EXIF orientation (Blender's pixel loader ignores EXIF, so this must happen before), letterboxes it onto a square **518×518** canvas, and records the hashes and the content rectangle in `capture.json`.
- Submit those prepared images in the recorded order. Raw predictions, depth maps and cameras refer to the 518 canvas, not the phone's original pixel size; the content rectangle tells you which canvas pixels are real image.
- `seconds` and `video` keep the extraction link; `room` labels never merge coordinates.
- Different inputs (order or pixels) mean a fresh project and a fresh reconstruction; an old response is never relabelled to fit.

## What is editable

- `Captured surfaces`: one depth-patch mesh per view, textured with that view's image. Low-texture walls can disappear because the confidence filter drops them. Before you lower the cutoff or invent a repair, look at the hole in the source photos and in the raw depth.
- Fix visibility by choosing which patches show from the tour camera, or add explicit repairs in `Inferred additions`.
- The point-cloud GLB from the provider is for inspection, not an editable architectural asset.

## Reference

Hosted VGGT schema (outputs, array encoding, frame order, depth representation): https://fal.ai/models/fal-ai/vggt-1b/api — submit through `media_generate`, not the page's SDK.

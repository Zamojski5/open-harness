# Import, guide renders and restyle

No bundled import/render helper exists here; write the import as a `blender_script` following these conventions, and save it in the project so the next import reuses it.

## Coordinate conventions

- VGGT extrinsics are 3×4 world-to-camera matrices in OpenCV axes (x right, y down, z forward). Check each rotation is orthonormal with positive determinant. Camera-to-world = inverse of the 4×4 extrinsic.
- To Blender world (z up): pre-multiply by `[[1,0,0],[0,0,1],[0,-1,0]]` (as a 4×4). A Blender camera looks down −z with y up, so post-multiply the camera matrix by `diag(1,-1,-1,1)`.
- Intrinsics (pinhole, no skew) on the 518 canvas → Blender camera:

```python
def calibrate(scene, cam, K, w=518, h=518):
    fx, fy, cx, cy = K[0][0], K[1][1], K[0][2], K[1][2]
    r = fx / fy
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = w, h, 100
    scene.render.pixel_aspect_x, scene.render.pixel_aspect_y = max(1, 1 / r), max(1, r)
    cam.data.sensor_fit, cam.data.sensor_width = "HORIZONTAL", 36
    cam.data.lens = fx * 36 / w
    cam.data.shift_x = (w / 2 - cx - 0.5) / w
    cam.data.shift_y = (cy + 0.5 - h / 2) * r / w
```

## Import (one mesh per view)

- Collections: `Source cameras` (objects `frame-0001`, `frame-0002`, … — calibrated as above), `Captured surfaces`, `Inferred additions` (empty, for repairs).
- Per view: decode the depth (and confidence, mask) arrays from the prediction data (base64 + shape + dtype); keep pixels that are finite, > 0, inside the content rectangle, inside the mask, and at or above the **confidence percentile** cutoff (default 10).
- Sample the depth grid every **stride** pixels (default 4); back-project with K⁻¹ and the camera-to-world transform; triangulate neighbouring samples; drop triangles touching an invalid sample or spanning a depth jump larger than the **discontinuity** ratio (default 0.1: max depth > min depth × 1.1).
- UVs map each vertex to its canvas pixel; material = that view's prepared image → Emission (captured light, not re-lit). Pack the images so the `.blend` is self-contained. Tag objects as "observed depth surface, not semantic or watertight".
- Write the copied predictions and associations next to the scene (e.g. `reconstruction/<scene>/`) so a later import with different stride/confidence needs no new paid job.

## Guide renders

- One frame (PNG) or a range (MP4, inclusive frame range, e.g. 1–121 at 24 fps) from the tour camera via `blender_render`; new output names; keep the frame checkpoints so an interrupted render resumes (only valid for a self-contained scene — external assets break reuse; never mix CPU and GPU frames in one resume).
- **Depth pass** (only for a model that takes depth control): linear camera-axis depth mapped with one fixed near/far for the whole shot (e.g. near 0.1, far 100), **near = white, far/background = black**, rendered as 16-bit PNG frames. The MP4 of it is compressed guidance; the 16-bit PNGs are the precise version.
- RGB and depth must share camera, framing, timing and mapping.

## Restyle with render-to-real (paid)

1. Make a first-frame style image aligned with the guide's first frame (`make-image` edit of the actual first camera view), preserving openings and perspective: `style-first.png`.
2. `media_generate` with the guide as `video` and the style frame as the reference, e.g. model `fal-ai/ltx-2.3-quality/render-to-real`, prompt starting with its trigger `3DREAL.` and stating what must be preserved ("keep the camera path, the room's proportions and where doors and windows are; carry the first frame's materials through every frame"), native `input` such as `intensity: "light"`, `resolution: "720p"`, `num_frames: 121`, `frames_per_second: 24`, `generate_audio: false`. Read `media_model_schema` first — resolution/frame budgets cap clip length.
3. The style image anchors frame one only; it is not a sequence of timed references. Render-to-real takes the RGB guide; feed depth solely to models documented to take depth control. For another model, write the prompt in that model's syntax (`make-ai-video` model prompting).

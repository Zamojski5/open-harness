---
name: ai-boost
description: Fix one named weakness of an approved asset with a narrow AI model (relight, detail, upscale, cleanup, extend, matte, depth, interpolation, HDR, denoise) in the right order, with mandatory before/after checks.
---

# AI boost

A boost is one narrow model call that fixes one named weakness in an otherwise approved asset. It is never a restyle. The model table (endpoint ids, inputs, prices, verified 2026-10-30) is in [references/models.md](references/models.md); confirm with `media_model_schema` and `media_estimate` before any paid run.

## Rules

1. **Name the defect first** (flat light, mushy texture, banding, wrong size, stray object). No defect, no boost. Fix it at the source (re-render, re-light in Blender) when that is cheaper than a model.
2. **Boosts go last and in this order** (skip what you do not need): cleanup/inpaint -> outpaint/extend -> denoise/deblur -> relight -> detail/skin -> **upscale (once)** -> grain match -> HDR / interpolation for video. Composite and text/logos come after the boosts or are re-applied on top of them from vector/original sources.
3. **GPT Image is the default for photographic edits** (`openai/gpt-image-2.5/flare/edit`, `sunburst` for hard cases; our direct OpenAI route has no references). Use a `mask_url` to confine it. Nano Banana is the cheap draft fallback. For upscale/denoise/matte/interpolation use the dedicated models, not GPT.
4. **One boost per call, lowest strength that works**, a fixed seed where offered, take #1 judged before spending on more. Report price from `media_estimate` first; stay under the user's cap.
5. **Never upscale twice, and only what is kept.** Upscale the take the user keeps, from the original render/plate, at the final delivery size, once (`media_upscale` for video takes: quoted, approved like any paid batch). Keep the pre-boost file; boosts are takes, never overwrites.

## Mandatory checks after every boost

- `takes_compare` before/after, viewed at **100 %** on the face/product/edge areas and a flat area (noise, banding), not only fit-to-screen.
- Product geometry, silhouette, logo, label and identity unchanged (overlay or flicker-compare the two; for video check first, middle and last frames).
- **No new text, no new objects, no extra fingers/limbs**; existing text still correct.
- Grain and sharpness match the neighbouring footage/plates (add grain after upscaling; do not over-sharpen halos).
- Colour and exposure unchanged unless relighting was the goal (compare histograms or a gray patch).
- Video: `media_flicker` / scrub for temporal shimmer; output fps, duration, audio, codec preserved.
- If any check fails: halve strength or mask the area; if it fails twice, drop the boost and fix at the source.

## By pipeline

**Blender still / animation** (render is the ground truth; see `blender`): render clean at the target pixel size with denoised Cycles, then in order: relight is almost never needed (change lights in the scene); detail - only for weak textures, use the CGI model of Topaz precision or generative at creativity 1-2; upscale 2x with `topaz/upscale/image/precision` (model CGI) for stills; animation: `topaz/upscale/video/precision` (Proteus, `recover_detail` low) or render natively larger; fill render frame rate gaps with `topaz/interpolate/video` or `fal-ai/film/video`. Depth/normal for compositing come from real Z/Normal passes, not Marigold. Keep alpha: render PNG with film transparent and matte only if no alpha exists.

**EffectCraft comp** (see `effectcraft`): matte plates with `fal-ai/birefnet/v2` (Matting) or the video variant to PRORES4444; depth plates from Blender or `depth-anything-video` for fog/DoF; relight a composite so elements belong together by relighting the _foreground element_ (`iclight-v2` with mask, or GPT edit with a masked lighting prompt: direction, colour temperature, bounce) and check contact shadows; final: grain match in the comp, then one upscale.

**PhotoCraft key visual** (see `photocraft`, `craft-pro`): generate/edit the base with GPT Image at 1K-2K, cleanup with mask edits (`object-removal`/`qwen inpaint`), extend canvas with `flux-2-pro/outpaint` for other aspect ratios, then one `topaz/upscale/image/precision` to print size. Type and logos are laid on after upscaling from vectors.

**LightCraft photo**: sequence = denoise/restore (`topaz/restore/image`) -> relight/skin only if the grade cannot (`fal-ai/retoucher` or Topaz `face_enhancement_strength` <= 0.5; keep pores) -> upscale -> grade and grain locally. Photos of real people: identity unchanged is a hard gate; get consent for generative face work.

**Video edit** (see `edit-video`): denoise/deblur -> relight (`minimax/h3-max/relight` with a `reference_image_url`) only for clips <= 15 s -> upscale (Topaz precision, faithful; generative only for AI clips) -> interpolate -> SDR to HDR last and only for an HDR deliverable. Boost clip by clip, not the whole timeline, and keep the audio from the original.

## Settings that rarely need changing

Topaz precision: Standard V2 for photos, CGI for renders, factor 2, `sharpen` 0, `denoise` <= 0.2. Generative upscale: `creativity` 1-2, `texture` 2. GPT edit: `quality` high (medium for drafts), mask edges feathered, one change per prompt, prompt ends with "keep everything else pixel-identical; no new text".

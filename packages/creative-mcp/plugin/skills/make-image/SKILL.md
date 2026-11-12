---
name: make-image
description: Create a finished image — poster key art, product shot, illustration, hero image, album/book cover art, concept art, background plate. Use when the user wants a picture made, edited, upscaled or varied. Local-first (Blender render or composition), with AI image models via media_generate when the user has API keys.
---

# Make an image

Key rule: **the picture and the typography are separate passes.** Generate/render the image clean (no text, leave room for it), then set type on top with `make-static-graphic` (HTML) or EffectCraft. Models misspell, render wrong fonts and can't be edited.

If `./brand/brand.md` exists, read it first: palette, imagery style and "avoid" list constrain the image. Honour an explicitly requested tool, model, size and quality; otherwise use the defaults below.

## Source real subjects

For a real subject (a product, a place, a person, a building) take the first usable source: the user's own asset (brief, attachments, project, brand kit, a path they name — never a disk-wide search) → the subject's official source or open libraries/stock → generation, when exact structure and labels don't matter → a hand-built depiction labelled as schematic. A version the user explicitly asked for wins; a guessed asset type is not such a request. Invented or abstract subjects are generated freely. Respect likeness, licensing and factual-claim limits (`craft` rights-and-sources).

## Recurring characters

A character across several stills or a video's keyframes uses a cast card (`cast` skill): reuse one (`cast_list`/`cast_show`) or make a hero portrait + full body + fixed description with `cast_create`. Paste the description verbatim and pass its refs in `references` on every request with that character, edits and retakes included; `cast_sheet` + `takes_compare` for likeness checks (visual, not an automatic verdict — say so). A card's `style` describes its reference images, not the look of the shot: choose each shot's look in the prompt. `real-person`/`licensed` cards stay draft until the user confirms consent (`cast_update consent=true` + their words); never generate that likeness before.

## Finish the layout elsewhere

If the deliverable goes beyond the bare picture — precise copy, a logo, a layout, multiple sizes, print or vector — render the image free of lettering and complete it in `make-static-graphic`. A titled cover qualifies; a plain picture of a dog or a retouched photo does not. A thumbnail may heighten the real story but must not promise events or results the video doesn't contain.

## 0. Pick the route

| Need                                                                                                         | Route                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Product shot, object, logo in 3D, architecture, stylised scene, exact control, many consistent angles        | **Blender** (`blender_*` tools) — local, free, repeatable                      |
| Painterly/photoreal illustration, people, complex nature, fast ideation                                      | **media_generate** (needs a key; check `media_models`)                         |
| Photo the user supplied → cleaned, recoloured, extended                                                      | media_generate with `references` (edit model), or ffmpeg/GIMP for simple fixes |
| Collage/composite of existing assets, flat illustration, pattern                                             | HTML/SVG composition (`make-static-graphic`) or EffectCraft                    |
| Node-graph SD/Flux pipelines on local GPU                                                                    | `comfyui` skill if installed                                                   |
| No key and no local generator? Say so, offer Blender/composition, and offer `media_set_key` — never pretend. |

## 1. Brief and references (always)

`reference_search` 3-4 specific queries (subject, lighting, palette, composition) → `reference_collect` 5-8 into a board with a note per image → `reference_board` → write `references/<board>/brief.md`: subject, mood, palette (hex), light (direction, softness, colour), lens/framing (see `craft` composition.md), what to avoid, where type will go.

## 2a. Blender route

1. `blender_status` → `blender_launch` (or open a file). Block out in small steps with `blender_exec`; `blender_screenshot` after each step.
2. Camera first: final aspect (e.g. 1080×1350 poster → set `resolution_x/y`), focal length from craft, composition guides; leave negative space where the headline will sit.
3. Light: three-point for products, sun + sky + volumetric haze for scenes. AgX view transform.
4. Previews: `blender_render` with `engine: "eevee"` or `cycles` at `samples: 32-64`, `resolution_percentage: 50`. Compare with `reference_compare`.
5. Final: Cycles 256-1024 samples with denoising (or EEVEE for stylised), full resolution, `transparent: true` if it will be composited. Print sizes: render at the needed pixels (A3@300dpi = 3508×4961), don't upscale.
6. Heavy batch/variants without UI: `blender_script` (background Blender) on the saved .blend.

## 2b. Model route (media_generate)

**Preference: GPT Image** (`openai/gpt-image-2.5/flare/text-to-image`, `/edit` with references; the server picks it by default when a fal key exists, `OH_IMAGE_PREFER=nano-banana` reverts) - the user prefers it for photos, about $0.2 per 1K image at high quality, `quality:"medium"` for drafts. **Fallback / cheap drafts: Nano Banana 2.1** (`google/nano-banana-2.1`; with `references` it switches to `/edit`), one **1K** image, **square** unless another format is asked for — about $0.04–0.06 per image on fal; also runs on a Google key (`route:"google"`). Ratios `16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 3:2, 2:3, 4:5, 5:4`; resolutions `1K/2K/4K`; up to **14 references**. Example: `media_generate {kind:"image", model:"google/nano-banana-2.1", title:"hero shot", prompt:"…", parameters:{aspect_ratio:"1:1", resolution:"1K"}}`.

1. `media_models` with category `text-to-image` (or `image-to-image`/editing) to see what's available; `media_model_schema` for exact inputs.
2. Prompt structure (one paragraph, concrete nouns, no filler like "masterpiece, 8k"):
   `[subject + action] , [setting] , [composition/lens/camera angle] , [lighting] , [palette/mood] , [medium/style] , [space for: "empty sky in upper third for title"]`
   Put things to exclude in `parameters.negative_prompt` (models without the field get it noted in `adjustments`; Gemini/Nano Banana on Google get an "Avoid: …" line) ("text, letters, watermark, logo").
3. `parameters`: `aspect_ratio` to the deliverable ("4:5", "16:9", "2:3"), `resolution` ("1K"/"2K"/"4K" on Nano Banana / Gemini), `num_outputs: 2-4` for takes, a fixed `seed` once you like a direction so edits stay coherent. Values snap to what the model allows (see `adjustments`); `media_estimate` gives the price before you run (2K/4K cost more).
4. References as inputs: pass `references: [paths]` (Nano Banana/FLUX-style models switch to their /edit route automatically) — a Blender blockout render for layout control, a product photo for identity, a brand image for style. State in the prompt what each reference is for ("use image 1 for composition, image 2 for the product's exact shape and colour").
   Tell the model what **each reference is for** — identity, style, composition, or the picture being edited — and nothing else. If a style was requested (sketch, line art, a style key), photos contribute only who or what is shown; inspect the output for creeping photorealism before you accept it (`make-ai-video` → [prompting.md](../make-ai-video/references/prompting.md#the-style-key-wins-over-photo-references)).
5. Several images: start every job first, then one `jobs_wait {mode:"any"}` loop over their ids — never wait on them one by one. Reuse the same short `title` for retakes of one idea so takes share a file name. Never overwrite: each call writes new files. A job left "uncertain" (lost provider handle) is never blindly resubmitted — `jobs_status {collect:true}` first, and ask the user if it may have been charged. Deliver absolute local paths, never signed URLs.

## 3. Iterate (quality loop)

- `reference_compare` each take; score 1-10 on subject/silhouette, palette, lighting, composition, detail; fix the 3 biggest gaps; stop at 7+ everywhere or after 3-4 rounds.
- **Editing passes** instead of re-rolling: masked/instruction edits with the edit model (`references: [current.png]`, prompt describes only the change), Blender re-render of one element, or local fixes (ffmpeg `eq`/`colorbalance`/`curves` for grade, `crop`, `pad`).
- **Variations/takes**: change one variable per take (light direction, palette, lens) and show them side by side: `ffmpeg -i a.png -i b.png -filter_complex hstack=inputs=2 takes.png`.
- **Upscaling**: only at the end, max 2-4×, with an upscaler model from `media_models` ("upscale") or by re-rendering Blender larger. Check faces/hands/edges after upscale. For simple size bumps: `ffmpeg -i in.png -vf scale=iw*2:ih*2:flags=lanczos out.png` (no new detail).

## 4. Typography pass

Hand the final clean image to `make-static-graphic`: image as full-bleed background in HTML, title/credits/logo set in brand fonts, render to PNG at each needed size. Check contrast over the image (scrim if needed).

## 5. Deliver

PNG (or high-quality JPG for photos), sRGB, the requested sizes, plus the clean textless master. Note models used and any third-party sources in `./sources.json` (see `craft` rights-and-sources.md). Say honestly what differs from the references.

## Media utilities

- Raster logo/icon → SVG: `media_generate` with `fal-ai/recraft/vectorize` (`input:{image_url:"logo.png"}`); for an editable logo or exact geometry author SVG in `make-static-graphic` (Inkscape when the user names it). A generative logo experiment only when explicitly asked.
- Trim transparent margins of a PNG locally: `ffmpeg`/ImageMagick (`magick in.png -trim +repage out.png`) or Python Pillow `getbbox()`.

## Pitfalls

- Hands, text, logos, symmetric objects and exact product details are where models fail: inspect at 100% crop.
- Real people / brands / franchises: follow `craft` rights-and-sources.md.
- Generated images at 1024 px are not print-ready; plan the resolution up front.
- Keep a `takes/` habit: `renders/<name>-v1.png`, `-v2`, … — never write over a take the user has seen.

- AI boosts (relight, detail, upscale, inpaint, matte, interpolate, HDR...) on a finished asset: see `ai-boost` for the order, settings and mandatory before/after checks.

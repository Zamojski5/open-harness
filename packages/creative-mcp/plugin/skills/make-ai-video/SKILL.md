---
name: make-ai-video
description: Make video shots, ads and films with AI video models (Seedance 2.5, MiniMax H3, Kling, Veo, Wan, LTX…) or restyle footage and renders, at the lowest price that keeps the quality - plan, look stills, cheap drafts, finish only kept takes, review, assemble.
---

# Make AI video

Goal: the shots or film the user asked for, looking right, paid once for each take that ends up in
the cut. Pair with `make-film` (staged narrative), `edit-video` / `make-trailer` (assembly),
`voiceover-and-sound` (audio), `choose-media-model` (model choice). The full workflow (planning,
sourcing, references, stills, review, assembly) is in [references/workflow.md](references/workflow.md).

**Restyling a supplied video or render** (style transfer, video-to-video, render-to-real): open
[references/style-transfer.md](references/style-transfer.md) first.

## Never generate real product UI

On-screen software whose text must read is built from the real screens with motion and real type
(`make-motion-graphics`, EffectCraft, `obs`). Generate only the shots without UI; a take with invented UI
is replaced or regenerated with no screen visible. Ads and campaigns: research and settle the idea and
copy first (`reference-research`, `campaign-strategy`, `copywriting`).

## Before any money moves

- **Keys**: calls run on the user's own keys (`media_models`). No key → EffectCraft (camera moves on a
  still: say the picture itself doesn't move), Blender, or `media_set_key`.
- **Model, once per chat**: unless the user named or saved one, present the idea, then
  `media_quote_plan` (2–3 fitting models, whole-piece totals with retakes) and ask with its card,
  recommending one in a few words. Use the pick for every clip of the chat.
- **Quote every batch**: `media_estimate` with `count` = takes incl. retakes; say total, route and payer.
  Above the ask-before limit (counted with what the chat already spent unapproved) `media_generate`
  returns an approval card: show it unchanged and wait. Rules: [paid-generation](../choose-media-model/references/paid-generation.md).
- **Default**: MiniMax H3 Max, 5 s, 768P. Seedance 2.5 for > 15 s, many references, edit/extend, or its
  draft → finish ladder; FLUX 3 Max for cinematic realism; Kling v3 4K for product-photo hero shots.
  Read the model's page ([model-prompting](references/model-prompting.md)) before its first paid batch.

## Spend on keepers, not on attempts

- **Look in stills first** when the look is open: 3–4 cheap stills picked on a card; previs in Blender
  for staging with 2+ cuts.
- **Variants are drafts**: plan about 1 kept take in 3–4 (fewer for physics, hands, dialogue, crowds).
  Seedance 2.5 `parameters.draft: true` (480p, finishable), or a draft tier (H3 Max Turbo 768P). Show a
  scene's drafts together; the user picks.
- **Finish only the kept take**: `media_finish_draft {job_id}` (same take, 1080p, provider that made it,
  within 7 days), quoted first with `media_estimate {finish_of}`. Refused → ask: upscale
  (`media_upscale`) or regenerate (a new take). Drafting saves money only on takes you drop.
- **Repair before re-roll**: trim, cover, edit a time range, extend from the good opening, insert one
  shot. A re-roll keeps every correction the user gave.
- Small budget: stills with camera moves plus a few hero shots; one scene, one model; report spend.

## Make, check, deliver

   several shots → storyboard and joins ([workflow](references/workflow.md) §2–4); produced film → `make-film`.
2. Generate from references, not keyframes, unless the user asks for stills (workflow §5–6). Submit an
   approved batch together (`media_generate_batch`), with `request_id`; never overwrite takes.
3. Wait with `jobs_wait` (≤ 120 s per call); on `unusuallySlow`/`stalled` stop and ask.
4. Inspect every take: `media_frames`, frames up to the real end, `media_review`, `media_flicker`, the
   [AI-artifact pass](references/review.md#ai-artifact-pass). Judge on 2+ samples; never ship the best of
   failing takes. Log with `takes_log`.
5. Deliver each finished clip as an absolute local path; exact text, logos and claims are overlays,
   never generated. Disclose AI generation where required.

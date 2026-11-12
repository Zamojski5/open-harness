---
name: make-3d-scene
description: Take a brief to a finished, reviewed 3D render or animation in Blender — references and brief, sourcing CC0 assets from Poly Haven before modelling, blockout, materials, light, camera, animation, preview rounds against the moodboard, takes, final render, sound via ffmpeg and honest delivery. Use when the user asks for a 3D scene, shot, product render, turntable, 3D animation, environment, "render me a …" or any deliverable that should come out of Blender.
---

# Make a 3D scene (brief → final shot)

Uses the `blender` skill for tool mechanics and bpy details, `quality-loop` for the scoring discipline, `craft` for taste, `present-results` for hand-off. For very ambitious jobs ("best you can", multi-shot trailer) wrap this in `production-pipeline`.

## 0. Pin down the deliverable (2 minutes)

Write down, deciding sensible defaults instead of asking unless it's expensive to redo:

- Still or animation? Duration (s), fps (24 default), aspect/resolution (1920×1080; 1080×1920 vertical; 2.39:1 for cinematic), platform.
- Look: photoreal / stylised / clay / low-poly / product-clean. Engine follows: photoreal stills → Cycles final; animation and stylised → EEVEE.
- Sound needed? (Animations for social/ads almost always: music bed and/or SFX/voice.)

## 1. References and brief

1. `reference_search` 3-5 specific queries (subject, lighting, palette/mood, composition, material close-ups) → `reference_collect` 5-8 keepers with notes → `reference_board`.
2. Write `references/<board>/brief.md`: subject and story in one line, shot list (for animation: shots with duration and camera move), palette hex, key light direction/colour/ratio, lens and camera height, materials list, mood words, what to avoid, rubric axes (silhouette, palette, lighting, composition, detail, motion).

## 2. Source before you model

For every element in the shot list, in this order:

1. **Poly Haven:** `asset_search` models (props, furniture, plants, rocks), textures (every visible surface), HDRIs (sky/ambient). Prefer a real scanned asset over a primitive every time.
2. **AI-generated** image/3D (`media_generate`, if keys exist) for unique hero items, then rebuild in Blender.
3. **Model it** from primitives + modifiers (Bevel, Subdivision, Solidify, Array, Boolean) only for what's left — simple shapes, architecture, stylised forms.

Canonical real subjects (anatomy, molecules, museum objects, machine parts): licensed models from `blender/references/model-sources.json`. Photoreal briefs: `blender/references/photoreal-look.md` (scans + HDRI + scanned surfaces are normal steps).

Keep a list `name → source` (Poly Haven id / generated / modelled) for the hand-off, and a `CREDITS` line per third-party asset.

## 3. Build in the live scene, one step per call

`blender_launch`, then each step with `blender_exec` / asset tools and a `blender_screenshot` after it:

1. **Scale and layout (blockout):** ground/set, hero at real size (metres), placeholders for the rest. Camera early: `blender/scripts/camera_rig.py` with the planned lens. The viewport screenshot is not the camera view — check framing with a quick `blender_render engine=eevee resolution_percentage=25`.
2. **Assets:** `asset_import_model` (check `size_m`), place via the root empties; scatter repeats with `scatter.py`.
3. **Materials:** `asset_apply_material` per surface with correct tiling scale; procedural recipes for the rest.
4. **Light:** `asset_apply_hdri` for ambient/reflections and/or `look_preset.py`; tune ratios against the references. Lighting decides the mood — spend time here.
5. **Atmosphere and detail:** fog (`look_preset.py fog`), bevels on hard edges (nothing in reality has razor edges), small clutter, imperfections (roughness variation, dirt).
7. `blender_save` → `scenes/<project>.blend` after each milestone.

## 4. Preview rounds (max 3-4)

1. Preview: `blender_render engine=eevee resolution_percentage=50` (still) or a short animation excerpt / key frames.
2. `reference_compare image=<preview> board=<board>`; score each rubric axis 1-10 honestly; name the 3 biggest gaps.
3. Fix those 3 (usually light ratio, palette/grade, composition/scale), re-render, compare again. Stop when every axis ≥ 7 or after 4 rounds.
4. Log each preview: `takes_log action=add file=… note="what changed" score=…`.

## 5. Takes for key choices

When a choice is uncertain and cheap to vary (lighting preset, HDRI, lens, camera move, colour look, scatter seed), render 2-3 takes at preview quality, `takes_compare a=… b=…`, pick with the rubric, `takes_log action=pick`. Takes never overwrite (`blender_render` numbers them); keep the losers for the user.

## 6. Final render

- Still: Cycles 256-512 samples + denoise at full resolution (or EEVEE 128 for stylised).
- Animation: EEVEE 64-128 samples (or Cycles 64-128 + denoise + persistent data if time allows), motion blur on for motion, final resolution. Long renders: tell the user the estimate; render via `blender_render` (background) so they can keep working.
- Plates for compositing (titles, glows, grading in EffectCraft): `transparent=true`.
- Before every render: `vm_stat` and one background Blender at most (24 GB machine; see `blender` SKILL.md).

## 7. Sound (animations)

1. Get audio: user files, `media_generate kind=music|sfx|speech` (check `media_models` / keys), or `speak_local` for an offline voice-over (e.g. voice Zosia for Polish).
2. Time picture to audio: put cuts and impacts on beats (frame = seconds × fps); trim music to the video length with a 0.5-1 s fade-out.
3. Mux with the `ffmpeg` tool, e.g. `["-i","takes/blender-x-take-03.mp4","-i","audio/music.mp3","-filter_complex","[1:a]afade=t=out:st=9:d=1,loudnorm=I=-14:TP=-1.5:LRA=11[a]","-map","0:v","-map","[a]","-c:v","copy","-c:a","aac","-b:a","192k","-shortest","takes/final-with-sound.mp4"]`. Voice over music: lower music to ~25 % or sidechain-duck it.
4. Never overwrite the silent master; the sound version is a new file.

## 8. Review and deliver

1. `media_frames` (video) or view the PNG yourself at full size: look for flicker, noise, clipping, intersecting objects, floating contacts (objects must touch the ground — check shadows), texture stretching, popping between frames.
2. `media_review` on the final file; fix every error/warning it flags (black frames, loudness, resolution).
3. Final `reference_compare` with scores.
4. Hand off (`present-results`): final path(s) + `.blend` path, contact sheet, the asset list (Poly Haven names, CC0), takes with what differs, render settings, and honestly what still differs from the references and what another round would improve.

## Quality bar checklist

- [ ] Real-world scale; objects sit on surfaces (contact shadows), nothing floats or intersects.
- [ ] Every visible surface has a believable material (no default grey, no pure black/white, roughness varies).
- [ ] Clear key light direction; subject separated from background; darks as deep as the references'.
- [ ] Bevelled edges on hard-surface models.
- [ ] Composition follows the brief (lens, height, thirds, depth layers).
- [ ] Animation eased, staggered, holds before cuts; motion blur on moving shots.
- [ ] No noise/fireflies/flicker in the final; colour management AgX (or Standard for exact brand colours).
- [ ] Audio synced and loudness-normalised (animations).

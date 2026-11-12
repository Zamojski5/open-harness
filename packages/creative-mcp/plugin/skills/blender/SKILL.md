---
name: blender
description: Drive Blender 5.x through the open-herness-creative tools (blender_launch/exec/screenshot/render/script, asset_* for Poly Haven) — bpy idioms that work in 5.x, EEVEE vs Cycles, photoreal look, scanned surfaces, lighting, camera moves and lenses, volumetrics, render/grade/output, light and reference diagnostics, render budgets, Blender renders turned into realistic footage with video models (render-to-real, restyle, previs finish), CG composited into the user's footage, props, liquids, scattered detail, rigged characters and motion from video. Use whenever you build, light, animate or render anything in Blender, or the user mentions Blender, a .blend file, 3D modelling or a 3D render — even when the project has its own instructions.
---

# Blender (5.x) through Open Herness

For the end-to-end job "brief → finished 3D shot/animation" follow the `make-3d-scene` skill; this one is the app manual. Taste decisions (palette, lens, timing) are in `craft`; the iteration harness is `quality-loop`. Blender previews and frame-sequence finishing are 3D output, not editing: finish them here (`blender_render` MP4, ffmpeg) without handing off to an editor skill.

## Which reference to read

| Situation                                                                                                                  | Read                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Canonical real subject (anatomy, molecule, museum object, spacecraft, machine part)                                        | licensed model from [model-sources.json](references/model-sources.json); keep real size, check dimensions                         |
| Scene with several lights or a practical looks washed out or tinted                                                        | `blender_light_solo` (below), [lighting](references/lighting.md)                                                                  |
| Scanned table, floor, wall or fabric                                                                                       | [scanned-surfaces](references/scanned-surfaces.md), [assets-polyhaven](references/assets-polyhaven.md)                            |
| Materials by recipe, wear                                                                                                  | [materials](references/materials.md)                                                                                              |

## Session pattern

1. `blender_status` → `blender_launch` (reuses the user's open Blender; never close a window you did not open).
2. `blender_scene` before touching anything: exact object names, dimensions (m), materials, camera, frame range. Never guess names.
3. One logical step per `blender_exec` (blockout → assets → materials → lights → camera → animation → render settings). Return data with `result = {...}`; `print()` also comes back.
4. After every visual step: `blender_screenshot` (`material` = fast colour check, `rendered` = real light; `solid` for shapes). The first `rendered` shot after new materials often shows "Compiling shaders" — take it again.
5. `blender_save` to `scenes/<name>.blend` after each milestone, and to a new checkpoint name before risky changes; `blender_render` snapshots the live scene into a background process, so a crash there never loses the user's work.
6. Long jobs (bakes, many-frame renders, exports, tracking/solving, procedural generation over 10 s) → `blender_script` or `blender_render`, never inside `blender_exec` (it blocks the user's UI and times out after 120 s).
7. Long render: when the first handful of frames has landed, time them and project the end (remaining frames × average s/frame). If that projection is clearly off from the time you quoted, give the user the corrected figure.
8. Judge a preview or render from a single contact sheet (`media_frames` on the MP4, or one tiled image a script builds from the frames folder) in one look. Opening frames individually, or building a further sheet to double-check the same render, wastes calls.

## Machine limits (Mac M4 Pro, 24 GB RAM) — always

- **Serial:** at most one background Blender next to the live session; never two renders at once; never restart cancelled old jobs on your own.
- **`vm_stat` + process list immediately before every render** and every tool that renders (`blender_render`, `blender_render_budget`, `blender_light_solo`, rendered screenshots). Close only background Blenders you started. Watch RAM and free disk during long renders (swap lands on disk).
- **Textures:** ≤ 2K, background/trees 1K, 4K only for the hero close-up. Instances, never realised scatter.
- **4K Cycles:** 512 px tiles (`scene.cycles.tile_size = 512`); 2048 px tiles swapped the disk down to 0.42 GiB free.
- Audits at Cycles 32 samples, 50 % resolution. Leave the main scene saved in Solid shading.

## Bundled scripts (tested in Blender 5.1)

In `scripts/` next to this file. To run one: Read the file, put `PARAMS = {...}` as the first line, send the whole text as `code` to `blender_exec` (live) or `blender_script` (headless, add `file=` and a save call). Each sets `result`. Re-running with the same name replaces the previous rig/lights, so iterate freely.

| Script           | Does                                                                                                                                                                                                                                         | Example PARAMS                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `look_preset.py` | Lights + world + AgX look + optional bloom and fog box. Presets: `studio`, `three_point`, `rim`, `moonlight`, `golden_hour`, `noir`, `neon`. Scales light distance/power to the subject size.                                                | `{"preset": "moonlight", "target": "Hero", "fog": 0.05}` · `{"preset": "three_point", "keep_world": true}` after an HDRI |
| `camera_rig.py`  | Camera + target + pivot empties, auto-framing for the lens, moves `static`, `dolly_in/out`, `truck`, `orbit`, `crane_up/down`, `push_zoom`, eased; optional DOF and handheld wobble.                                                         | `{"move": "orbit", "target": "Hero", "degrees": 90, "frames": [1, 120], "lens": 35, "dof": true}`                        |
| `scatter.py`     | Geometry Nodes scatter of an object or a collection of variants over a surface (density or count, Poisson spacing, seed, random scale/spin/tilt, align to normal). Non-destructive. Rebuild after changing the camera lens or render aspect. | `{"surface": "Ground", "source": "Rocks", "density": 2, "min_distance": 0.3, "seed": 4}`                                 |

They are starting points: after running one, look, then adjust single values with `blender_exec` (e.g. `bpy.data.lights["OH key"].energy *= 0.7`).

### Looks and atmosphere

Map a named mood onto `look_preset.py` + layers by hand:

| Wanted look                      | Start from                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------- |
| rainy night, night city          | `moonlight` or `neon` + wet floor (roughness 0.05–0.15) + practicals + fog       |
| fog forest, misty dawn           | `moonlight`/`golden_hour` + `fog` 0.03–0.08 + light shafts through canopy        |
| sunbeams / god rays              | small strong sun/spot partly blocked + fog (anisotropy 0.3–0.6)                  |
| neon interior                    | `neon`                                                                           |
| golden hour, blue hour, overcast | `golden_hour`; `moonlight` with a brighter cool sky; overcast HDRI at strength 1 |
| studio product, wet product      | `studio` (+ water drops / wet roughness for wet)                                 |

Layers we build by hand with `blender_exec`: fog (volume box), god rays, wet surfaces, practicals (emission + a real light at the source), camera (DOF, shake, motion blur). Rain, snow and dust particles have no preset: build them as particle/GN instances and check them in motion.

**Look kit v2 (preferred over mapping by hand):** `blender_look {name | layers, intensity?, hero_object?, remove?, file?}` builds a named look on a copy (`takes/<name>-look.blend`, source untouched) and returns a 640 px preview. Names: rain-night, fog-forest, sunbeams, neon-interior, night-city, golden-hour, blue-hour, misty-dawn, overcast, studio-product, wet-product. Layers (alone or as a subset of a look): `rig` (lights + world), `fog` (density = 3 / visibility × amount, visibility = max(4 × subject distance, 8 m), height-fog node group), `godrays` (sun volume scatter + hidden gobo, sun azimuth searched), `practicals` (emissive polygons → real lights, 256 lights / 48 shadow casters / 1.5 m cells; a motivated 2700 K key + 7500 K rim when < 2), `wet` (darker, glossier, puddles on up-facing faces), `rain` (streak cards), `camera` (DOF on the hero), `post` (AgX look, bloom, CA, grade, vignette, grain). A named look also runs auto exposure. Re-applying replaces the previous look; `remove: true` restores exposure/world/lights/DOF/materials. It switches the scene's own lights off while the `rig` layer is on (restored on remove). Look at the preview, then tune single values with `blender_exec` on the copy.

`blender_auto_exposure {target?, hero_object?, ceiling?, floor?, apply?, file?}`: renders a 240 px linear probe, key = geometric mean of the central 80 % minus the brightest 2 %, `EV = log2(target / key)`, raised so the hero box reaches its target, capped by `ceiling` (dark looks), lifted by `floor` (wins), clamped ±10 EV. Reports key/p50/p90; `apply: true` writes `takes/<name>-exposed.blend`. Target = middle grey: 0.18 day, 0.20 golden hour, 0.10–0.12 neon/blue hour, 0.08 night. Run it after any lighting change instead of guessing exposure.

### Sets and scenery

Big sets (forest, city block, street, market, valley) have no generator here: block out with primitives at real scale, source Poly Haven models (`asset_import_model`) and instance them with `scatter.py`. Build geometry and emissive materials first, then light. Ground kits (forest floor, ferns, grass, rocks, debris, leaves) = `scatter.py` with Poly Haven models as sources.

## bpy in 5.x — what changed and what works

- **Data API over operators.** `bpy.data.objects.new(name, data)` + `scene.collection.objects.link(obj)`; ops depend on context and fail with "context is incorrect". `bpy.ops.mesh.primitive_*_add` is fine (it gives UVs); then `obj = bpy.context.active_object`. Clip-editor and some other operators work headless only inside `bpy.context.temp_override(...)` with a matching area.
- **Engines:** `'BLENDER_EEVEE'` in 5.x; Blender 4.2–4.5 call it `'BLENDER_EEVEE_NEXT'`. Also `'CYCLES'`, `'BLENDER_WORKBENCH'`.
- **Cycles device:** `blender_render` sets GPU + Metal. In your own `blender_script`, set `scene.cycles.device = "GPU"`, the Cycles add-on preference `compute_device_type = "METAL"`, call `get_devices()` and enable the Metal devices; under `--factory-startup` Cycles otherwise renders on the CPU.
- **Materials/worlds always have node trees**; `use_nodes` is deprecated (warning; removed in 6.0). Write `if mat.node_tree is None: mat.use_nodes = True` for 4.x compatibility.
- **Principled BSDF inputs:** `Base Color, Metallic, Roughness, IOR, Alpha, Normal, Subsurface Weight/Radius/Scale, Specular IOR Level, Specular Tint, Anisotropic, Transmission Weight, Coat Weight/Roughness/IOR/Tint/Normal, Sheen Weight/Roughness/Tint, Emission Color, Emission Strength, Thin Film Thickness/IOR`; 5.2 adds `Thin Wall` for single-sheet glass. (Old names `Subsurface`, `Transmission`, `Emission`, `Clearcoat`, `Specular` are gone.)
- **Animation is layered/slotted.** `action.fcurves` no longer exists. Use
  `from bpy_extras import anim_utils; bag = anim_utils.action_get_channelbag_for_slot(obj.animation_data.action, obj.animation_data.action_slot); bag.fcurves` (see `fcurves_of()` in `camera_rig.py`), or walk `action.layers[…].strips[…].channelbag(slot)`; check the channel bag exists.
- **Compositor:** no `scene.node_tree`, no `CompositorNodeComposite`. Create `bpy.data.node_groups.new("Comp", "CompositorNodeTree")`, add an output socket with `tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")`, end in `NodeGroupOutput`, assign `scene.compositing_node_group = tree`, `scene.render.use_compositing = True`. Node options are now input sockets taking display names: Glare `inputs["Type"].default_value = "Fog Glow"` (or `"Bloom"`, `"Streaks"`), `inputs["Quality"] = "High"`, `inputs["Threshold"]`, `inputs["Strength"]`, `inputs["Size"]`; there is no `glare_type`.
- **No `eevee.use_bloom / use_ssr / use_gtao`.** Glow = emission + compositor Glare. Reflections/GI = `eevee.use_raytracing`, `eevee.ray_tracing_method` (`'PROBE'|'SCREEN'`), `eevee.use_fast_gi`.
- **Colour management:** `view_settings.view_transform = 'AgX'` (default; also `'Filmic'`, `'Standard'` for graphics/UI colours that must match hex and for sRGB video plates, `'Khronos PBR Neutral'` for product colour accuracy). Looks need the full name: `'AgX - Punchy'`, `'AgX - Medium High Contrast'`, `'AgX - Base Contrast'` … (bare `'Punchy'` raises).
- **Lights:** `use_temperature = True; temperature = 3200` (K) instead of eyeballing RGB; area `shape/size/size_y`, `spread`; point/spot `shadow_soft_size`; sun `angle`.
- **Hex colours are sRGB; sockets want linear.** Convert: `c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4`.
- **Geometry Nodes:** `tree.interface.new_socket(...)` for group inputs/outputs; Distribute Points on Faces → Instance on Points; Euler → Rotation via `FunctionNodeEulerToRotation`. Collection Info "Reset Children" did not drop the children's offsets in renders — keep scatter variants at the origin (scatter.py does this).
- **Units:** metres. A door is 2 m, a person 1.75 m, a mug 0.1 m. Wrong scale ruins light falloff, DOF and physics — check `blender_scene` dimensions. Imported CAD STL is usually millimetres.
- **Text:** CJK from Noto variable fonts renders blank; use static font files, or better, set type in the edit.

## EEVEE or Cycles

|                            | EEVEE                                                                                                                                                | Cycles                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use for                    | previews, stylised, motion graphics, most animation, fast iterations                                                                                 | final photoreal stills, glass/caustics/clear liquids, interiors with bounce light, heavy volumetrics, shadow catching into footage                              |
| Samples                    | `eevee.taa_render_samples` 16 preview / 64-128 final                                                                                                 | `cycles.samples` 32-64 preview / 128-512 final with `use_denoising = True`, `use_adaptive_sampling = True`, `adaptive_threshold = 0.01`                         |
| Time (1080p, M-series Mac) | 1-5 s/frame (heavy fog + RT ≈ 19 s)                                                                                                                  | 20 s - 5 min/frame                                                                                                                                              |

EEVEE's screen-space refraction puts black bands through clear bottles and glass: use Cycles for preview and final whenever clear glass or liquid is on screen. Rough budget: an animation of N frames in Cycles at 2 min/frame is N×2 minutes — measure with `blender_render_budget` and say it before starting; preview in EEVEE.

## Diagnostics (measure before you tweak)

- **Washed out, flat or tinted render?** `blender_light_solo {file?, camera?}` renders each light alone, the world alone and emission alone at low cost (scene untouched) and reports each source's share of the light, cast and clipping. Typical findings: a rim/fill that dominates the key, a world/HDRI giving > 55% of the light (flat), one coloured light tinting everything, lights that add < 3% (delete them). A brown surface reads warm even under a neutral light. Fix the named light, then re-run.
- **Will the animation finish in time?** `blender_render_budget {budget_minutes, frames?, file?, apply?}` times a probe frame inside Blender, estimates the total and, if over, degrades in order of least visible loss (denoiser + fewer samples, volume step, bounces, resolution %, EEVEE), re-probing to measure the real gain. `apply: true` saves `./takes/<name>-budget.blend`. Tell the user the estimate before a long render.
- **Long renders / finishing a frame sequence:** `blender_render {animation: true, frames_dir: "takes/<shot>-frames", interleaved: true, max_minutes: 20}` renders every 8th frame first (review timing early), skips frames already on disk (resume after a crash or a slice) and makes the H.264 MP4 once all frames exist. Call it again with the same `frames_dir` to continue. A draft of a camera move: half size, 16 samples, every frame.

## Volumetrics in short

Atmosphere = a box around the scene with a Principled Volume (density 0.01-0.08, anisotropy 0.3-0.6) — `look_preset.py` `fog` does it. World-volume works too but is unbounded and slow in Cycles. God rays need a strong, small light source (spot or sun) partially blocked by geometry. EEVEE: `volumetric_tile_size '2'` for crisp shafts, `volumetric_samples` 64-128, `use_volumetric_shadows`. Cycles: `volume_bounces` 2 for thin haze, 8 for dense steam/smoke/cloud; `volume_step_rate` 1-4 (higher = faster, blotchier). Judge the light without fog first.

## Performance limits

- Keep live-viewport scenes under ~5 M visible triangles; use instancing (Geometry Nodes, `scatter.py`) not copies; texture sizes per the machine limits above.
- Subdivision: modifier levels viewport 1, render 2; `Adaptive` subdivision only in Cycles, last in the stack.
- Cycles: `render.use_persistent_data = True` for animations; denoise instead of high samples.
- If `blender_exec` times out, the UI is busy (render, modal dialog): wait, check `blender_status`, never fire the same heavy call again.

## Common failures → fixes

| Symptom                                               | Cause → fix                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Black render                                          | No camera (`scene.camera`), camera inside an object, lights too weak for the scene scale, or world strength 0 with no lights.                |
| Pink/magenta surfaces                                 | Missing texture files; check `bpy.data.images` paths, re-run `asset_apply_material`.                                                         |
| Normal map looks like bumps inverted / lighting wrong | Normal texture not `Non-Color`, or DirectX normal (`nor_dx`) used: use `nor_gl` through a Normal Map node.                                   |
| Washed-out colours                                    | Colour maps set to Non-Color, or Standard vs AgX confusion; set Base Color image to sRGB.                                                    |
| Texture stretched or huge                             | No UVs (use box projection) or tiling too low: Mapping scale = surface size / texture's real size.                                           |
| Large surface looks like a flat printed sheet         | No anti-tiling / patch variation / real displacement: [scanned-surfaces](references/scanned-surfaces.md).                                    |
| Fireflies (Cycles)                                    | Small bright lights hitting glossy; raise light size, `caustics_reflective = False`, clamp indirect (`sample_clamp_indirect = 10`), denoise. |
| Dense smoke/steam renders dim or grey                 | `volume_bounces` 0: set 8.                                                                                                                   |
| Black patches in foliage/hair cards                   | `transparent_max_bounces` too low: 32, 64 for canopies.                                                                                      |
| Black bands through clear bottles (EEVEE)             | Screen-space refraction: render in Cycles.                                                                                                   |
| Noisy/blocky fog (EEVEE)                              | `volumetric_tile_size '2'`, more `volumetric_samples`.                                                                                       |
| Shadow acne / light leaks                             | Thicken walls (Solidify), avoid zero-thickness planes for interiors.                                                                         |
| Track To camera flips at the top                      | Keep the camera below 89° elevation or use Damped Track.                                                                                     |
| Object not where expected                             | Parent/child transforms; read `matrix_world.translation`, not `location`.                                                                    |
| "context is incorrect"                                | Replace the operator with the data API, or wrap with `bpy.context.temp_override(...)`.                                                       |
| Animation looks robotic                               | Default Bezier on everything: set easing per move (`camera_rig.py set_easing`), add holds, offset keys between objects by 2-6 frames.        |
| Render swaps / disk fills at 4K                       | Tiles too big or 4K maps everywhere: 512 px tiles, maps per machine limits, one background Blender.                                          |

## Continuous motion and sound

To judge continuous motion, sync or how a clip sounds, look at frames (`media_frames`), `media_flicker`, and `media_review` (loudness, black frames); for sound mixing see `voiceover-and-sound`.

- AI boosts (relight, detail, upscale, inpaint, matte, interpolate, HDR...) on a finished asset: see `ai-boost` for the order, settings and mandatory before/after checks.

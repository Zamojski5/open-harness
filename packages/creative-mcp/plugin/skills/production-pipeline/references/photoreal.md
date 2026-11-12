# Photoreal checklist (Blender 5.x)

The eye reads "CG" from a few tells: perfect surfaces, wrong scale, flat light, clean edges, no
atmosphere, perfect cameras. Kill each one.

## Scale and geometry
- Unit scale 1 = 1 m; check `dimensions` of every hero object against the reference measurements.
- Bevel every hard edge (Bevel modifier, 2–3 segments, 1–5 mm on props, 1–3 cm on stone); real
  objects never have razor edges.
- Silhouettes from the shot camera matter most; subdivide or add geometry where they are visible.
- Nothing floats, nothing intersects visibly: sink rocks into terrain, ground contact shadows.

## Surfaces
- PBR maps (albedo, roughness, normal, displacement) from Poly Haven at 2K+ for anything within a
  few metres of the camera; 4K for the hero.
- Albedo stays in 30–240 sRGB (no pure black/white). Metals: metallic 1 with coloured reflectance,
  dark albedo for raw iron; silver/steel roughness 0.15–0.35 varied by a grunge map.
- Variation everywhere: roughness driven by a noise/grunge (never one number), dirt in cavities
  (Ambient Occlusion or Pointiness → colour ramp), edge wear on metal/painted edges.
- Displacement on terrain and stone where light grazes (Cycles: material displacement "Displacement
  and Bump", adaptive subdivision when available; EEVEE: real geometry + normal map).
- Vegetation: translucency on leaves/grass, many variants, random scale/rotation, clumping, density
  falling off with distance; no repeated identical instances in frame.

## Light
- One motivated key (sun/moon or practical) + HDRI world for fill/sky; key:fill around 4:1–8:1 for
  drama. Moonlight: cool 7000–9000 K key, low intensity, warm practicals for contrast.
- Volumetrics: World/volume box Principled Volume density 0.002–0.02 (scene-scale dependent),
  anisotropy 0.3–0.7 for god rays; keep backgrounds separating into 3+ depth layers.
- Light linking / blockers (gobos, foliage) to break up flat light.
- Diagnose before tweaking: `blender_light_solo` shows each light's share and cast. Wash-out usually = one
  source (often world or an over-strong rim) giving most of the light; a colour cast = one tinted
  light or HDRI. Fix that source, not the exposure.

## Camera
- Real lenses: 24–35 mm wide establishing, 50 mm natural, 85–135 mm hero/close.
- Depth of field on, f/1.8–f/4 with focus on the hero (focus object), not everything sharp.
- Camera moves with weight: ease in/out, slight handheld noise (small noise modifier on rotation,
  0.1–0.3°), never perfectly linear dollies.
- Motion blur on for animation (shutter 0.5 = 180°).

## Render
- Cycles for hero stills and finals: GPU (Metal) when available, adaptive sampling noise threshold
  0.01–0.02, 128–512 samples, denoiser OpenImageDenoise, light paths: max bounces 8, caustics off,
  clamp indirect 10 to kill fireflies.
- EEVEE (Blender 5) for previews and long animations when the time budget is tight: raytracing on,
  shadows high, volumetrics tile size 4–8, fast GI.
- Colour management: View Transform AgX, Look "Medium High Contrast" or "Punchy" to taste;
  exposure rather than light-power hacks.
- Always do a test frame: `blender_render_budget {budget_minutes}` measures seconds/frame × frames,
  proposes degraded settings that fit (denoiser + fewer samples first, EEVEE last) and saves a copy;
  tell the user the estimate before a long render. Render finals with `frames_dir` + `interleaved`
  so an early preview exists and a crash only costs the missing frames.

## Matching the reference
- After each preview, `blender_compare_reference {image, reference, objects}` per hero object:
  "too smooth" → roughness variation + normal/bump/displacement; "too glossy" → raise roughness;
  "flatter" → stronger key:fill, cavity darkening; colour shift → albedo or light temperature.
  Fix the biggest 1-3 gaps per round, re-render, re-compare (numbers judge tone/colour/texture,
  not shape — still look at the image).

## Finishing (compositor or EffectCraft)
- Glare (Fog Glow/Bloom) subtle, lens distortion ~-0.01, very light chromatic aberration,
  vignette, film grain matched to the reference, slight halation on highlights.
- Grade toward the brief palette; check blacks are not crushed and highlights not clipped
  (media_review on stills reports clipping).

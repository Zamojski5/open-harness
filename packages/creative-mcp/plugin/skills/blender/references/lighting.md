# Lighting recipes

Angles below: azimuth 0° = from the camera side, 90° = from the subject's left as seen by camera, 180° = behind. Elevation from the horizon. Powers assume a subject ~1-2 m across with the light ~3-4 m away; scale power by (distance / 4 m)². `scripts/look_preset.py` builds most of these for you; use these notes to tune by hand.

## Principles

- **Decide the key first.** One dominant direction; everything else supports it. Check with the other lights off.
- **Ratios, not absolutes.** Key:fill 2:1 bright/commercial, 4:1 dramatic, 8:1+ noir. Rim ≈ key or brighter (it hits at a grazing angle).
- **Size = softness.** Area light size relative to the subject: ≥ subject size → soft wraparound; 0.1× → crisp shadows. Sun `angle` 0.5° crisp noon, 3-5° hazy.
- **Colour contrast.** Warm key (3000-4500 K) against cool fill/ambient (6500-10000 K) reads as cinematic; keep both temperatures inside one family for calm scenes.
- **Separate subject from background** with a rim, a background light pool or value contrast (dark subject on light ground or the reverse).
- **Exposure:** adjust `view_settings.exposure` (stops) for the whole frame rather than pumping every light.

## Setups

| Setup | Lights | Notes |
|---|---|---|
| Three-point | Key area 45° az, 35° el, ~200-300 W, 4500 K; fill area −55° az, 10° el, 1/4-1/6 of key, larger, 6500 K; rim spot 160° az, 35° el, 400-600 W, cool | The default for characters and objects. |
| Studio / product | Big softbox key 35°/35°, broad fill opposite, top disk light, rim strip behind; grey world 0.5-0.7 | Add a seamless backdrop (a plane bent with a bevel) for an infinite floor. `Khronos PBR Neutral` view transform when exact product colours matter. |
| Rim / silhouette | Two strong rims ±125°, 30° el; tiny front kiss 2-5% | Dark world; works with fog for glow halos. |
| Moonlight | Sun 150° az (back-side), 30-40° el, 0.5-1.5 W/m², 8000-10000 K; faint blue sky fill; world near-black blue | Night is about contrast, not darkness: keep highlights at proper exposure, shadows deep blue, add a warm practical (window, lantern 2700 K) for contrast. Fog 0.03-0.06 + bloom. |
| Golden hour | Sun 5-12° el, 3000-3400 K, 3-5 W/m², long shadows; sky fill 9000 K | Or a Poly Haven `sunrise-sunset` HDRI rotated so the sun sits behind-side of the subject. |
| Overcast / soft daylight | HDRI `overcast` at strength 1, no extra key; maybe a weak sun 0.5 W/m² | Most forgiving for showing material detail. |
| Noir | One hard spot (small radius), high above-side; nothing else; world 0 | Venetian-blind shadows: put a slatted plane in front of the spot (gobo). |
| Neon / cyberpunk | Saturated magenta and cyan areas from opposite sides, wet glossy floor (roughness 0.05-0.15), emissive signs, fog + bloom | Keep one side dominant so it doesn't look flat. |
| Interior daylight | Sun through the window + Portal-like large area light in the window opening (Cycles), HDRI outside | EEVEE: `use_raytracing`, `use_fast_gi`; Cycles: `max_bounces` ≥ 8. |

## HDRI plus your own lights

1. `asset_search type=hdris` with categories matching the mood (`studio`, `outdoor`, `night`, `sunrise-sunset`, `overcast`, `indoor`).
2. `asset_apply_hdri id=… strength=…` — 1.0 natural; 0.2-0.5 when your own key should dominate.
3. Rotate (`rotation`) until the HDRI's sun/window agrees with your key direction; check reflections on glossy surfaces.
4. `look_preset.py` with `keep_world: true` adds the key/rim on top.
5. `show_background: false` keeps the HDRI lighting/reflections but shows a plain colour (or set `render.film_transparent = True` for compositing).

## Emission and practicals

- Emission Strength 5-20 for visible lamps/neon in EEVEE, plus bloom (look_preset `bloom: true`). In Cycles, emissive meshes do light the scene; in EEVEE they mostly do not — add a point/area light at the practical's position for its spill.
- Candle 1800 K, tungsten 2700-3200 K, fluorescent 4000-5000 K, daylight 5600-6500 K, overcast/shade 7000-9000 K, moonlight 4100 K physically but rendered blue-ish (8000-10000 K) by convention.

## Checks

- Turn lights off one at a time: each should have a visible job.
- Squint test on a screenshot: is the subject the brightest/most contrasty area?
- Look at the histogram-ish palette from `reference_compare`: are your darks as dark as the references'?

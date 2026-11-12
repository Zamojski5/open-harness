# Effect recipes

Every code block below was run in EffectCraft 0.17 (headless MCP, 1280×720) and checked visually with `render_preview`; bullet variants marked *(untested)* are tuning advice built on the same effect. Scale pixel values ×1.5 for 1920×1080. Effect names work in `add_effect` (`"effect":"Glow"`); ids (`ec.stylize.glow`) are what `list_effects` returns. Parameter ids nested in groups use slashes (`"tweaking/intensity"`). Colours accept `"#rrggbb"`.

Before using an effect not listed here: `list_effects {"filter":"<name>"}` for its parameter ids, ranges and enum values.

**Point parameters** (`center`, `origin`, `start`, `end`…) are pixels in effect space. On text/shape layers `[w/2,h/2]` = the layer's anchor, not the comp centre — put light generators on a solid/adjustment layer.

## Glow (text, logos, neon)

```json
add_effect {"layer":"Title","effect":"Glow","values":{"threshold":45,"radius":40,"intensity":1.5}}
```
- Params: `based` (0 alpha, 1 colour), `threshold` %, `radius` px, `intensity`, `operation` (composite original 0 on top / 1 behind), `glowOperation` (1 Add, 3 Screen), `colors` (0 original, 1 A&B with `colorA`, `colorB`).
- Layered glow *(untested)*: stack two Glows — tight (`radius 8–15, intensity 1`) + wide (`radius 60–120, intensity 0.6–1`). Neon: coloured text + `colors:1`, `colorA` = core tint.
- Keep threshold 40–60 on white text, lower (20–30) on dark/coloured art.

## Light rays (volumetric streaks from a source)

```json
command_run {"id":"layer.newAdjustment","params":{"name":"Rays"}}
add_effect {"layer":"Rays","effect":"CC Light Rays","values":{"intensity":50,"center":[640,330],"radius":150,"warpSoftness":60,"transferMode":2}}
```
- Rays are cast from bright pixels inside `radius` around `center`, pushed outward. `transferMode`: 0 Add, 1 Lighten, 2 Screen, 3 None. `colorFromSource` true by default; set false + `color` to tint.
- Keep `intensity` 40–80 and `radius` 100–200; above ~150 intensity the zoom copies show visible steps (see known-issues). Animate `center` slowly (a drifting light) or key `intensity` 0 → 60 → 30 for a reveal.
- Brighter rays: put the rays on a precomp/duplicate of only the bright element, blend Add.

## Light sweep / sheen across text

Effect version (subtle, narrow):
```json
add_effect {"layer":"Title","effect":"CC Light Sweep","values":{"center":[640,360],"direction":-25,"width":60,"sweepIntensity":400,"edgeIntensity":300,"edgeThickness":3,"shape":2,"lightColor":"#ffe2a0"}}
add_keyframe {"layer":"Title","path":"effects/#1/center","keys":[{"time":0.5,"value":[100,360]},{"time":2.0,"value":[1180,360]}],"interpolation":"easyEase"}
```
`width` is narrow (60 ≈ one 170 px letter); the default intensity 50 is almost invisible — use 300–500.

Robust matte version (soft, broad, controllable — preferred for hero titles):
```json
command_run {"id":"layer.newText","params":{"text":"AURORA","name":"SheenMatte","size":170,"fill":"#ffffff","justify":"center","position":[640,420],"tracking":120}}
command_run {"id":"layer.newShape","params":{"kind":"rect","name":"Sheen","size":[120,900],"fill":"#ffffff","position":[200,360]}}
set_property {"layer":"Sheen","path":"transform/rotation","value":20}
add_effect {"layer":"Sheen","effect":"Gaussian Blur","values":{"blurriness":40,"dimensions":1}}
add_keyframe {"layer":"Sheen","path":"transform/position","keys":[{"time":0.5,"value":[150,360]},{"time":1.7,"value":[1130,360]}],"interpolation":"easyEase"}
command_run {"id":"layer.arrange","params":{"layers":["SheenMatte"],"to":"front"}}
command_run {"id":"layer.setTrackMatte","params":{"layer":"Sheen","matte":"SheenMatte","kind":"alpha"}}
command_run {"id":"layer.setBlendMode","params":{"layers":["Sheen"],"mode":"Add"}}
```
The matte text must match the title exactly (same text/size/position/tracking). Lower `Sheen` opacity to 50–70 % for metal, 100 % for a flash.

## Particles: embers, dust, sparks (CC Particle World)

```json
command_run {"id":"layer.newSolid","params":{"name":"Sparks","color":"#000000"}}
add_effect {"layer":"Sparks","effect":"CC Particle World","values":{"birthRate":2.5,"longevity":1.6,"producer/producerY":0.25,"producer/radiusX":0.6,"physics/animation":1,"physics/velocity":0.35,"physics/gravity":-0.15,"physics/extraAngle":40,"particle/particleType":2,"particle/birthSize":0.04,"particle/deathSize":0.01,"particle/birthColor":"#ffd27a","particle/deathColor":"#ff4a10","particle/transferMode":2}}
command_run {"id":"layer.setBlendMode","params":{"layers":["Sparks"],"mode":"Add"}}
```
- Producer coordinates are in effect-world units (≈ −0.5…0.5 across the frame, Y down positive); `radiusX/Y/Z` spread the emitter.
- `physics/animation`: 0 Explosive, 1 Direction Axis, 2 Cone Axis, 3 Viscous, 4 Twirly, 5 Vortex, 6 Fire, 7 Jet Sideways, 8/9 Fractal. `gravity` negative = particles rise.
- `particle/particleType`: 0 Line, 1 Shaded Sphere, 2 Faded Sphere (soft dots — best default), 3 Bubble, 4 Star, 5–8 polygons/cubes/textured.
- Dust motes *(untested)*: birthRate 0.5, longevity 4, velocity 0.05, gravity 0, size 0.01–0.02, white at 40 % opacity; add `Gaussian Blur 2` on a duplicate for depth.
- *(untested)* Snow/rain shortcuts: `CC Snowfall`, `CC Rainfall` (`list_effects` for params). Bursts: `physics/animation 0`, key `birthRate` 20 → 0 over 3 frames.
- Particles need warm-up: start the layer ~1 s before the comp (`layer.timing {"layers":["Sparks"],"start":-1}`) so the first frame is not empty (verified: empty at 0 s without it, populated with it). Moving the start also moves the out point 1 s earlier — follow with `layer.timing {"layers":["Sparks"],"out":<comp duration>}`.

## Fog / smoke / atmosphere (Fractal Noise)

```json
command_run {"id":"layer.newSolid","params":{"name":"Fog","color":"#000000"}}
add_effect {"layer":"Fog","effect":"Fractal Noise","values":{"fractalType":0,"noiseType":3,"contrast":70,"brightness":-20,"transform/uniformScaling":false,"transform/scaleWidth":500,"transform/scaleHeight":220,"complexity":5,"subSettings/subInfluence":60}}
set_property {"layer":"Fog","path":"effects/#1/evolution","expression":"time*40"}
set_property {"layer":"Fog","path":"effects/#1/transform/offset","expression":"[640 + time*30, 360]"}
add_effect {"layer":"Fog","effect":"Tint","values":{"black":"#000000","white":"#7d93ad"}}
command_run {"id":"layer.setBlendMode","params":{"layers":["Fog"],"mode":"Screen"}}
set_property {"layer":"Fog","path":"transform/opacity","value":45}
command_run {"id":"layer.addMask","params":{"layer":"Fog","shape":"rect","rect":[0,300,1280,420]}}
command_run {"id":"layer.mask.set","params":{"layer":"Fog","field":"feather","value":200}}
```
- Wide `scaleWidth` vs `scaleHeight` = layered horizontal mist. Feathered mask keeps it near the ground. 30–60 % opacity; two fog layers at different scales/speeds read as depth.
- Smoke *(untested)*: `fractalType 1` (Turbulent Smooth), contrast 120, evolution `time*80`, offset drifting upwards.
- Loopable noise *(untested)*: `evolutionOptions/cycleEvolution` true, `evolutionOptions/cycle` = whole revolutions, and evolution keyed 0 → 360×cycle over the loop length.
- Also a texture: `blendingMode` 3 (Multiply) on a coloured layer makes grime/noise fill (used in the track-matte test).

## Lightning strike + flash

```json
command_run {"id":"layer.newSolid","params":{"name":"Bolt","color":"#000000"}}
add_effect {"layer":"Bolt","effect":"Advanced Lightning","values":{"lightningType":1,"origin":[700,0],"direction":[560,600],"coreSettings/coreRadius":2.5,"glowSettings/glowRadius":40,"glowSettings/glowColor":"#5a7dff","forking":35,"compositeOnOriginal":false}}
set_property {"layer":"Bolt","path":"effects/#1/conductivityState","expression":"time*12"}
command_run {"id":"layer.setBlendMode","params":{"layers":["Bolt"],"mode":"Add"}}
command_run {"id":"layer.timing","params":{"layers":["Bolt"],"in":1.0,"out":1.3}}
command_run {"id":"layer.newSolid","params":{"name":"Flash","color":"#dfe8ff"}}
command_run {"id":"layer.setBlendMode","params":{"layers":["Flash"],"mode":"Add"}}
add_keyframe {"layer":"Flash","path":"transform/opacity","keys":[{"time":0.97,"value":0},{"time":1.0,"value":70},{"time":1.07,"value":10},{"time":1.13,"value":45},{"time":1.4,"value":0}]}
```
- `conductivityState` animated = the bolt crawls/flickers; keep the bolt visible 6–10 frames. Double-flash (70 → 10 → 45 → 0) reads as real lightning.
- `lightningType`: 0 Direction, 1 Strike, 2 Breaking, 3 Bouncy, 4 Omni, 5 Anywhere, 6 Vertical, 7 Two-Way Strike. Thicker hero bolt: coreRadius 4–6, glowRadius 80.
- Sync the flash frame to the thunder/sub hit in the soundtrack.

## Grading stack (adjustment layer on top of everything)

```json
command_run {"id":"layer.newAdjustment","params":{"name":"GRADE"}}
add_effect {"layer":"GRADE","effect":"Lumetri Color","values":{"basicCorrection/tone/contrast":25,"basicCorrection/tone/highlights":-20,"basicCorrection/tone/blacks":-15,"basicCorrection/saturation":85,"creative/look":5,"creative/lookIntensity":60,"creative/adjustments/fadedFilm":10}}
add_effect {"layer":"GRADE","effect":"Curves","values":{"rgb":"0,0.03 0.25,0.2 0.75,0.8 1,0.97"}}
add_effect {"layer":"GRADE","effect":"Exposure","values":{"master/exposure":-0.2}}
```
- Lumetri built-in looks (`creative/look`): 2 EC Warm Film, 3 EC Cool Night, 4 EC Bleach Bypass, 5 EC Teal & Orange, 6 EC Faded Matte, 7 EC Monochrome; 1 Custom with `creative/lookFile` (.cube). Verified on a gradient: Teal & Orange pushes shadows to teal and highlights to cream.
- Split-tone by hand: `creative/adjustments/shadowTint` `#3f6f8f` + `highlightTint` `#d9a066` (verified).
- Curves strings are `x,y` pairs 0–1 separated by spaces, per channel `rgb|red|green|blue`. The S-curve above lifts black to 3 % and rolls white to 97 % (a film-like matte).
- LUT *(untested)*: `Apply Color LUT` (`ec.utility.applylut`). Colour-managed EXR: OCIO effects.
- Effect order matters; reorder with `effect.reorder {layer, effect, index}`.

## Film look (adjustment layer above the grade)

```json
command_run {"id":"layer.newAdjustment","params":{"name":"FILM"}}
add_effect {"layer":"FILM","effect":"VR Chromatic Aberrations","values":{"aberrationRed":6,"aberrationBlue":-6,"falloff":60}}
add_effect {"layer":"FILM","effect":"CC Vignette","values":{"amount":60,"angleOfView":70}}
add_effect {"layer":"FILM","effect":"Add Grain","values":{"preset":1,"tweaking/intensity":0.6,"tweaking/size":1.2}}
command_run {"id":"layer.newSolid","params":{"name":"Letterbox","color":"#000000"}}
command_run {"id":"layer.addMask","params":{"layer":"Letterbox","shape":"rect","rect":[0,88,1280,544],"mode":"Subtract"}}
```
- Aberration: `VR Chromatic Aberrations` works on flat frames — red/blue fringes grow toward the edges (`falloff`). Keep ±3–8; more looks broken.
- Vignette: `CC Vignette amount` 40–60 subtle, 100 heavy (verified on grey). Alternative with feather control: Lumetri `vignette/vignetteAmount` −1 … −2, `vignette/vignetteFeather` 60–80.
- Grain: `preset` 1 Fine 35mm, 2 Coarse 16mm, 3 Vintage 8mm, 4 Video Noise, 5 Monochrome High Speed; `tweaking/intensity` 0.3–0.8. Grain sits **above** the grade and below the letterbox.
- Letterbox: 2.39:1 in 1920×1080 → `rect [0,132,1920,816]`; in 1280×720 → `[0,88,1280,544]`. Keep titles inside the picture area.
- Optional *(untested)*: `Glow` with threshold 80, radius 60, intensity 0.3 on the FILM layer = halation-ish bloom.

## Utility recipes (verified)

| Need | Call |
|---|---|
| Soft shadow under text | `add_effect {"effect":"Drop Shadow","values":{"opacity":70,"distance":6,"softness":12}}` (`direction` 135 default) |
| Organic wobble / heat | `Turbulent Displace {"amount":40,"size":60,"complexity":2}` + `effects/#1/evolution` expression `time*120` |
| Motion trail | precompose the moving layer, then `Echo {"echoTime":-0.033,"numberOfEchoes":8,"decay":0.7,"echoOperator":5}` on the precomp (Echo on the moving layer itself does nothing — it echoes source pixels, not transforms) |
| Soft wipe reveal | `Linear Wipe {"completion":50,"angle":90,"feather":60}`, key `completion` 100 → 0 |
| Speed smear | `Directional Blur {"direction":90,"length":20}` (90 = horizontal), key length with the motion |
| Background gradient | `Gradient Ramp {"start":[960,200],"end":[960,1080],"startColor":"#1b2a44","endColor":"#020306","shape":1}` (1 radial) on a solid |
| Gaussian blur | `Gaussian Blur {"blurriness":40,"dimensions":0}` (1 horizontal, 2 vertical) |

Other families worth knowing (ids via `list_effects`): Lens Flare, CC Light Burst 2.5, Camera Lens Blur (bokeh), Radial Blur (zoom transitions), CC Star Burst, Shatter, Card Dance, CC Glass, Displacement Map, Keylight (green screen), Cryptomatte / EXtractoR (Blender passes), Warp Stabilizer, Timewarp.

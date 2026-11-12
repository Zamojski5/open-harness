# Project structure

Core calls below were run against EffectCraft 0.17 (headless MCP) and checked with `render_preview`; items marked *(untested)* are from the command docs. `command_run {id, params}` = engine command; tool names without a prefix are `mcp__effectcraft__<name>`.

## Compositions

```json
command_run {"id":"comp.new","params":{"name":"Main","width":1920,"height":1080,"frameRate":30,"duration":6,"background":"#05070c"}}
```
- Returns `{"comp": id}` and makes it active. Other params: `pixelAspect`, `shutterAngle`, `motionBlurSamples`, `renderer: classic3D|advanced3D`, `startTimecode`.
- Change later: `comp.settings {comp?, width, height, duration, frameRate, background, shutterAngle…}`.
- Switch comps: `comp.open {"comp":"Main"}`. Most commands act on the active comp unless given `comp`.
- Comp-wide switches: `comp.setSwitch {"switch":"motionBlur","value":true}` (also `hideShy`, `frameBlending`, `draft3d`).

## Layer types

| Need | Command | Notes |
|---|---|---|
| Solid / background | `layer.newSolid {name, color, width?, height?}` | defaults to comp size |
| Adjustment layer | `layer.newAdjustment {name}` | effects apply to everything below |
| Null controller | `layer.newNull {name}` | parent target, holds Slider/Checkbox controls |
| Text | `layer.newText {...}` | see text-and-shapes.md |
| Shape | `layer.newShape {kind, ...}` | see text-and-shapes.md |
| Camera / light | `layer.newCamera`, `layer.newLight` | below |
| Footage / precomp in a comp | `layer.addItem {item: id|name, time?, index?, position?}` | item ids from `get_project` |
| 3D primitive / model | `layer.new3dPrimitive {kind: cube|sphere|plane|torus|cone|cylinder}`, `layer.newModel {path: .glb/.gltf/.obj/.fbx}` | switches comp to Advanced 3D |

## Order, timing, blend modes

- Stack order: `layer.arrange {"layers":["Title"],"to":"front"}` (`front|forward|backward|back`) or `{"layers":[...],"above":"Other"}`. New layers go on top.
- Timing (comp seconds): `layer.timing {"layers":["Bolt"],"in":1.0,"out":1.3}`; move a layer: `{"layers":["Scene 2"],"start":5.1}`. Stagger *(untested)*: `layer.sequence {layers, overlap, duration}` or `layer.quickOffset {delta}`.
- Blend mode: `layer.setBlendMode {"layers":["Fog"],"mode":"Screen"}` (Normal, Add, Screen, Multiply, Overlay, Soft Light, …). Use Add/Screen for light, glow, particles, flashes; Multiply for grime and shadows.
- Opacity: `set_property {"layer":"Fog","path":"transform/opacity","value":45}`.
- Switches: `layer.setSwitch {"layers":[...],"switch":"threeD|motionBlur|adjustment|shy|lock|solo|video|guide|collapse","value":true}`.

## Nulls and parenting (controller rig)

```json
command_run {"id":"layer.newNull","params":{"name":"CTRL"}}
add_effect {"layer":"CTRL","effect":"Slider Control","values":{"slider":45}}
command_run {"id":"layer.setParent","params":{"layers":["Ring","Box"],"parent":"CTRL"}}
```
- Parent everything that moves as a unit (logo parts, a lower third) to one null; animate the null.
- Expression link to the slider: see animation-and-expressions.md.
- Unparent: `"parent": null`.

## Precompose

```json
command_run {"id":"layer.precompose","params":{"layers":["Dot","Label"],"name":"Dot Pre","mode":"move"}}
```
- Returns `{"comp": newCompId, "layer": precompLayerId}`; the new precomp replaces the layers in the parent comp.
- Use for: a logo built from several layers, anything that needs one shared effect/matte, a loop you want to time-remap or duplicate.
- A precomp layer shows nothing outside its nested comp's time span. Collapse transformations: `layer.setSwitch {switch:"collapse"}`.

## Masks

```json
command_run {"id":"layer.addMask","params":{"layer":"Fog","shape":"rect","rect":[0,300,1280,420]}}
command_run {"id":"layer.mask.set","params":{"layer":"Fog","field":"feather","value":200}}
```
- `shape`: `rect|ellipse|rounded|polygon|star`; `rect` is `[x, y, w, h]` in layer pixels.
- `mode` on creation or `layer.mask.mode {mode: Add|Subtract|Intersect|Lighten|Darken|Difference|None}`.
- `layer.mask.set {field: feather|opacity|expansion, value}`.
- Letterbox in one layer: black comp-sized solid + rect mask over the picture area with `"mode":"Subtract"` (2.39:1 in 1280×720: `rect [0,88,1280,544]`; in 1920×1080: `[0,132,1920,816]`).

## Track mattes

```json
command_run {"id":"layer.arrange","params":{"layers":["MatteText"],"to":"front"}}
command_run {"id":"layer.setTrackMatte","params":{"layer":"Fill","matte":"MatteText","kind":"alpha"}}
```
- `kind`: `alpha|alphaInverted|luma|lumaInverted`. The matte layer is hidden automatically (its `video` switch turns off in `get_comp`).
- Text-filled-with-texture, sheen passes, wipes through shapes, reveal behind a moving bar: all are a fill layer + a matte layer.
- A matte layer can only serve one layer; for a second one, create another matte layer (e.g. a second text layer with the same params).

## 3D: layers, camera, lights

```json
command_run {"id":"layer.setSwitch","params":{"layers":["Title","Floor"],"switch":"threeD","value":true}}
set_property {"layer":"Floor","path":"transform/rotationX","value":90}
command_run {"id":"layer.newCamera","params":{"name":"Cam","type":"twoNode","preset":"35mm","position":[640,200,-1400],"poi":[640,440,0]}}
add_keyframe {"layer":"Cam","path":"transform/position","keys":[{"time":0,"value":[300,200,-1600]},{"time":4,"value":[980,250,-1200]}],"interpolation":"easyEase"}
command_run {"id":"layer.newLight","params":{"kind":"Spot","name":"Key","color":"#ffd9a0","intensity":160,"coneAngle":70,"coneFeather":60,"castsShadows":true}}
command_run {"id":"layer.newLight","params":{"kind":"Ambient","name":"Fill","intensity":25}}
```
- Camera presets: `15mm 20mm 24mm 28mm 35mm 50mm 80mm 135mm 200mm`; depth of field with `dof:true, focusDistance, aperture|fStop, blurLevel` *(untested)*.
- Light kinds: `Parallel|Spot|Point|Ambient|Environment`. Always add an Ambient fill (15–30 %) or unlit faces go black.
- Layer material: `materialOptions/castsShadows` (enum, default 0 = Off), `acceptsShadows` (default 1 = On), `acceptsLights`, `diffuse`, `specularIntensity` — turn castsShadows on for each 3D layer that should throw a shadow (a light's `castsShadows` alone is not enough). Check enum labels with `get_layer`.
- Camera moves for titles: slow push-in (z change 10–20 % over the shot) or lateral drift; keep 2-node POI on the subject.
- One-node camera parented to a null = easy orbit/dolly rig.

## Motion blur

Needs **both** switches:
```json
command_run {"id":"layer.setSwitch","params":{"layers":["Bar"],"switch":"motionBlur","value":true}}
command_run {"id":"comp.setSwitch","params":{"switch":"motionBlur","value":true}}
command_run {"id":"comp.settings","params":{"shutterAngle":180}}
```
Verified: a bar moving 1040 px/s blurs only after the comp switch is on. Use 180° (natural) — 90° for crisp kinetic type, 360° for dreamy.

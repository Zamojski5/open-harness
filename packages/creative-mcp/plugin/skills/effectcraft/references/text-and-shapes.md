# Text and shape layers

Core recipes tested in EffectCraft 0.17 (headless MCP, previews checked); rows/bullets marked *(untested)* are variants of the same mechanism.

## Text layers

```json
command_run {"id":"layer.newText","params":{"text":"OPEN HERNESS","name":"Title","size":150,"fill":"#f2e6c8","tracking":80,"justify":"center","position":[960,560],"font":"Inter","style":"Bold"}}
```
- `position` is the **baseline** point (anchor `[0,0,0]` sits on the baseline at the justified edge/centre). With `justify:"center"` the line is centred on x. For optical vertical centring of caps, put the baseline at `centerY + 0.35 × size`.
- Other attributes: `stroke`, `strokeWidth`, `leading`, `allCaps`, `smallCaps`, `baselineShift`, `fauxBold`, `kerning: metrics|optical`, `box: [x,y,w,h]` (paragraph text that wraps).
- Restyle later or by character range: `layer.setText {"layer":"Title","range":[0,4],"fill":"#ff5500","size":180}`; change the string (keeps style and animators, verified): `layer.setText {"layer":"Title","text":"NEW"}`.
- Fonts: `list_fonts {"query":"…"}` — the query is a substring match (`"Inter"` also returns `…Interface` system fonts). Bundled: **Inter** (Regular, Medium, SemiBold, Bold, Italic) — always available, a safe default. Pass `font` (family) + `style` (one of its styles).
- Polish diacritics (ąćęłńóśźż) render correctly with Inter (verified "ZAŻÓŁĆ GĘŚLĄ JAŹŃ"). Check any other font the same way with a preview before committing.
- Readability over footage: Drop Shadow (`opacity 60–75, distance 4–8, softness 10–16`) or a 20–40 % black bar behind; never rely on thin weights over busy plates.

## Text animators (per-character animation)

Add an animator with the properties it should offset, set the offset values, then animate the range selector.

```json
command_run {"id":"layer.addTextAnimator","params":{"layer":"Title","properties":["position","opacity","blur"]}}
set_property {"layer":"Title","path":"text/animators/animator/properties/position","value":[0,90,0]}
set_property {"layer":"Title","path":"text/animators/animator/properties/opacity","value":0}
set_property {"layer":"Title","path":"text/animators/animator/properties/blur","value":[0,25]}
set_property {"layer":"Title","path":"text/animators/animator/selectors/rangeSelector/advanced/shape","value":1}
add_keyframe {"layer":"Title","path":"text/animators/animator/selectors/rangeSelector/offset","keys":[{"time":0,"value":-100},{"time":1.5,"value":100}],"interpolation":"easyEase"}
```
Result (verified): fully hidden at 0 s, letters rise in left to right with blur, fully set at 1.5 s.

- Paths: the first animator is `text/animators/animator/…`, the second `text/animators/animator#2/…` (the `name` you pass is not used in the path). Confirm with `get_layer {"layer":"Title","flat":true}`.
- Animator property names: `anchor position scale skew rotation opacity transformAll lineAnchor lineSpacing characterOffset characterValue blur fillColor fillHue fillSaturation fillBrightness fillOpacity strokeColor strokeWidth tracking perChar3d`. Add one more to an existing animator: `layer.addTextAnimatorProperty {layer, animator: 1, property: "scale"}`.
- Range selector: `start`, `end`, `offset` (percent), `advanced/units` (0 = %, 1 = index), `advanced/basedOn` (characters / words / lines), `advanced/shape` (0 Square, 1 Ramp Up, …), `advanced/easeHigh`, `advanced/easeLow`, `advanced/randomize`, `advanced/amount`.
- Extra selectors: `layer.addTextSelector {layer, animator, kind: range|wiggly|expression}`. Wiggly selector + position/rotation = jittery "glitch" text *(untested)*.
- Remove all: `text.removeAllAnimators {layers}`.

### Classic text recipes (same pattern, different offsets)

| Look | Animator properties (offset values) | Selector animation |
|---|---|---|
| Rise + fade per letter | position `[0,90,0]`, opacity 0, blur `[0,25]` | shape Ramp Up, offset −100→100 over 1–1.5 s, easyEase |
| Tracking breathe-in *(untested)* | tracking (animator#2) −40 → 0 keyed on the property itself | selector untouched |
| Scale pop per letter (verified) | scale `[0,0,100]`, opacity 0 | offset −100→100 over 0.6 s; add overshoot with a separate layer-scale key 100→104→100 |
| Typewriter | opacity 0 | `start` 0→100 linear, ~12–18 chars/s (verified). The current letter fades in partially; for a hard cut per letter set `advanced/smoothness` 0 |
| Blur-in word by word *(untested)* | blur `[30,30]`, opacity 0 | basedOn words (check the enum value with `get_layer`), offset −100→100 |

Timing guide: 30–60 ms of stagger per character for elegant titles, 15–25 ms for punchy kinetic type; whole word in 0.4–0.8 s.

## Shape layers

```json
command_run {"id":"layer.newShape","params":{"kind":"ellipse","name":"Ring","size":[300,300],"fill":null,"stroke":"#ffcc33","strokeWidth":14,"position":[400,360]}}
```
- `kind`: `rect|rounded|ellipse|star|polygon|none`; `fill: null` = stroke only; `position` = layer position in comp pixels.
- Paths inside: `contents/group/contents/ellipse/size`, `contents/group/contents/stroke/width|color|cap|join|dashes/dash`, `contents/group/contents/fill/color`, `contents/group/transform/*`. Line cap: `set_property {"path":"contents/group/contents/stroke/cap","value":1}` (round).
- Add operators: `layer.addShapeItem {layer, kind}` → returns `{path, uid}` to use directly. Kinds: `group rect ellipse star polygon path fill stroke gfill gstroke trim repeater round offset pucker twist zigzag wiggle merge`.
- Gradient fill (verified): create the shape with `"fill":null` (a solid fill paints over the gradient), add `layer.addShapeItem {kind:"gfill", group:"contents/group"}` (or at the root), then `set_property {"path":"contents/group/contents/gfill/colors","value":["#0080ff","#ffff00"]}`. The default ramp is short and centred — widen it with `…/gfill/start` and `…/gfill/end`.

### Trim-path draw-on (verified)

```json
command_run {"id":"layer.addShapeItem","params":{"layer":"Ring","kind":"trim"}}
add_keyframe {"layer":"Ring","path":"contents/trim/end","keys":[{"time":0,"value":0},{"time":1,"value":100}],"interpolation":"easyEase"}
command_run {"id":"keys.select","params":{"keys":[{"layer":"Ring","path":"contents/trim/end","time":0}]}}
command_run {"id":"keys.velocity","params":{"outSpeed":0,"outInfluence":85}}
```
Strong ease-out start (85 % influence) makes the stroke whip on. Animate `contents/trim/start` 0.15 s later for a travelling segment.

### Repeater (radial bursts, dotted rows)

```json
batch {"steps":[{"command":"layer.newShape","params":{"kind":"ellipse","name":"Dots","size":[40,40]}},{"command":"layer.addShapeItem","params":{"layer":"$1.layer","kind":"repeater"}}],"label":"dots"}
```
Paths: `contents/repeater/copies`, `offset`, `transform/position`, `transform/rotation`, `transform/scale`, `transform/startOpacity`, `transform/endOpacity`. Radial *(untested)*: move the shape off-centre (group position) and set repeater rotation 360/copies.

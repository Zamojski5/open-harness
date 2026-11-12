# Animation, easing, expressions, scripting

Tested in EffectCraft 0.17 (headless MCP); values in replies were checked (`evaluated`, value at a given time). Items marked *(untested)* are from the command docs.

## Keyframes

```json
add_keyframe {"layer":"Title","path":"transform/position","keys":[{"time":0,"value":[-300,540]},{"time":1.2,"value":[960,540]}],"interpolation":"easyEase"}
```
- `interpolation`: `linear | bezier | hold | easyEase`. easyEase = 33 % influence both sides (0→100 over 1 s reads 15.6 at 0.25 s).
- Position on 2D layers is still `[x, y, z]` internally; `[x, y]` is accepted.
- One key at a time: `set_property {layer, path, value, time}`. Static value: omit `time`.
- Hold keys (verified): `"interpolation":"hold"` — values jump at each key. Use for stepped animation, on-twos looks, flashes, text swaps.
- Move/retime keys *(untested)*: `keys.set {layer, path, time, newTime}`; scale timing of a selection: `keys.transform`.

## Custom easing (velocity / influence)

Select keys, then set velocity:
```json
command_run {"id":"keys.select","params":{"keys":[{"layer":"Ring","path":"contents/trim/end","time":0}]}}
command_run {"id":"keys.velocity","params":{"outSpeed":0,"outInfluence":85}}
```
Or one key directly (verified: in-influence 90 on the last key → 97.9 of 100 at 75 % of the time): `keys.setEase {layer, path, time, side: "in"|"out", speed, influence}`.

Ease vocabulary (influence % on out of key A / in of key B):

| Feel | A out | B in | Use |
|---|---|---|---|
| Gentle (default easyEase) | 33 | 33 | neutral moves |
| Expo-out "snap and settle" | 0–10 | 85–95 | titles landing, UI slides in |
| Expo-in "wind-up and leave" | 85–95 | 0–10 | exits |
| Strong both | 75 | 75 | logo moves, camera pushes |
| Linear | – | – | constant spin, scrolling credits, loops that must tile |

Overshoot without expressions: add a key 4–8 % past the target ~0.12 s before the end, then settle.

## Expressions

Set with `set_property {layer, path, expression}`; the reply has `evaluated` (what renders) and `expressionError` if it fails. A syntax error keeps the expression but disables it.

```json
set_property {"layer":"Box","path":"transform/position","expression":"wiggle(2, 30)"}
set_property {"layer":"Box","path":"transform/rotation","expression":"time*90"}
set_property {"layer":"Dot","path":"transform/position","expression":"loopOut(\"pingpong\")"}
set_property {"layer":"Box","path":"transform/rotation","expression":"thisComp.layer(\"CTRL\").effect(\"Slider Control\")(\"Slider\") * time"}
set_property {"layer":"Fog","path":"effects/#1/evolution","expression":"time*40"}
set_property {"layer":"Fog","path":"effects/#1/transform/offset","expression":"[640 + time*30, 360]"}
```
All verified (`loopOut("pingpong")` returns to the midpoint at 1.5 s for keys at 0 and 1 s; the slider link evaluates 45 × 2 = 90 at 2 s).

Useful expressions:
- `wiggle(freq, amp)` — camera shake: `wiggle(8, 6)` on a null the camera is parented to; handheld drift `wiggle(0.6, 20)`.
- `loopOut("cycle")` / `"pingpong"` / `"offset"` — seamless loops from the first and last key. `loopIn` for the start.
- `time * speed` — constant rotation, fractal evolution, texture offset.
- `Math.sin(time * 2 * Math.PI * f) * amp + value` — exact-period oscillation (seamless when the loop length is a multiple of 1/f).
- `linear(t, tMin, tMax, v1, v2)` / `ease(...)` *(ease untested)* — remap one property onto another (e.g. blur from speed).
- `value + [0, Math.sin(time*3)*8]` — float/bob on top of keyframes.
- `seedRandom(index, true); random(0, 100)` — per-layer static variation on duplicates.

Verified: `Math.sin(time*2*Math.PI*0.5)*30` → 30 at 0.5 s; `linear(time,0,1,0,100)` → 50 at 0.5 s; `seedRandom` + `random` gives a stable value. A reference to a missing layer/effect returns `expressionError` and renders the static value — always read the reply.

### Controller pattern
Put every tweakable number on a `CTRL` null as Slider / Checkbox / Color / Point Controls (`ec.control.slider`, param `slider`; `checkbox`; `color`; `point`) and reference them by effect name and parameter name as above. Rename an effect instance so several sliders are distinguishable — there is no rename command; use a script (verified):
`run_script {"code":"var fx=app.project.activeItem.layer('CTRL').property('ADBE Effect Parade').property(1); fx.name='Speed'; fx.name"}` → then `effect("Speed")("Slider")` evaluates. Index addressing also works: `effect(1)(1)`. Link by pick whip without typing (verified): `prop.pickWhip {"layer":"M","path":"transform/rotation","target":{"layer":"N","path":"transform/rotation"}}` writes the reference expression.

## run_script (After Effects-style JavaScript)

```js
app.beginUndoGroup("build");
var c = app.project.activeItem;
var L = c.layers.addNull(); L.name = "S";
var p = L.property("ADBE Transform Group").property("ADBE Rotate Z");
p.setValueAtTime(0, 0); p.setValueAtTime(1, 100);
var e = new KeyframeEase(0, 90);           // speed, influence %
p.setTemporalEaseAtKey(1, [e], [e]); p.setTemporalEaseAtKey(2, [e], [e]);
app.endUndoGroup();
p.valueAtTime(0.25, false);                // the last expression is returned as `result`
```
Verified (returns 3.73 — strong ease). Notes:
- Returns `{ok, result, output, error:{message,line,column}}`; `writeLn()` goes to `output`.
- `app.run(commandId, params)` calls any engine command from a loop — the fastest way to build 20 similar layers (verified: `for(i<5) app.run('layer.newShape',{kind:'ellipse',name:'D'+i,…})`).
- Times in scripts are comp seconds. Match names: `ADBE Transform Group`, `ADBE Position`, `ADBE Scale`, `ADBE Rotate Z`, `ADBE Opacity`, `ADBE Text Properties` → `ADBE Text Document`.
- Text via script: `var tp = t.property("ADBE Text Properties").property("ADBE Text Document"); var d = tp.value; d.fontSize = 110; d.fillColor = [0.95,0.85,0.6]; tp.setValue(d);`
- A script that throws keeps the edits made before the error — always wrap in an undo group so `undo {}` cleans up.

## Batches

- `batch {steps:[{command, params}], label}` — atomic, one undo step, `"$1.layer"` / `"$2.path"` refer to earlier results. Use for "create + configure" units.
- `command_batch {steps:[{id, params}], stop_on_error}` — per-step results, separate undo steps.

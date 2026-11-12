# Known issues and surprises (EffectCraft 0.17.0, tested 2026-10)

Found while verifying the recipes in this skill against the headless MCP (`effectcraft-cli mcp`). Re-check after an EffectCraft update; remove entries that no longer reproduce.

## Rendering quality

1. **CC Light Rays bands at high settings.** On a text layer with `intensity 180, radius 60` the rays show discrete stepped copies (visible "staircase" streaks) instead of a smooth falloff. Workaround: `intensity` 40–80, `radius` 100–200, `warpSoftness` 50+, on an adjustment layer or a precomp of the bright element; add a light Gaussian Blur (4–8) on a duplicate if steps remain.
2. **CC Light Sweep is very faint at defaults.** `sweepIntensity 50` / `width 50` is nearly invisible on light text; `width` is narrow (≈ one letter at 170 px). Use `sweepIntensity` 300–500, `edgeIntensity` 200–300, `shape 2` (Sharp) — or the track-matte sheen recipe (effect-recipes.md), which is more controllable.
3. **Lumetri creative looks are mild at `lookIntensity` 60** on real footage; judge on the actual plate, raise to 100–150 if needed.

## Coordinates and paths

4. **Effect point defaults look normalized but values are pixels.** `list_effects` shows defaults such as `center [0.5, 0.5]`; `add_effect`/`set_property` take effect-space pixels (`[640, 360]`). On text and shape layers effect space is comp-sized but centred on the layer origin, so `[w/2, h/2]` maps to the layer's anchor, not the comp centre (a rays centre of `[640,300]` on text at `y=420` landed at comp `y=360`).
5. **Text animator names are not used in property paths.** `layer.addTextAnimator {"name":"Reveal"}` still yields `text/animators/animator/...`; the second is `animator#2`. Always read paths from `get_layer {flat:true}`.
6. **Text `position` is the baseline**, anchor `[0,0,0]` — a title placed at the comp's vertical centre sits visibly high. Offset the baseline down by ~0.35 × font size.
7. **`layer.timing {start}` moves the out point too.** Starting a 4 s layer at −1 s makes it end at 3 s; set `out` again.

## API surprises

8. **No effect rename command.** `prop.renameGroup {prop:"effects/#1"}` errors (it wants a uid; untested). Rename via `run_script` (`layer.property('ADBE Effect Parade').property(1).name = 'Speed'`).
9. **`effect.reorder` takes `index`**, not `to`: `{layer, effect, index}`.
10. **`easyEase` keys report `"in":"Bezier","out":"Bezier"`** — that is correct (easy ease = Bezier with 33 % influence); verify the curve with `get_property` at an in-between time if in doubt.
11. **Motion blur needs the comp switch** (`comp.setSwitch {"switch":"motionBlur","value":true}`) in addition to the layer switch; the layer switch alone renders sharp.
12. **Echo only echoes source pixels.** On a layer moved by its own Transform it shows no trail; precompose the moving layer and apply Echo to the precomp.
13. **`list_fonts {"query"}` is a substring match** (`"Inter"` also returns `.Arial Hebrew Desk Interface`…). Pick the exact `family`.
14. **Layer ids are not sequential** (4, 35, 66… in one comp). Use names.
15. **PNG sequence output numbering starts at `_0000`**, not `_0001` — adjust ffmpeg `-start_number 0` when encoding from it.
16. **A shape's solid fill hides an added gradient fill.** `layer.newShape` adds a solid `fill` by default; create the shape with `"fill":null` before adding `gfill`, or the gradient is painted under it (looks like nothing happened).
17. **Expression errors fail soft.** A reference to a missing layer/effect keeps the expression, renders the static value and reports `expressionError` in the reply; nothing else warns you.

## Headless vs bridge

18. Headless MCP (`effectcraft-cli mcp`) has no `screenshot` / `ui_*` tools (`-32602 unknown tool`) and renders on CPU unless started with `--gpu`. Work is in memory until `save_project` (or `--autosave`).
19. In Open Herness sessions the `effectcraft` server is started as `mcp --bridge 9877`; nothing works until `effectcraft_launch` has opened the app. A bridged `renderQueue.render` call does not report progress and holds the tool call until it finishes (or use `wait:false` + poll `renderQueue.list`); render long jobs with the headless CLI from a saved project instead.
20. A headless MCP started with `--automation-read-root` / `--automation-write-root` refuses scripts, so `run_script` fails there; use engine commands (`command_run` / `batch`) or run the script through the CLI (`script FILE.jsx`) outside the confined session.
21. `.aep` / `.aepx` projects and After Effects plug-ins cannot be opened or emulated; Lottie export lists every unsupported feature in `warnings` rather than failing.

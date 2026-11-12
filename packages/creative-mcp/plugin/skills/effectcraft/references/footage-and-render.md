# Footage, rendering, saving

Tested in EffectCraft 0.17 (headless MCP + CLI). Imports and every render format in the table were checked with `ffprobe`/previews; items marked *(untested)* come from the command docs.

## Importing renders from Blender (or anything else)

Always pass **absolute paths**.

```json
command_run {"id":"file.import","params":{"paths":["/abs/renders/shot01/frame_0001.png"],"frameRate":24}}
```
- One numbered frame imports its whole run as one Image Sequence item (`plate_[0001-0048].png`). The reply lists new item ids: `{"items":[2], "warnings":[], "unlabeledAlpha":[]}`.
- `frameRate` = the Blender scene fps (sequences otherwise default to 30). Conform later: `file.interpretFootage {"items":[2],"frameRate":24}`. Force stills: `"sequence": false`. A folder imports every run in it.
- Verified: PNG sequence, float OpenEXR sequence (`gbrapf32le`), H.264 MP4 with AAC audio.
- Put it in a comp: `layer.addItem {"item":2, "time":0}` (id or exact item name). Fit a different-size plate: `layer.transform {"layers":["#1"],"op":"fit"}` (`fitWidth`, `fitHeight`, `center`, `reset`).
- Make a comp from footage directly *(untested)*: `project.select` the items, then `file.newCompFromSelection {single:true}` — inherits size, fps, duration.
- Multi-layer EXR from Blender *(untested; from the docs)*: the layer shows the beauty pass; list passes with `layer.channels {layer}` and pull one with the `EXtractoR` effect (`red/green/blue/alpha` = channel names like `"depth.Z"`). Object mattes: `Cryptomatte` effect + `effect.pickCryptomatte {layer, effect:1, x, y}`. Keep float EXRs linear with `file.interpretFootage {"items":[id],"preserveRgb":true}` when doing your own colour transform.
- Alpha: Blender writes PNG RGBA as straight alpha but OpenEXR as **premultiplied** (associated) alpha. If an import lands in `unlabeledAlpha`, or edges look dark/haloed, set the interpretation explicitly with `file.interpretFootage` (see `describe_command file.interpretFootage` for the alpha option).
- Missing media after opening a project: `footage.check {"wait":true}` → `file.findMissing`.

### Handshake with Blender
- Render plates as PNG 16-bit or EXR sequences, not MP4, when they will be graded/composited; MP4 only for previews.
- Render titles/overlays separately (EffectCraft) and comp them over the plate; or render EffectCraft elements with alpha (ProRes 4444 / PNG RGBA) and composite in Blender's compositor or ffmpeg.
- Keep fps identical across Blender, EffectCraft and the edit (24 for cinematic, 30 for social). Never mix 24 and 30 in one cut.

## Render queue

```json
command_run {"id":"renderQueue.add","params":{"comp":"Main","format":"h264","output":"/abs/takes/main-v01.mp4"}}
command_run {"id":"renderQueue.render","params":{"wait":true}}
```
`renderQueue.render` renders every item with status `Queued`; items already `Done` are skipped (verified), so add a new item for each new take. The reply has `failed` and per-item `last_output`. `renderQueue.list`, `renderQueue.remove {index}`, `renderQueue.setRender {index, render:false}` manage the queue.

| Deliverable | `renderQueue.add` params | Verified output |
|---|---|---|
| Review / social MP4 | `"format":"h264"` (+ `"bitrate":20000` kbps for 1080p, `"audio":"on"` to include footage/music audio) | H.264 High, yuv420p, 15 Mbps default; AAC with audio on |
| Draft | add `"resolution":"half"` (or `quality:"draft"`) | 640×360 from a 1280×720 comp |
| Master with alpha (for Blender/ffmpeg/NLE) | `"format":"prores","proresProfile":"4444","channels":"rgba"` | ProRes 4444, yuva444p12le |
| ProRes master without alpha | `"format":"prores","proresProfile":"hq"` (default profile HQ) | |
| PNG sequence | `"format":"png","output":"/abs/out/name_[####].png"` (`"channels":"rgba"` for alpha) | numbering starts at `_0000` |
| GIF | `"format":"gif","loop":true` | looping GIF; prefer ffmpeg palettegen for quality/size (edit-video skill) |
| Web video with alpha | `"format":"webm","channels":"rgba"` | VP9, `alpha_mode=1` |
| Others | `hevc`, `av1`, `jpeg`, `tiff`, `exr`, `wav`, `aiff`, `uncompressed` | see `describe_command renderQueue.add` |

- Output paths must be absolute and their folder should exist. Write into the project's `takes/` folder with a version suffix; never overwrite an earlier take.
- Single still: `comp.saveFrameAs {"path":"/abs/still.png","time":2}`; layered PSD: `comp.saveFrameAsPsd`.
- In the bridged app a blocking render holds the tool call with no progress (`"wait":false` returns at once; poll `renderQueue.list`, stop with `renderQueue.stop`). For anything longer than ~10 s: `save_project`, then render headless from Bash in the background (below) and keep working.

## Lottie

```json
command_run {"id":"file.exportLottie","params":{"comp":"Loop","path":"/abs/takes/loop.json","includeExpressions":true}}
```
- Reply: `{path, bytes, warnings}`. **Read the warnings** — they list everything Lottie cannot show (most effects, footage, cameras/lights, layer styles). Verified: shapes + text + precomp export with no warnings; video/image-sequence layers become nulls.
- Lottie-safe design: shape layers, solids, text (or `"textAsShapes":true` for font independence), masks, mattes, transforms, trim paths, precomps; no raster effects, no blur/glow.
- `.lottie` extension writes a dotLottie archive. Import: `file.importLottie {path}`.

## Saving

```json
save_project {"path":"/abs/project/effectcraft/title-v01.ecproj"}
```
Reply `{"dirty":false,"path":…}`. Save after each milestone and before renders. `open_project {"path":…}` to reopen.

## Headless CLI

`~/.open-herness/bin/effectcraft-cli` — every call is a fresh engine; it loads the demo project unless you pass a project or `--empty`.

```sh
C=~/.open-herness/bin/effectcraft-cli
$C run --empty comp.new '{"name":"Main","width":1280,"height":720,"frameRate":30,"duration":3}' \
   layer.newText '{"text":"CLI","name":"T","size":200,"justify":"center","position":[640,430]}' --save-as cli.ecproj --json
$C set Main T transform/opacity 50 cli.ecproj --save
$C render-frame cli.ecproj --comp Main --time 1 --max-side 480 --out cli.png
$C script --eval 'app.project.item(1).layer(1).name' cli.ecproj --json
$C props Main '#1' --project cli.ecproj            # every property path of layer 1
$C render cli.ecproj --comp Main --out /abs/takes/main-v01.mp4 --format h264 --progress
$C render cli.ecproj --comp Main --out /abs/takes/main-v01.mov --format prores --prores 4444 --channels rgba
```
All verified. `render` options: `--start/--end`, `--resolution half`, `--quality draft`, `--bitrate KBPS`, `--fps N`, `--audio on|off`; `--progress` prints progress lines to stderr. Run long renders with Bash `run_in_background`. GPU: add `--gpu` (headless is CPU by default).

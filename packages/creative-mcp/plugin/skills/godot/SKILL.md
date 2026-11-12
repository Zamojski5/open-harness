---
name: godot
description: Automate the Godot game engine headlessly — run GDScript tools with --script, import assets, export builds with presets, render scenes to frames with --write-movie. Use for games, interactive prototypes, playable web demos, or real-time scenes the user wants in Godot.
---

# Godot

Status: **untested here** (Godot not installed). Commands are for **Godot 4.x**.

## Install / detect

- `brew install --cask godot` (consent first; `godot-mono` for C#). Binary: `/Applications/Godot.app/Contents/MacOS/Godot`.
- Export templates are a separate download (Editor → Manage Export Templates) — required for `--export-*`.

## Headless commands

```bash
# all untested
G=/Applications/Godot.app/Contents/MacOS/Godot
$G --headless --path ./game --import                                   # import assets once (4.2+)
$G --headless --path ./game --script res://tools/build_level.gd        # run a tool script, then quit
$G --headless --path ./game --export-release "Web" build/web/index.html  # preset name from export_presets.cfg
$G --headless --path ./game --export-release "macOS" build/game.zip
$G --path ./game --write-movie out/frames.png --fixed-fps 30 --quit-after 300 res://scenes/intro.tscn  # offline frame capture (needs a window/GPU; not --headless)
```

`--write-movie` with `.avi` writes MJPEG + audio; with `.png` writes a numbered sequence → assemble with ffmpeg.

## Tool script skeleton (`--script`)

```gdscript
# untested
extends SceneTree
func _init():
    var scene := Node3D.new()
    scene.name = "Level"
    var mesh := MeshInstance3D.new(); mesh.mesh = BoxMesh.new(); scene.add_child(mesh); mesh.owner = scene
    var packed := PackedScene.new(); packed.pack(scene)
    ResourceSaver.save(packed, "res://scenes/level.tscn")
    quit()
```

Set `owner` on every child or it won't be saved in the packed scene.

## Assets from our pipeline

Blender → glTF (`blender_script` with `bpy.ops.export_scene.gltf(filepath=..., export_format='GLB')`) → copy into `game/assets/` → `--import`. Textures as PNG, audio as OGG/WAV.

## Playtests

For a game, follow `make-game` (full start -> play -> win/lose -> restart loop). Test with real input, scripted:

- Give the main scene plain game-code hooks (they ship in exports, so keep them harmless): `func snapshot() -> Dictionary` (score, lives, state, player position), optionally `objectives()` and a `gameplay_event(name, data)` signal. Game logic must never detect that a test is running, and tests use their own save path, never the user's saves.
- Write a test driver autoload (e.g. `res://tests/runner.gd`, active only when a user argument such as `-- --scenario=res://tests/run1.json` is passed) that reads steps `{action|key, frames, expect}`, feeds input with `Input.parse_input_event` / `Input.action_press` for N physics frames, compares `snapshot()` fields, writes `user://test-report.json` and quits with a non-zero code on failure.
- Logic-only checks can run with `--headless`; screenshots or a clip need a window (`--write-movie`). Re-run all scenarios after any source change.

## Pitfalls

- `--headless` disables rendering, so it can't capture frames.
- `export_presets.cfg` must exist (create presets once in the editor or write the file).
- Web exports need to be served over HTTP (not `file://`); test with `python3 -m http.server` in the build folder.

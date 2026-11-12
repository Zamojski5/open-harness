# Poly Haven assets (CC0)

Poly Haven publishes HDRIs, PBR textures and models under CC0: free for any use, no attribution required (credit is still kind — `asset.json` records the authors). Always check here before modelling something from primitives or painting a texture.

## Tools

| Tool | What it does |
|---|---|
| `asset_search type=hdris|textures|models [query] [categories] [count]` | Ranked list (id, name, categories, real size, tags) + numbered thumbnail sheet. No query/categories → the category list with counts. |
| `asset_download id [resolution 1k/2k/4k/8k] [format]` | Files into `./assets/polyhaven/<id>/` + `asset.json` (maps by role, authors, license). HDRI `.hdr` (or `exr`); textures all PBR maps as jpg (or png; displacement always 16-bit png); models `.blend` (default) or `gltf` with their textures. |
| `asset_apply_hdri id [strength] [rotation] [show_background] [background_color]` | World lighting in the live scene. |
| `asset_apply_material id object [scale] [rotation] [projection] [normal_strength] [ao_strength] [displacement] [all_slots]` | Full PBR material on a named object (active slot, or all). |
| `asset_import_model id [location] [scale] [rotation] [format] [collection]` | Appends the model into a new collection, parented to an empty "<name> root"; returns size in m and bbox. |

The apply/import tools download on demand (default 2k) and work on the live session only. For headless jobs: `asset_download`, then in `blender_script` load the files yourself (`bpy.data.images.load`, `bpy.data.libraries.load`, `bpy.ops.import_scene.gltf`).

## Searching well

- Categories narrow fast. HDRIs: `outdoor, indoor, studio, night, sunrise-sunset, overcast, skies, urban, nature, high contrast, low contrast`. Textures: `wood, brick, rock, floor, wall, plaster-concrete, terrain, metal, fabric, sand, roofing, asphalt, snow`. Models: `furniture, props, nature, plants, rocks, trees, containers, lighting, tools, decorative, electronics, food, buildings`.
- Query words match id, name, tags and categories (any word counts; more matches rank higher, then popularity): `"forest night"`, `"oak planks"`, `"rusty barrel"`.
- Look at the contact sheet before choosing; pick 2 candidates for important surfaces and compare quickly under your light.

## Resolution

- 1k: background props, distant ground, previews (fast to download/load).
- 2k: default, mid-ground and most hero objects at 1080p.
- 4k: close-ups where texture fills most of the frame, or 4K delivery.
- 8k: almost never (memory).
- HDRIs: 2k is plenty for lighting; when the HDRI is visible as the background behind a 50 mm+ lens, use 4k-8k or replace the background.

## Scale and placement

- Textures: asset_search shows real-world size (e.g. `~2.00x2.00 m`). `scale` = repeats per UV unit; for a 10 m UV-mapped plane (UVs 0-1) and a 2 m texture, `scale=5`. Box projection (meshes without UVs) is per metre: `scale = 1 / texture size`.
- Models are real-world metres. Read `size_m` from the import result and place the root empty: `bpy.data.objects["Barrel_01 root"].location = (x, y, 0)`; `bbox_min` z tells you if it needs lifting to sit on the floor.
- Many copies → don't import repeatedly; import once and use `scripts/scatter.py` with the model (or its collection) as source.

## Combining with your own work

- HDRI for ambient + reflections, then `look_preset.py keep_world=true` for a designed key/rim.
- Model materials are already PBR; to restyle, swap the base colour or use `asset_apply_material` on parts.
- Keep `assets/polyhaven/` in the project so renders stay reproducible; mention used assets (name + "CC0, Poly Haven") in the hand-off.

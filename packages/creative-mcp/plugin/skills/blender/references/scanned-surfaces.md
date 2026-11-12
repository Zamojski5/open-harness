# Scanned surfaces (table, floor, wall, fabric)

A scanned material (Poly Haven, ambientCG) on a large surface can still look like a printed sheet: the tile is stretched or repeats, the colour is one even tone, the relief is weak, and the sheen is uniform. A good scan material needs all of the following.

## What the material must have

1. **Correct tile size from the scan's real size.** Poly Haven lists dimensions (`asset_search` shows e.g. `~2.00x2.00 m`). With box projection (no UVs needed) `scale = 1 / tile size in m`, and it stays right when the object is rescaled later. With clean UVs, scale = surface size / tile size.
2. **Anti-tiling.** Blend in a second sample of the same maps, rotated and shifted, through a large noise mask, so the repeat disappears. Skip this for bricks, tiles and planks (a shifted copy doubles the joints) and never double an opacity cutout.
3. **Large-scale variation** in patches about 1 m across: brightness multiplier 0.92–1.08, roughness offset ±0.05, and the roughness range spread ×1.2. Leave it off for a clean, factory-new surface.
4. **Relief that reads** where the camera is close (below).

Keep variation subtle: stronger values read as blotches or smudges, not wear.

## With our tools

- `asset_apply_material id=<texture> object=<name> scale=<repeats> rotation=… projection=box|uv displacement=<m>` gives the tile size, projection and displacement (point 1 and part of 4).
- Anti-tiling and patch variation are **not** automatic in `asset_apply_material`; add them by hand with `blender_exec` on the created material (nodes are labelled `base_color`, `roughness`, `normal`, …):
  - Second sample: duplicate the image texture nodes, feed them a Mapping node with rotation ~30–60° and a non-integer offset, mix with a Noise Texture (scale ≈ 1 / (2–4 tile sizes)) through a Map Range with a narrow transition.
  - Patches: Noise Texture at ~1 m scale → Map Range 0.92–1.08 multiplied into the colour; a second noise → Map Range ±0.05 added to roughness; a Map Range spreading roughness ×1.2 around its mean.
  - Label the nodes (`large-scale value noise`, `large-scale roughness noise`, `roughness range`) so later rounds can tune them against a reference with `blender_compare_reference`.

## Relief

- Close to camera, displace real geometry (Cycles only): a Subdivision Surface modifier with `use_adaptive_subdivision = True`, `adaptive_space = "PIXEL"`, `adaptive_pixel_size = 1`.
- Keep that modifier **last** in the stack: any modifier after it makes Blender use its fixed levels and the plane renders flat.
- Set the material's `displacement_method = "DISPLACEMENT"`. Use `"BOTH"` only while dicing is still coarse; the default `"BUMP"` moves no geometry.
- Memory on our 24 GB Mac: adaptive dicing at pixel size 1 on a big ground plane is heavy at 4K; check `vm_stat` before the render and limit dicing to the near ground (split the mesh) if free memory is low.

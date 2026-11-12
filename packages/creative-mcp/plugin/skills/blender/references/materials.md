# Materials

Order of preference: (1) Poly Haven PBR texture via `asset_apply_material`, (2) a model's own materials, (3) a procedural node setup below, (4) a flat Principled colour (only for stylised work or far background).

## Scanned PBR (Poly Haven)

`asset_apply_material id=<texture> object=<name> scale=<repeats>` builds: Image Texture (sRGB) → Base Color; ARM split by Separate Color → AO (multiplied into colour at `ao_strength`), Roughness, Metallic; OpenGL normal (Non-Color) → Normal Map → Normal; optional displacement.

- **Tiling:** Poly Haven lists each texture's real size (asset_search shows `~1.80x1.80 m`). On a UV-unwrapped 10 m floor with 0-1 UVs, scale = 10 / 1.8 ≈ 5.5. Box projection (no UVs) works in object space: scale = 1 / texture size in m.
- **Hide repetition** on big surfaces: rotate tiles (`rotation`), add a large-scale Noise Texture mixed into colour/roughness at 10-20 %, scatter debris/decals, or break the surface with geometry.
- **Displacement:** real only in Cycles with a subdivided mesh (Subdivision modifier, `Simple`, render level 3-5 or adaptive). `displacement` 0.02-0.1 m. EEVEE treats it as bump.
- Edit afterwards in `blender_exec`: the material is named after the texture; nodes are labelled `base_color`, `roughness`, `normal`, …

## Procedural recipes (Principled values)

| Material | Base Color | Metallic | Roughness | Other |
|---|---|---|---|---|
| Polished metal (chrome) | #e8e8e8 | 1 | 0.05-0.1 | Needs something to reflect: HDRI or bright cards. |
| Brushed steel | #b8b8b8 | 1 | 0.3 | Anisotropic 0.6; Noise stretched along one axis into Roughness. |
| Gold | #ffc356 (linear ≈ 1.0, 0.55, 0.1) | 1 | 0.15-0.3 | |
| Copper | #f7a07a | 1 | 0.2-0.35 | Patina: mix to #4a9a7a with a Noise mask. |
| Glossy plastic | any | 0 | 0.15-0.3 | Specular IOR Level 0.5. |
| Matte plastic / clay | any | 0 | 0.6-0.8 | |
| Rubber | #1a1a1a | 0 | 0.8-0.95 | |
| Glass | white | 0 | 0-0.05 | Transmission Weight 1, IOR 1.45-1.52. Cycles for real refraction; EEVEE: material `surface_render_method = 'BLENDED'` or raytraced transmission. |
| Water | white | 0 | 0.02 | Transmission 1, IOR 1.33; volume absorption for depth colour. |
| Skin | #c58c6e … | 0 | 0.4-0.5 | Subsurface Weight 0.1-0.3, Radius (1.0, 0.2, 0.1), Scale 0.01-0.05 m. |
| Fabric / velvet | any | 0 | 0.7-0.9 | Sheen Weight 0.3-1, Sheen Tint white. |
| Car paint | colour | 0 | 0.3 | Coat Weight 1, Coat Roughness 0.03. |
| Neon / screen | black | 0 | 0.5 | Emission Color + Strength 5-30, bloom on. |
| Ice | #d8f0ff | 0 | 0.1 | Transmission 0.9, Subsurface a little, normal noise. |

Colour values: pass sRGB hex through the linear conversion before writing `default_value` (see SKILL.md).

## Wear and storytelling

- **Edge wear:** Geometry Pointiness (Cycles) or an Ambient Occlusion node (both engines) into a Color Ramp → mask that mixes in a lighter/rougher material on edges.
- **Dirt in crevices:** inverted AO mask → darker, rougher colour.
- **Grime gradient:** Separate XYZ (Object coords) Z → Color Ramp: darker near the ground.
- **Variation between copies:** Object Info → Random → Hue/Saturation/Value (±5 % value, ±0.02 hue).

## Assigning and checking

```python
obj = bpy.data.objects["Hero"]
mat = bpy.data.materials.new("Hero Paint")
if mat.node_tree is None: mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.6, 0.05, 0.03, 1)
bsdf.inputs["Roughness"].default_value = 0.35
obj.data.materials.clear(); obj.data.materials.append(mat)
```

- Multi-material meshes: assign per slot (`obj.data.materials[i] = mat`), faces use `polygon.material_index`.
- Check with `blender_screenshot shading=material`, then `rendered` under the final light — materials read differently under every light, so finish lighting before fine-tuning roughness.
- Missing textures render pink: list `[(i.name, i.filepath) for i in bpy.data.images]`, fix paths, `image.reload()`.

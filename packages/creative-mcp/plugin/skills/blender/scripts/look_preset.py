# Lighting/look preset for the current Blender scene (Open Herness).
#
# Run it through blender_exec (live) or blender_script (headless): send this file's text as
# `code`, with a first line such as
#   PARAMS = {"preset": "moonlight", "target": "Hero"}
# Parameters (all optional):
#   preset      studio | three_point | rim | moonlight | golden_hour | noir | neon   (default three_point)
#   target      object to light; default = bounding box of visible non-flat meshes (ground planes ignored)
#   strength    multiplier for every light's power (default 1.0)
#   keep_world  True keeps the current world (e.g. a Poly Haven HDRI) instead of the preset's
#   fog         volume density for atmospheric haze (0 = off; 0.02-0.08 subtle, 0.15+ thick)
#   bloom       True adds a compositor Bloom (Glare node); default per preset
#   look        AgX look, e.g. "AgX - Punchy", "AgX - Medium High Contrast" (default per preset)
#   exposure    Film exposure in stops (default 0)
# Re-running replaces the lights made by a previous run (collection "OH Look").
# Sets `result` to a summary dict.

import math

import bpy
from mathutils import Vector

PARAMS = globals().get("PARAMS", {})

# name: (lights, world colour (linear RGB), world strength, look, bloom)
# Each light: (role, type, azimuth deg (0 = in front of target toward camera side, -Y), elevation deg,
#             distance factor, power W (point/spot/area) or W/m2 (sun), colour temperature K, size factor)
PRESETS = {
    "studio": (
        [("key", "AREA", -35, 35, 2.2, 150, 5600, 1.2), ("fill", "AREA", 50, 15, 2.6, 40, 5600, 1.6),
         ("top", "AREA", 0, 85, 2.0, 50, 6000, 1.5), ("rim", "AREA", 160, 25, 2.2, 120, 6500, 0.6)],
        (0.18, 0.18, 0.19), 0.6, "AgX - Base Contrast", False,
    ),
    "three_point": (
        [("key", "AREA", -40, 35, 2.4, 220, 4800, 0.8), ("fill", "AREA", 55, 10, 2.8, 35, 6500, 1.4),
         ("rim", "SPOT", 165, 35, 2.4, 500, 7000, 0.1)],
        (0.02, 0.022, 0.03), 1.0, "AgX - Medium High Contrast", False,
    ),
    "rim": (
        [("rim_left", "AREA", 125, 30, 2.0, 120, 7000, 0.4), ("rim_right", "AREA", -125, 30, 2.0, 120, 7000, 0.4),
         ("front_kiss", "AREA", 0, 10, 3.0, 6, 5000, 1.5)],
        (0.004, 0.004, 0.006), 1.0, "AgX - High Contrast", True,
    ),
    "moonlight": (
        [("moon", "SUN", 150, 35, 0, 1.2, 9000, 0.6), ("sky_fill", "AREA", -60, 50, 3.0, 60, 12000, 2.5)],
        (0.006, 0.009, 0.02), 1.0, "AgX - Medium High Contrast", True,
    ),
    "golden_hour": (
        [("sun", "SUN", -70, 8, 0, 4.0, 3200, 1.5), ("sky_fill", "AREA", 60, 45, 3.0, 120, 9000, 2.5)],
        (0.25, 0.32, 0.5), 0.5, "AgX - Punchy", False,
    ),
    "noir": (
        [("key", "SPOT", -60, 50, 2.4, 500, 4300, 0.05)],
        (0.0, 0.0, 0.0), 0.0, "AgX - Very High Contrast", False,
    ),
    "neon": (
        [("magenta", "AREA", -90, 15, 1.8, 150, None, 0.5), ("cyan", "AREA", 90, 15, 1.8, 150, None, 0.5),
         ("top", "AREA", 0, 80, 2.5, 15, 8000, 1.0)],
        (0.003, 0.002, 0.006), 1.0, "AgX - Punchy", True,
    ),
}
NEON_COLORS = {"magenta": (1.0, 0.05, 0.6), "cyan": (0.0, 0.7, 1.0)}


def _bounds(target_name):
    scene = bpy.context.scene
    if target_name:
        obj = bpy.data.objects.get(target_name)
        if obj is None:
            raise ValueError("No object named %r" % target_name)
        objs = [obj] + [c for c in obj.children_recursive if c.type == "MESH"]
    else:
        # Visible meshes, minus flat ground/backdrop planes (they would make the "subject" huge).
        objs = [o for o in scene.objects if o.type == "MESH" and o.visible_get() and min(o.dimensions) > 0.02 * max(o.dimensions)]
        objs = objs or [o for o in scene.objects if o.type == "MESH" and o.visible_get()]
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type in {"MESH", "CURVE", "FONT", "SURFACE", "META"} for c in o.bound_box]
    if not pts:
        return Vector((0, 0, 1)), 2.0
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return (lo + hi) / 2, max((hi - lo).length, 0.5)


def _collection(name):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    for obj in list(coll.objects):
        data = obj.data
        bpy.data.objects.remove(obj)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)
            elif isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
    return coll


def _world(color, strength):
    scene = bpy.context.scene
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (*color, 1.0)
    bg.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputWorld")
    out.location = (300, 0)
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def _bloom(enabled):
    scene = bpy.context.scene
    if not enabled:
        return
    if hasattr(scene, "compositing_node_group"):  # Blender 5.x
        tree = scene.compositing_node_group
        if tree is None:
            tree = bpy.data.node_groups.new("OH Compositing", "CompositorNodeTree")
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            scene.compositing_node_group = tree
        if any(n.bl_idname == "CompositorNodeGlare" for n in tree.nodes):
            return
        out = next((n for n in tree.nodes if n.bl_idname == "NodeGroupOutput"), None) or tree.nodes.new("NodeGroupOutput")
        src = next((n for n in tree.nodes if n.bl_idname == "CompositorNodeRLayers"), None) or tree.nodes.new("CompositorNodeRLayers")
        glare = tree.nodes.new("CompositorNodeGlare")
        glare.inputs["Type"].default_value = "Bloom"
        glare.inputs["Threshold"].default_value = 0.8
        glare.inputs["Strength"].default_value = 0.35
        glare.inputs["Size"].default_value = 0.6
        src.location, glare.location, out.location = (-400, 0), (-100, 0), (200, 0)
        tree.links.new(src.outputs["Image"], glare.inputs["Image"])
        tree.links.new(glare.outputs["Image"], out.inputs[0])
    scene.render.use_compositing = True


def _fog(coll, center, size, density):
    if density <= 0:
        return None
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    box = bpy.context.active_object
    box.name = "OH Fog"
    box.scale = (size * 4, size * 4, size * 2)
    for c in list(box.users_collection):
        c.objects.unlink(box)
    coll.objects.link(box)
    mat = bpy.data.materials.new("OH Fog")
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    vol = nt.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Density"].default_value = density
    vol.inputs["Anisotropy"].default_value = 0.4  # forward scattering: visible light shafts toward camera
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    box.data.materials.append(mat)
    box.display_type = "WIRE"
    box.hide_select = True
    return box.name


def apply_look(preset="three_point", target=None, strength=1.0, keep_world=False, fog=0.0, bloom=None, look=None, exposure=0.0):
    if preset not in PRESETS:
        raise ValueError("Unknown preset %r; use one of %s" % (preset, ", ".join(PRESETS)))
    lights, world_color, world_strength, default_look, default_bloom = PRESETS[preset]
    scene = bpy.context.scene
    coll = _collection("OH Look")  # clear the previous run first so it does not count in the bounds
    center, size = _bounds(target)
    aim = bpy.data.objects.new("OH Look Target", None)
    aim.location = center
    aim.empty_display_size = size * 0.1
    coll.objects.link(aim)
    made = []
    for role, kind, az, el, dist, power, kelvin, size_f in lights:
        data = bpy.data.lights.new("OH %s" % role, kind)
        az_r, el_r = math.radians(az), math.radians(el)
        reach = max(dist, 1.0) * size
        offset = Vector((math.sin(az_r) * math.cos(el_r), -math.cos(az_r) * math.cos(el_r), math.sin(el_r))) * reach
        if kind == "SUN":
            data.energy = power * strength
            data.angle = math.radians(0.5 + 3 * size_f)  # small angle = crisp shadows
        else:
            # Inverse-square: keep the light on the subject roughly constant whatever the scene size.
            data.energy = power * strength * (reach / 4.0) ** 2
            if kind == "AREA":
                data.shape = "DISK" if role in {"top", "sky_fill"} else "RECTANGLE"
                data.size = size * size_f
                if data.shape == "RECTANGLE":
                    data.size_y = size * size_f * 0.6
            else:
                data.shadow_soft_size = size * size_f
            if kind == "SPOT":
                data.spot_size = math.radians(35)
                data.spot_blend = 0.4
        if kelvin and hasattr(data, "use_temperature"):
            data.use_temperature = True
            data.temperature = kelvin
            data.color = (1, 1, 1)
        elif role in NEON_COLORS:
            data.color = NEON_COLORS[role]
        obj = bpy.data.objects.new("OH %s" % role, data)
        obj.location = center + offset
        coll.objects.link(obj)
        track = obj.constraints.new("TRACK_TO")
        track.target = aim
        track.track_axis = "TRACK_NEGATIVE_Z"
        track.up_axis = "UP_Y"
        made.append(obj.name)
    if not keep_world:
        _world(world_color, world_strength)
    view = scene.view_settings
    view.view_transform = "AgX"
    view.look = look or default_look
    view.exposure = exposure
    _bloom(default_bloom if bloom is None else bloom)
    fog_name = _fog(coll, center, size, fog)
    if fog > 0 and hasattr(scene, "eevee"):
        scene.eevee.volumetric_tile_size = "4"
        scene.eevee.use_volumetric_shadows = True
    return {"preset": preset, "lights": made, "center": [round(v, 3) for v in center], "scene_size_m": round(size, 3), "look": view.look, "fog": fog_name}


result = apply_look(**PARAMS)

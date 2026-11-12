# Look kit v2 + probe-render auto exposure (Open Herness). Runs inside background Blender; look.ts prepends
#   P = json.loads(...)            (parameters)
# Result marker on stdout: OH_LOOK <json> / OH_EXPOSURE <json>.
# Everything the kit adds lives in collection "OH Look v2", nodes/materials named "OH ..." and a scene property
# "oh_look_v2" holding the previous settings, so remove_look() restores the scene.

import json
import math
import os
import time

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

COLL = "OH Look v2"
KEY = "oh_look_v2"
s = bpy.context.scene
r = s.render


def fail(msg):
    raise Exception("OH_ERR " + msg)


# ---------------------------------------------------------------------------------------------
# Named looks: one flat parameter set per look, "layers" lists what the look builds.
#   target: scene-linear middle grey for exposure (day 0.18, golden 0.20, neon/blue hour 0.10-0.12, night 0.08);
#   ceiling (dark looks: p90 never above) and floor (wins over ceiling) as in the exposure spec.
#   rig: lights as (role, type, azimuth deg from the camera side (90 = right, 180 = behind subject), elevation,
#        distance factor, power, kelvin, size factor); fog: amount (density = 3 / visibility * amount);
#   bloom: (threshold, strength); grade: warm/cool soft-light tint (r, g, b, amount).
# ---------------------------------------------------------------------------------------------
LOOKS = {
    "rain-night": dict(target=0.08, ceiling=0.45, floor=0.11, world=((0.004, 0.007, 0.016), 1.0), look="AgX - Medium High Contrast",
        rig=[("moon", "AREA", 150, 50, 3.0, 150, 9500, 2.5), ("rim", "SPOT", 170, 30, 2.5, 400, 7500, 0.1)],
        fog=0.5, aniso=0.6, fog_color=(0.55, 0.65, 0.85), wet=1.0, rain=1.0, bloom=(0.9, 0.4), vignette=0.3, grain=0.2, ca=0.004,
        fstop=2.8, layers=["fog", "rain", "wet", "practicals", "camera"]),
    "fog-forest": dict(target=0.14, ceiling=0.6, floor=0.10, world=((0.35, 0.42, 0.5), 0.6), look="AgX - Base Contrast",
        rig=[("sun", "SUN", 150, 40, 0, 3.0, 5200, 1.0), ("sky", "AREA", 0, 70, 3.0, 120, 8500, 2.5)],
        fog=0.6, aniso=0.7, fog_color=(0.8, 0.88, 0.95), godrays=("leaves", 0.3), sun_volume=1.5, bloom=(1.0, 0.3), vignette=0.25,
        grain=0.15, ca=0.003, layers=["fog", "godrays", "camera"]),
    "sunbeams": dict(target=0.16, floor=0.10, world=((0.3, 0.38, 0.5), 0.5), look="AgX - Medium High Contrast",
        rig=[("sun", "SUN", 140, 32, 0, 5.0, 4800, 0.8)], fog=0.5, aniso=0.75, fog_color=(1.0, 0.97, 0.92),
        godrays=("window", 0.3), sun_volume=3.0, bloom=(0.9, 0.35), vignette=0.25, grain=0.15, layers=["fog", "godrays", "camera"]),
    "neon-interior": dict(target=0.11, ceiling=0.5, floor=0.10, world=((0.003, 0.002, 0.006), 1.0), look="AgX - Punchy",
        rig=[("magenta", "AREA", -90, 15, 1.8, 150, None, 0.5), ("cyan", "AREA", 90, 15, 1.8, 150, None, 0.5),
             ("top", "AREA", 0, 80, 2.5, 15, 8000, 1.0)],
        fog=0.35, aniso=0.5, fog_color=(0.8, 0.7, 1.0), height_fog=False, bloom=(0.7, 0.55), vignette=0.3, grain=0.2, ca=0.004,
        fstop=2.8, layers=["fog", "practicals", "camera"]),
    "night-city": dict(target=0.08, ceiling=0.4, floor=0.11, world=((0.006, 0.01, 0.025), 1.0), look="AgX - High Contrast",
        rig=[("moon", "SUN", 150, 35, 0, 0.5, 11000, 1.0)], fog=0.4, aniso=0.6, fog_color=(0.6, 0.7, 0.9), wet=0.5,
        bloom=(0.8, 0.5), vignette=0.3, grain=0.2, ca=0.004, fstop=2.8, layers=["fog", "wet", "practicals", "camera"]),
    "golden-hour": dict(target=0.20, floor=0.12, world=((0.25, 0.32, 0.5), 0.5), look="AgX - Punchy",
        rig=[("sun", "SUN", 150, 9, 0, 4.0, 3200, 1.5), ("sky", "AREA", 40, 45, 3.0, 120, 9000, 2.5)],
        fog=0.35, aniso=0.7, fog_color=(1.0, 0.8, 0.55), godrays=("leaves", 0.4), sun_volume=1.5, grade=(1.0, 0.82, 0.62, 0.18),
        bloom=(1.2, 0.3), vignette=0.25, grain=0.15, layers=["fog", "godrays", "camera"]),
    "blue-hour": dict(target=0.11, ceiling=0.5, floor=0.11, world=((0.04, 0.07, 0.17), 0.8), look="AgX - Base Contrast",
        rig=[("sky", "AREA", 20, 60, 3.0, 90, 14000, 3.0), ("rim", "SPOT", 165, 25, 2.5, 250, 3000, 0.2)],
        fog=0.4, aniso=0.6, fog_color=(0.55, 0.65, 0.95), grade=(0.55, 0.7, 1.0, 0.15), bloom=(0.9, 0.35), vignette=0.25,
        grain=0.2, layers=["fog", "practicals", "camera"]),
    "misty-dawn": dict(target=0.16, floor=0.10, world=((0.6, 0.62, 0.7), 0.7), look="AgX - Base Contrast",
        rig=[("sun", "SUN", 140, 6, 0, 2.5, 3800, 2.0), ("sky", "AREA", 0, 60, 3.0, 100, 9000, 3.0)],
        fog=0.9, aniso=0.6, fog_color=(0.9, 0.9, 0.95), godrays=("leaves", 0.35), sun_volume=2.0, bloom=(1.2, 0.25), vignette=0.2,
        grain=0.15, layers=["fog", "godrays", "camera"]),
    "overcast": dict(target=0.18, floor=0.12, world=((0.62, 0.65, 0.7), 1.0), look="AgX - Base Contrast",
        rig=[("sky", "AREA", 0, 85, 3.0, 220, 7500, 4.0)], fog=0.1, aniso=0.5, fog_color=(0.85, 0.88, 0.92), bloom=(1.5, 0.15),
        vignette=0.15, grain=0.1, layers=["fog", "camera"]),
    "studio-product": dict(target=0.18, floor=0.12, world=((0.18, 0.18, 0.19), 0.6), look="AgX - Base Contrast",
        rig=[("key", "AREA", -35, 35, 2.2, 150, 5600, 1.2), ("fill", "AREA", 50, 15, 2.6, 40, 5600, 1.6),
             ("top", "AREA", 0, 85, 2.0, 50, 6000, 1.5), ("rim", "AREA", 160, 25, 2.2, 120, 6500, 0.6)],
        bloom=(2.0, 0.1), vignette=0.15, grain=0.1, layers=["camera"], fstop=5.6),
    "wet-product": dict(target=0.16, floor=0.12, world=((0.12, 0.13, 0.15), 0.6), look="AgX - Medium High Contrast",
        rig=[("key", "AREA", -40, 35, 2.2, 160, 5200, 1.0), ("rim", "AREA", 150, 30, 2.2, 160, 7500, 0.5),
             ("top", "AREA", 0, 85, 2.0, 40, 6000, 1.5)],
        wet=1.0, puddles=False, bloom=(1.6, 0.15), vignette=0.2, grain=0.1, layers=["wet", "camera"], fstop=4.0),
}
# Base values; also what a single layer uses when asked for without a look name (neutral grey day).
NEUTRAL = dict(target=0.18, floor=0.12, look="AgX - Base Contrast", fog=0.5, aniso=0.6, fog_color=(0.85, 0.88, 0.95), height_fog=True,
               godrays=("leaves", 0.3), sun_volume=2.0, wet=0.8, puddles=True, rain=0.8, bloom=(1.0, 0.25), vignette=0.25, grain=0.2,
               ca=0.004, fstop=4.0, rig=[("sun", "SUN", 140, 38, 0, 3.0, 5600, 1.0)], world=None)
LAYERS = ["rig", "fog", "godrays", "practicals", "wet", "rain", "camera", "post"]


# ---------------------------------------------------------------------------------------------
# Scene helpers
# ---------------------------------------------------------------------------------------------
def meshes():
    return [o for o in s.objects if o.type == "MESH" and o.visible_get() and not o.name.startswith("OH ")]


def corners(o):
    return [o.matrix_world @ Vector(c) for c in o.bound_box]


def screen_box(o, cam):
    pts = [world_to_camera_view(s, cam, p) for p in corners(o)]
    if any(p.z <= 0 for p in pts):
        return None
    x0, x1 = max(0.0, min(p.x for p in pts)), min(1.0, max(p.x for p in pts))
    y0, y1 = max(0.0, min(p.y for p in pts)), min(1.0, max(p.y for p in pts))
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def pick_hero(cam):
    """The non-flat mesh with the largest, most central screen box (ground planes and room shells ignored)."""
    best, score = None, 0.0
    for o in meshes():
        d = o.dimensions
        if max(d) <= 0 or min(d) < 0.03 * max(d):
            continue
        b = screen_box(o, cam)
        if not b:
            continue
        area = (b[2] - b[0]) * (b[3] - b[1])
        if area > 0.85:
            continue
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        sc = area * (1.2 - math.hypot(cx - 0.5, cy - 0.5))
        if sc > score:
            best, score = o, sc
    return best


def subject(cam, hero):
    """Subject centre (m), size (m), distance camera -> subject."""
    if hero is not None:
        pts = [p for o in [hero] + [c for c in hero.children_recursive if c.type == "MESH"] for p in corners(o)]
    else:
        pts = [p for o in meshes() for p in corners(o)]
    if not pts:
        return Vector((0, 0, 1)), 2.0, 5.0
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (lo + hi) / 2
    return c, max((hi - lo).length, 0.5), max((c - cam.matrix_world.translation).length, 0.5)


def scene_extent(cam):
    pts = [p for o in meshes() for p in corners(o)] + [cam.matrix_world.translation]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    depth = max((cam.matrix_world.translation - p).length for p in pts)
    return lo, hi, depth


def add_obj(coll, name, data):
    o = bpy.data.objects.new(name, data)
    coll.objects.link(o)
    return o


def new_mat(name):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    m.node_tree.nodes.clear()
    return m


# ---------------------------------------------------------------------------------------------
# Remove / undo
# ---------------------------------------------------------------------------------------------
def remove_look():
    raw = s.get(KEY)
    prev = json.loads(raw) if raw else {}
    coll = bpy.data.collections.get(COLL)
    if coll:
        for o in list(coll.objects):
            data = o.data
            bpy.data.objects.remove(o)
            if data is not None and data.users == 0:
                for reg in (bpy.data.lights, bpy.data.meshes):
                    if data.name in reg and reg[data.name] == data:
                        reg.remove(data)
                        break
        bpy.data.collections.remove(coll)
    for m in list(bpy.data.materials):
        if m.name.startswith("OH ") and m.users == 0:
            bpy.data.materials.remove(m)
    for g in list(bpy.data.node_groups):
        if g.name == "OH Height Fog" and g.users == 0:
            bpy.data.node_groups.remove(g)
    wet = unwet()
    post = unpost()
    p = prev.get("prev", {})
    if p:
        s.view_settings.exposure = p.get("exposure", 0.0)
        s.view_settings.view_transform = p.get("view_transform", s.view_settings.view_transform)
        try:
            s.view_settings.look = p.get("look", "None")
        except TypeError:
            pass
        w = bpy.data.worlds.get(p.get("world", ""))
        if w is not None:
            s.world = w
        r.use_compositing = p.get("use_compositing", r.use_compositing)
        for n in p.get("lights_off", []):
            if n in bpy.data.objects:
                bpy.data.objects[n].hide_render = False
        cam = s.camera
        if cam is not None and p.get("dof"):
            d = p["dof"]
            cam.data.dof.use_dof = d["use"]
            cam.data.dof.aperture_fstop = d["fstop"]
            cam.data.dof.focus_object = bpy.data.objects.get(d["focus"]) if d["focus"] else None
    for w in list(bpy.data.worlds):
        if w.name.startswith("OH ") and w.users == 0:
            bpy.data.worlds.remove(w)
    if KEY in s:
        del s[KEY]
    return {"removed": bool(raw or coll), "was": prev.get("name"), "wet_materials_restored": wet, "post_nodes_removed": post}


# ---------------------------------------------------------------------------------------------
# Rig + world
# ---------------------------------------------------------------------------------------------
def direction(cam, az, el):
    f = cam.matrix_world.to_quaternion() @ Vector((0, 0, -1))
    f.z = 0
    f = f.normalized() if f.length > 1e-4 else Vector((0, 1, 0))
    right = f.cross(Vector((0, 0, 1)))
    a, e = math.radians(az), math.radians(el)
    return ((-f * math.cos(a) + right * math.sin(a)) * math.cos(e) + Vector((0, 0, math.sin(e)))).normalized()


def make_light(coll, aim, role, kind, d, reach, power, kelvin, size, size_f, gain, color=None):
    data = bpy.data.lights.new("OH " + role, kind)
    if kind == "SUN":
        data.energy = power * gain
        data.angle = math.radians(0.5 + 3 * size_f)
    else:
        data.energy = power * gain * (reach / 4.0) ** 2
        if kind == "AREA":
            data.shape = "DISK" if role in {"top", "sky"} else "RECTANGLE"
            data.size = size * size_f
            if data.shape == "RECTANGLE":
                data.size_y = size * size_f * 0.6
        else:
            data.shadow_soft_size = size * size_f * 0.3
        if kind == "SPOT":
            data.spot_size = math.radians(40)
            data.spot_blend = 0.4
    if kelvin and hasattr(data, "use_temperature"):
        data.use_temperature = True
        data.temperature = kelvin
        data.color = (1, 1, 1)
    if color:
        data.color = color
    obj = add_obj(coll, "OH " + role, data)
    obj.location = aim.location + d * (1 if kind == "SUN" else reach)
    c = obj.constraints.new("TRACK_TO")
    c.target, c.track_axis, c.up_axis = aim, "TRACK_NEGATIVE_Z", "UP_Y"
    return obj


def blocked_fraction(center, size, to_sun, n=5):
    """Share of sample points around the subject whose ray towards the sun hits scene geometry."""
    dg = bpy.context.evaluated_depsgraph_get()
    hits = 0
    step = size * 0.5 / max(1, n // 2)
    for i in range(n):
        for j in range(n):
            o = center + Vector(((i - n // 2) * step, (j - n // 2) * step, size * 0.15))
            origin = o + to_sun * 0.02
            for _ in range(6):  # skip the kit's own helpers (fog box, rain cards, gobo)
                hit, loc, _n, _i, obj, _m = s.ray_cast(dg, origin, to_sun, distance=1000.0)
                if hit and obj.name.startswith("OH "):
                    origin = loc + to_sun * 0.01
                    continue
                hits += 1 if hit else 0
                break
    return hits / (n * n)


def build_rig(coll, cam, aim, size, cfg, gain, godrays, rep):
    keep = cfg.get("keep_world")
    if keep is None:
        w = s.world
        keep = bool(w and w.node_tree and any(n.bl_idname == "ShaderNodeTexEnvironment" and n.image for n in w.node_tree.nodes))
    if not keep and cfg.get("world"):
        col, st = cfg["world"]
        w = bpy.data.worlds.new("OH Look world")
        if w.node_tree is None:
            w.use_nodes = True
        nt = w.node_tree
        nt.nodes.clear()
        bg = nt.nodes.new("ShaderNodeBackground")
        bg.inputs["Color"].default_value = (*col, 1.0)
        bg.inputs["Strength"].default_value = st
        out = nt.nodes.new("ShaderNodeOutputWorld")
        nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
        s.world = w
    rep["world_kept"] = bool(keep) or not cfg.get("world")
    made = []
    for role, kind, az, el, dist, power, kelvin, size_f in cfg.get("rig", []):
        if kind == "SUN" and godrays:  # azimuth search: light gets in, back/side lit, near the preferred value
            best = None
            for a in range(60, 181, 15):
                sc = (1 - blocked_fraction(aim.location, size, direction(cam, a, el), 3)) * 2 - abs(a - az) / 90.0
                best = (sc, a) if best is None or sc > best[0] else best
            az = best[1]
            rep["sun_azimuth_deg"] = az
        col = {"magenta": (1.0, 0.05, 0.6), "cyan": (0.0, 0.7, 1.0)}.get(role)
        o = make_light(coll, aim, role, kind, direction(cam, az, el), max(dist, 1.0) * size, power, kelvin, size, size_f, gain, col)
        if kind == "SUN" and cfg.get("sun_volume") and godrays:
            o.data.volume_factor = cfg["sun_volume"]
            o.data.angle = math.radians(0.4)  # crisp: the gobo's pattern must survive in the shadows
        made.append(o.name)
    rep["lights"] = made


# ---------------------------------------------------------------------------------------------
# Fog (height-fog node group) + god rays (gobo)
# ---------------------------------------------------------------------------------------------
def height_fog_group():
    g = bpy.data.node_groups.get("OH Height Fog")
    if g:
        return g
    g = bpy.data.node_groups.new("OH Height Fog", "ShaderNodeTree")
    for nm, dv in (("Density", 0.05), ("Ground Z", 0.0), ("Height", 3.0), ("Haze", 0.2), ("Noise Scale", 0.2), ("Anisotropy", 0.7)):
        g.interface.new_socket(nm, in_out="INPUT", socket_type="NodeSocketFloat").default_value = dv
    g.interface.new_socket("Color", in_out="INPUT", socket_type="NodeSocketColor").default_value = (0.85, 0.88, 0.95, 1)
    g.interface.new_socket("Volume", in_out="OUTPUT", socket_type="NodeSocketShader")
    N, L = g.nodes, g.links

    def math_node(op, a=None, b=None):
        n = N.new("ShaderNodeMath")
        n.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L.new(v, n.inputs[i])
        return n.outputs[0]

    gi, go = N.new("NodeGroupInput"), N.new("NodeGroupOutput")
    sep = N.new("ShaderNodeSeparateXYZ")
    L.new(N.new("ShaderNodeNewGeometry").outputs["Position"], sep.inputs["Vector"])
    above = math_node("MAXIMUM", math_node("SUBTRACT", sep.outputs["Z"], gi.outputs["Ground Z"]), 0.0)
    falloff = math_node("EXPONENT", math_node("MULTIPLY", math_node("DIVIDE", above, gi.outputs["Height"]), -1.0))
    # density profile = haze + (1 - haze) * exp(-h / height)
    profile = math_node("ADD", gi.outputs["Haze"], math_node("MULTIPLY", math_node("SUBTRACT", 1.0, gi.outputs["Haze"]), falloff))
    nz = N.new("ShaderNodeTexNoise")
    nz.noise_dimensions = "4D"
    nz.inputs["Detail"].default_value = 2.0
    L.new(gi.outputs["Noise Scale"], nz.inputs["Scale"])
    try:  # slow drift of the noise through time
        nz.inputs["W"].driver_add("default_value").driver.expression = "frame / 240"
    except Exception:
        pass
    mm = N.new("ShaderNodeMapRange")
    mm.inputs["To Min"].default_value, mm.inputs["To Max"].default_value = 0.55, 1.45
    L.new(nz.outputs["Fac"], mm.inputs["Value"])
    dens = math_node("MULTIPLY", math_node("MULTIPLY", profile, mm.outputs["Result"]), gi.outputs["Density"])
    vol = N.new("ShaderNodeVolumePrincipled")
    L.new(dens, vol.inputs["Density"])
    L.new(gi.outputs["Color"], vol.inputs["Color"])
    L.new(gi.outputs["Anisotropy"], vol.inputs["Anisotropy"])
    L.new(vol.outputs["Volume"], go.inputs["Volume"])
    return g


def build_fog(coll, cam, size, dist, cfg, k, rep):
    lo, hi, depth = scene_extent(cam)
    vis = cfg.get("visibility")
    if vis is None:
        vis = max(4.0 * dist, 8.0)
        if depth > 300:  # outdoor vista: aerial haze
            vis = depth * 0.55
    amount = cfg.get("fog", 0.5) * k
    density = 3.0 / vis * amount
    pad = 0.15 * (hi - lo).length + 1.0
    bx_lo, bx_hi = lo - Vector((pad, pad, 0)), hi + Vector((pad, pad, pad))
    me = bpy.data.meshes.new("OH Fog")
    me.from_pydata([(x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1)], [],
                   [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)])
    box = add_obj(coll, "OH Fog", me)
    box.location, box.scale = bx_lo, bx_hi - bx_lo
    box.display_type, box.hide_select = "WIRE", True
    box.visible_shadow = False  # haze must not darken the shot
    mat = new_mat("OH Fog")
    nt = mat.node_tree
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    color = tuple(cfg.get("fog_color", (0.85, 0.88, 0.95))) + (1,)
    if cfg.get("height_fog", True):
        gn = nt.nodes.new("ShaderNodeGroup")
        gn.node_tree = height_fog_group()
        height = max(size * 0.6, 1.5)
        if depth > 300:
            height = max(height, depth * 0.01)
        gn.inputs["Density"].default_value = density  # the profile only thins it with height
        gn.inputs["Ground Z"].default_value = lo.z
        gn.inputs["Height"].default_value = height
        gn.inputs["Haze"].default_value = 0.15
        gn.inputs["Noise Scale"].default_value = 1.0 / max(2 * height, 0.5)
        gn.inputs["Anisotropy"].default_value = cfg.get("aniso", 0.7)
        gn.inputs["Color"].default_value = color
        nt.links.new(gn.outputs["Volume"], out.inputs["Volume"])
        rep["fog_height_m"] = round(height, 2)
    else:
        vol = nt.nodes.new("ShaderNodeVolumePrincipled")
        vol.inputs["Density"].default_value = density
        vol.inputs["Anisotropy"].default_value = cfg.get("aniso", 0.5)
        vol.inputs["Color"].default_value = color
        nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    me.materials.append(mat)
    rep["fog"] = {"visibility_m": round(vis, 2), "density": round(density, 5), "amount": round(amount, 3)}
    if hasattr(s, "eevee"):
        s.eevee.volumetric_tile_size = "2"
    if r.engine == "CYCLES":
        s.cycles.volume_bounces = max(s.cycles.volume_bounces, 4)


def gobo_material(kind, openness, side, size):
    """Pattern frequencies are metric: features scale with the subject so shadows read on it."""
    feat = max(size * 0.4, 0.25)
    m = new_mat("OH Gobo " + kind)
    N, L = m.node_tree.nodes, m.node_tree.links
    tc, mp = N.new("ShaderNodeTexCoord"), N.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (side / feat, side / feat, 1)
    L.new(tc.outputs["Generated"], mp.inputs["Vector"])
    if kind == "blinds":
        mp.inputs["Scale"].default_value = (1, side / (feat * 0.5), 1)
        wv = N.new("ShaderNodeTexWave")
        wv.wave_type, wv.bands_direction = "BANDS", "Y"
        wv.inputs["Scale"].default_value, wv.inputs["Distortion"].default_value = 1.0, 0.0
        L.new(mp.outputs["Vector"], wv.inputs["Vector"])
        src, level = wv.outputs["Fac"], 1.0 - openness
    elif kind == "window":
        ck = N.new("ShaderNodeTexChecker")
        ck.inputs["Scale"].default_value = 0.5
        L.new(mp.outputs["Vector"], ck.inputs["Vector"])
        src, level = ck.outputs["Fac"], 0.5
    else:  # leaves / roof: cellular canopy gaps broken up by noise
        vo = N.new("ShaderNodeTexVoronoi")
        L.new(mp.outputs["Vector"], vo.inputs["Vector"])
        nz = N.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 3.0
        L.new(mp.outputs["Vector"], nz.inputs["Vector"])
        mx = N.new("ShaderNodeMath")
        mx.operation = "MULTIPLY"
        L.new(vo.outputs["Distance"], mx.inputs[0])
        L.new(nz.outputs["Fac"], mx.inputs[1])
        src, level = mx.outputs[0], 0.62 - 0.9 * openness * 0.5
    thr = N.new("ShaderNodeMath")
    thr.operation = "LESS_THAN"  # gap where the pattern is low
    thr.inputs[1].default_value = level
    L.new(src, thr.inputs[0])
    tr, bl, mix, out = N.new("ShaderNodeBsdfTransparent"), N.new("ShaderNodeBsdfDiffuse"), N.new("ShaderNodeMixShader"), N.new("ShaderNodeOutputMaterial")
    bl.inputs["Color"].default_value = (0, 0, 0, 1)
    L.new(thr.outputs[0], mix.inputs["Fac"])
    L.new(bl.outputs[0], mix.inputs[1])
    L.new(tr.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs["Surface"])
    if hasattr(m, "surface_render_method"):
        m.surface_render_method = "DITHERED"
    return m


def build_godrays(coll, center, size, cfg, rep):
    sun = next((o for o in coll.objects if o.type == "LIGHT" and o.data.type == "SUN"), None)
    if sun is None:
        rep["godrays"] = "skipped: no sun in the rig"
        return
    to_sun = (sun.location - center).normalized()
    blocked = blocked_fraction(center, size, to_sun)
    if blocked > 0.85:
        rep["godrays"] = "skipped: the scene already occludes the sun (%d%% of rays blocked); sun volume scatter only" % round(100 * blocked)
        return
    kind, openness = cfg["godrays"]
    me = bpy.data.meshes.new("OH Gobo")
    me.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
    g = add_obj(coll, "OH Gobo", me)
    g.location = center + to_sun * (size * 1.0 + 1.0)
    g.rotation_euler = to_sun.to_track_quat("Z", "Y").to_euler()
    half = size * 1.5 + 2.0
    g.scale = (half, half, 1)
    g.visible_camera, g.hide_select = False, True
    me.materials.append(gobo_material(kind, openness, 2 * half, size))
    rep["godrays"] = {"gobo": kind, "openness": openness, "sun_blocked_before": round(blocked, 2)}


# ---------------------------------------------------------------------------------------------
# Practicals -> real lights
# ---------------------------------------------------------------------------------------------
def emission_of(mat):
    """(strength, colour) of a material's emission, or None."""
    if not mat or not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.bl_idname == "ShaderNodeEmission" and n.inputs["Strength"].default_value > 0:
            return n.inputs["Strength"].default_value, tuple(n.inputs["Color"].default_value[:3])
        if n.bl_idname == "ShaderNodeBsdfPrincipled" and "Emission Strength" in n.inputs:
            st, c = n.inputs["Emission Strength"].default_value, tuple(n.inputs["Emission Color"].default_value[:3])
            if st > 0 and max(c) > 0:
                return st, c
    return None


def build_practicals(coll, gain, rep, max_lights=256, max_shadows=48, cell=1.5, min_watts=0.25):
    """Emissive polygons clustered on a 1.5 m grid become point lights (overhead > 2.2 m: downward spots)."""
    clusters = {}
    for o in meshes():
        slots = {i: e for i, e in ((i, emission_of(sl.material)) for i, sl in enumerate(o.material_slots)) if e}
        if not slots:
            continue
        me = o.data
        n = len(me.polygons)
        mi = np.zeros(n, dtype=np.int32)
        cen = np.zeros(n * 3, dtype=np.float32)
        ar = np.zeros(n, dtype=np.float32)
        me.polygons.foreach_get("material_index", mi)
        me.polygons.foreach_get("center", cen)
        me.polygons.foreach_get("area", ar)
        mw = np.array(o.matrix_world)
        world = cen.reshape(n, 3) @ mw[:3, :3].T + mw[:3, 3]
        a2 = abs(np.linalg.det(mw[:3, :3])) ** (2.0 / 3.0)
        for i, (st, col) in slots.items():
            for p in np.where(mi == i)[0]:
                w, a = world[p], float(ar[p]) * a2
                c = clusters.setdefault((o.name, i, int(w[0] // cell), int(w[1] // cell), int(w[2] // cell)), [0.0, np.zeros(3), col, st])
                c[0] += a
                c[1] += w * a
    bulbs = []
    for (_n, *_), (area, wsum, col, st) in clusters.items():
        watts = st * area * math.pi * 0.6  # 0.6: Cycles lets the emitter itself light the scene too
        if watts >= min_watts:
            bulbs.append((watts, wsum / max(area, 1e-9), col, area))
    bulbs.sort(key=lambda b: -b[0])
    kept = bulbs[:max_lights]
    for idx, (watts, pos, col, area) in enumerate(kept):
        overhead = pos[2] > 2.2
        data = bpy.data.lights.new("OH practical", "SPOT" if overhead else "POINT")
        data.energy = watts * gain
        m = max(max(col), 1e-3)
        data.color = tuple(max(c / m, 0.02) for c in col)
        data.shadow_soft_size = max(0.02, math.sqrt(area / math.pi))
        data.use_shadow = idx < max_shadows
        data.volume_factor = 1.0
        if overhead:
            data.spot_size, data.spot_blend = math.radians(100), 0.6
        add_obj(coll, "OH practical %03d" % idx, data).location = Vector(pos)
    rep["practicals"] = {"emitters": len(bulbs), "lights": len(kept), "shadow_casters": min(len(kept), max_shadows),
                         "dropped_by_budget": len(bulbs) - len(kept)}
    return len(kept)


def motivated_pair(coll, cam, aim, size, gain, rep):
    for role, az, el, p, k in (("motivated key", -50, 35, 220, 2700), ("motivated rim", 165, 30, 300, 7500)):
        make_light(coll, aim, role, "AREA", direction(cam, az, el), size * 2.4, p, k, size, 0.8, gain)
    rep["practicals_note"] = "fewer than 2 practicals: added a motivated key (2700 K) and rim (7500 K)"


# ---------------------------------------------------------------------------------------------
# Wet / puddles / rain
# ---------------------------------------------------------------------------------------------
def up_facing(o):
    me = o.data
    n = len(me.polygons)
    if n == 0 or max(o.dimensions.x, o.dimensions.y) < 1.0:
        return False
    nr = np.zeros(n * 3, dtype=np.float32)
    ar = np.zeros(n, dtype=np.float32)
    me.polygons.foreach_get("normal", nr)
    me.polygons.foreach_get("area", ar)
    return float((nr.reshape(n, 3)[:, 2] * ar).sum() / max(ar.sum(), 1e-9)) > 0.7


def wet_materials(wet, puddles):
    """Wetness: darker + glossier through Math/Mix nodes in front of Roughness/Base Color (undone by unwet())."""
    ups = {sl.material for o in meshes() if up_facing(o) for sl in o.material_slots if sl.material}
    done = 0
    for m in bpy.data.materials:
        if not m.users or not m.node_tree or emission_of(m):
            continue
        nt = m.node_tree
        N, L = nt.nodes, nt.links

        def mk(idname, name, bsdf):
            n = N.new(idname)
            n.name = "OH wet " + name
            n["oh_for"] = bsdf.name
            return n

        for bsdf in [n for n in N if n.bl_idname == "ShaderNodeBsdfPrincipled"]:
            if any(n.get("oh_for") == bsdf.name for n in N):
                continue
            rough, col = bsdf.inputs["Roughness"], bsdf.inputs["Base Color"]
            src_r = rough.links[0].from_socket if rough.links else None
            src_c = col.links[0].from_socket if col.links else None
            mask = None
            if puddles and m in ups:
                geo, nz, rm_, up, sp, mkm = (mk("ShaderNodeNewGeometry", "geo", bsdf), mk("ShaderNodeTexNoise", "puddle noise", bsdf),
                                             mk("ShaderNodeMapRange", "puddle map", bsdf), mk("ShaderNodeMath", "up", bsdf),
                                             mk("ShaderNodeSeparateXYZ", "sep", bsdf), mk("ShaderNodeMath", "mask", bsdf))
                nz.inputs["Scale"].default_value = 0.6
                rm_.inputs["From Min"].default_value, rm_.inputs["From Max"].default_value = 0.46, 0.5
                up.operation, mkm.operation = "GREATER_THAN", "MULTIPLY"
                up.inputs[1].default_value = 0.9
                L.new(geo.outputs["Position"], nz.inputs["Vector"])
                L.new(nz.outputs["Fac"], rm_.inputs["Value"])
                L.new(geo.outputs["Normal"], sp.inputs["Vector"])
                L.new(sp.outputs["Z"], up.inputs[0])
                L.new(rm_.outputs["Result"], mkm.inputs[0])
                L.new(up.outputs[0], mkm.inputs[1])
                mask = mkm.outputs[0]
            rm = mk("ShaderNodeMath", "rough", bsdf)
            rm.operation = "MULTIPLY"
            rm["orig"] = rough.default_value
            if src_r:
                L.new(src_r, rm.inputs[0])
            else:
                rm.inputs[0].default_value = rough.default_value
            rm.inputs[1].default_value = 1.0 - 0.65 * wet
            out_r = rm.outputs[0]
            if mask:
                rmix = mk("ShaderNodeMix", "rough puddle", bsdf)
                rmix.data_type = "FLOAT"
                L.new(mask, rmix.inputs["Factor"])
                L.new(out_r, rmix.inputs["A"])
                rmix.inputs["B"].default_value = 0.02
                out_r = rmix.outputs["Result"]
            L.new(out_r, rough)
            cm = mk("ShaderNodeMix", "color", bsdf)
            cm.data_type, cm.blend_type = "RGBA", "MULTIPLY"
            cm["orig"] = list(col.default_value)
            cm.inputs["Factor"].default_value = 1.0
            if src_c:
                L.new(src_c, cm.inputs["A"])
            else:
                cm.inputs["A"].default_value = col.default_value
            d = 1.0 - 0.4 * wet
            cm.inputs["B"].default_value = (d, d, d, 1)
            out_c = cm.outputs["Result"]
            if mask:
                pm = mk("ShaderNodeMix", "color puddle", bsdf)
                pm.data_type, pm.blend_type = "RGBA", "MULTIPLY"
                L.new(mask, pm.inputs["Factor"])
                L.new(out_c, pm.inputs["A"])
                pm.inputs["B"].default_value = (0.55, 0.55, 0.55, 1)
                out_c = pm.outputs["Result"]
            L.new(out_c, col)
            done += 1
    return done


def unwet():
    n = 0
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        nt = m.node_tree
        mine = [x for x in nt.nodes if x.name.startswith("OH wet")]
        if not mine:
            continue
        for bsdf in [x for x in nt.nodes if x.bl_idname == "ShaderNodeBsdfPrincipled"]:
            for sock, tag in ((bsdf.inputs["Roughness"], "OH wet rough"), (bsdf.inputs["Base Color"], "OH wet color")):
                node = next((x for x in mine if x.name.startswith(tag) and x.name == tag and x.get("oh_for") == bsdf.name), None)
                if node is None:
                    continue
                key = 0 if tag.endswith("rough") else "A"
                src = node.inputs[key].links[0].from_socket if node.inputs[key].links else None
                for l in list(sock.links):
                    nt.links.remove(l)
                if src is not None:
                    nt.links.new(src, sock)
                else:
                    sock.default_value = node["orig"] if tag.endswith("rough") else tuple(node["orig"])
        for x in mine:
            nt.nodes.remove(x)
        n += 1
    return n


def build_rain(coll, cam, k, rep):
    """Two camera-parented streak cards (near/far) with wind tilt, visible to the camera only."""
    cd, wind = cam.data, 12.0
    for name, dist, scale, dens in (("OH rain near", 2.5, 55.0, 0.55), ("OH rain far", 7.0, 110.0, 0.7)):
        w = 2 * dist * (cd.sensor_width / 2) / cd.lens * 1.25
        h = w * r.resolution_y / max(r.resolution_x, 1)
        me = bpy.data.meshes.new(name)
        me.from_pydata([(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)], [], [(0, 1, 2, 3)])
        o = add_obj(coll, name, me)
        o.parent, o.location, o.hide_select = cam, (0, 0, -dist), True
        for a in ("visible_shadow", "visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter"):
            setattr(o, a, False)
        m = new_mat(name)
        N, L = m.node_tree.nodes, m.node_tree.links
        tc, mp = N.new("ShaderNodeTexCoord"), N.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale, scale * 0.025, 1)
        mp.inputs["Rotation"].default_value = (0, 0, math.radians(wind))
        L.new(tc.outputs["Generated"], mp.inputs["Vector"])
        try:
            mp.inputs["Location"].driver_add("default_value", 1).driver.expression = "-frame * 0.7"
        except Exception:
            pass
        nz = N.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value, nz.inputs["Detail"].default_value = 1.0, 0.0
        L.new(mp.outputs["Vector"], nz.inputs["Vector"])
        mr = N.new("ShaderNodeMapRange")
        thr = 0.66 - 0.2 * dens * min(k, 1.5)
        mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = thr, thr + 0.05
        L.new(nz.outputs["Fac"], mr.inputs["Value"])
        em, tr, mix, out = N.new("ShaderNodeEmission"), N.new("ShaderNodeBsdfTransparent"), N.new("ShaderNodeMixShader"), N.new("ShaderNodeOutputMaterial")
        em.inputs["Color"].default_value = (0.75, 0.82, 0.95, 1)
        em.inputs["Strength"].default_value = 1.2
        L.new(mr.outputs["Result"], mix.inputs["Fac"])
        L.new(tr.outputs[0], mix.inputs[1])
        L.new(em.outputs[0], mix.inputs[2])
        L.new(mix.outputs[0], out.inputs["Surface"])
        if hasattr(m, "surface_render_method"):
            m.surface_render_method = "BLENDED"
        me.materials.append(m)
    rep["rain"] = {"cards": 2, "wind_deg": wind, "note": "streak cards in front of the camera; no splashes"}


# ---------------------------------------------------------------------------------------------
# Post stack (compositor): bloom, lens distortion/CA, grade, vignette, grain
# ---------------------------------------------------------------------------------------------
def comp_tree(create=True):
    tree = s.compositing_node_group
    if tree is None and create:
        tree = bpy.data.node_groups.new("OH Compositing", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        s.compositing_node_group = tree
    return tree


def unpost():
    tree = comp_tree(False)
    if tree is None:
        return 0
    mine = [n for n in tree.nodes if n.name.startswith("OH post")]
    if not mine:
        return 0
    out = next((n for n in tree.nodes if n.bl_idname == "NodeGroupOutput"), None)
    origin = tree.nodes["OH post src"].get("origin") if "OH post src" in tree.nodes else None
    sock = tree.nodes["OH post src"].get("origin_socket", 0) if "OH post src" in tree.nodes else 0
    for n in mine:
        tree.nodes.remove(n)
    if out is not None:
        for l in list(out.inputs[0].links):
            tree.links.remove(l)
        if origin and origin in tree.nodes:
            tree.links.new(tree.nodes[origin].outputs[sock], out.inputs[0])
    return len(mine)


def build_post(cfg, k, rep):
    tree = comp_tree()
    N, L = tree.nodes, tree.links
    out = next((n for n in N if n.bl_idname == "NodeGroupOutput"), None) or N.new("NodeGroupOutput")
    rl = next((n for n in N if n.bl_idname == "CompositorNodeRLayers"), None) or N.new("CompositorNodeRLayers")
    if out.inputs[0].links:
        o_node, o_sock = out.inputs[0].links[0].from_node, out.inputs[0].links[0].from_socket
    else:
        o_node, o_sock = rl, rl.outputs["Image"]
    src = N.new("NodeReroute")
    src.name = "OH post src"
    src["origin"] = o_node.name
    src["origin_socket"] = list(o_node.outputs).index(o_sock)
    L.new(o_sock, src.inputs[0])
    last = src.outputs[0]
    done = []

    def add(idname, name):
        nonlocal last
        n = N.new(idname)
        n.name = "OH post " + name
        L.new(last, n.inputs["Image"])
        last = n.outputs["Image"]
        done.append(name)
        return n

    def mix(name, blend, factor, b):
        nonlocal last
        n = N.new("ShaderNodeMix")
        n.name = "OH post " + name
        n.data_type, n.blend_type = "RGBA", blend
        n.inputs["Factor"].default_value = factor
        L.new(last, n.inputs["A"])
        if isinstance(b, tuple):
            n.inputs["B"].default_value = b
        else:
            L.new(b, n.inputs["B"])
        last = n.outputs["Result"]
        done.append(name)

    skipped = rep.setdefault("post_skipped", [])
    for name, fn in (("bloom", lambda: _bloom(add, cfg, k)), ("lens", lambda: _lens(add, cfg, k)),
                     ("grade", lambda: mix("grade", "SOFT_LIGHT", cfg["grade"][3] * k, tuple(cfg["grade"][:3]) + (1,)) if cfg.get("grade") else None),
                     ("vignette", lambda: _vignette(N, L, mix, cfg, k)), ("grain", lambda: _grain(N, L, mix, cfg, k))):
        try:
            fn()
        except Exception as e:
            skipped.append("%s: %s" % (name, e))
    L.new(last, out.inputs[0])
    r.use_compositing = True
    rep["post"] = done
    if not skipped:
        del rep["post_skipped"]


def _bloom(add, cfg, k):
    if cfg.get("bloom"):
        thr, st = cfg["bloom"]
        g = add("CompositorNodeGlare", "bloom")
        g.inputs["Type"].default_value = "Bloom"
        g.inputs["Threshold"].default_value = thr
        g.inputs["Strength"].default_value = min(1.0, st * k)
        g.inputs["Size"].default_value = 0.6


def _lens(add, cfg, k):
    if cfg.get("ca"):
        ld = add("CompositorNodeLensdist", "lens")
        ld.inputs["Dispersion"].default_value = cfg["ca"] * k
        ld.inputs["Distortion"].default_value = -0.01


def _vignette(N, L, mix, cfg, k):
    if not cfg.get("vignette"):
        return
    ell = N.new("CompositorNodeEllipseMask")
    ell.name = "OH post vignette mask"
    ell.inputs["Size"].default_value = (0.9, 0.9)
    bl = N.new("CompositorNodeBlur")
    bl.name = "OH post vignette blur"
    L.new(ell.outputs["Mask"], bl.inputs["Image"])
    bl.inputs["Size"].default_value = (90.0, 90.0)
    a = cfg["vignette"] * k
    ma = N.new("ShaderNodeMath")
    ma.name = "OH post vignette amount"
    ma.operation = "MULTIPLY_ADD"
    L.new(bl.outputs["Image"], ma.inputs[0])
    ma.inputs[1].default_value, ma.inputs[2].default_value = a, 1.0 - a
    mix("vignette", "MULTIPLY", 1.0, ma.outputs[0])


def _grain(N, L, mix, cfg, k):
    """Film grain: fine monochrome noise over image coordinates, soft-light blended (no film-grain node in the compositor)."""
    if not cfg.get("grain"):
        return
    co = N.new("CompositorNodeImageCoordinates")
    co.name = "OH post grain coords"
    nz = N.new("ShaderNodeTexNoise")
    nz.name = "OH post grain noise"
    nz.inputs["Scale"].default_value, nz.inputs["Detail"].default_value = 900.0, 0.0
    L.new(co.outputs[0], nz.inputs["Vector"])
    mix("grain", "SOFT_LIGHT", min(1.0, cfg["grain"] * k * 1.5), nz.outputs["Fac"])


# ---------------------------------------------------------------------------------------------
# Auto exposure by probe render
# ---------------------------------------------------------------------------------------------
def geomean(a):
    return float(np.exp(np.mean(np.log(np.maximum(a, 1e-6)))))


def probe_pixels(width=240):
    """Render a tiny linear EXR with no compositing / motion blur / exposure; returns (luminance[h, w], h, w)."""
    keep = dict(pct=r.resolution_percentage, comp=r.use_compositing, mb=r.use_motion_blur, fmt=r.image_settings.file_format,
                depth=r.image_settings.color_depth, tr=r.film_transparent, exp=s.view_settings.exposure, path=r.filepath)
    r.resolution_percentage = max(1, round(100 * width / max(1, r.resolution_x)))
    r.use_compositing, r.use_motion_blur, r.film_transparent = False, False, False
    s.view_settings.exposure = 0.0
    sam = None
    if r.engine == "CYCLES":
        sam = (s.cycles.samples, s.cycles.use_denoising)
        s.cycles.samples, s.cycles.use_denoising = min(32, s.cycles.samples), False
    elif r.engine.startswith("BLENDER_EEVEE"):
        sam = s.eevee.taa_render_samples
        s.eevee.taa_render_samples = min(8, sam)
    path = os.path.join(P["tmp"], "probe.exr")
    try:
        bpy.ops.render.render()
        r.image_settings.file_format, r.image_settings.color_depth = "OPEN_EXR", "32"
        bpy.data.images["Render Result"].save_render(path, scene=s)
    finally:
        r.resolution_percentage, r.use_compositing, r.use_motion_blur = keep["pct"], keep["comp"], keep["mb"]
        r.image_settings.file_format, r.image_settings.color_depth = keep["fmt"], keep["depth"]
        r.film_transparent, s.view_settings.exposure, r.filepath = keep["tr"], keep["exp"], keep["path"]
        if r.engine == "CYCLES" and sam:
            s.cycles.samples, s.cycles.use_denoising = sam
        elif sam is not None and r.engine.startswith("BLENDER_EEVEE"):
            s.eevee.taa_render_samples = sam
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.zeros(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    px = px.reshape(h, w, 4)
    return 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2], h, w


def auto_exposure(cam, hero, target, hero_target=None, ceiling=None, floor=0.12, apply=True):
    lum, h, w = probe_pixels()
    my, mx = int(h * 0.1), int(w * 0.1)
    central = np.sort(lum[my:h - my, mx:w - mx].ravel())
    keep = central[: max(1, int(len(central) * 0.98))]  # drop the brightest 2% (bulbs / sky)
    key = geomean(keep)
    ev = math.log2(target / key)
    info = {"target": target, "key": round(key, 5), "p50": round(float(np.percentile(keep, 50)), 5), "p90": round(float(np.percentile(keep, 90)), 5)}
    hero_px = np.array([], dtype=np.float32)
    b = screen_box(hero, cam) if hero is not None else None
    if b:
        x0, y0 = int(b[0] * w), int(b[1] * h)
        hp = np.sort(lum[y0:max(y0 + 1, int(b[3] * h)), x0:max(x0 + 1, int(b[2] * w))].ravel())
        hero_px = hp[: max(1, int(len(hp) * 0.98))]
        if len(hero_px) >= 20:
            hg = geomean(hero_px)
            info["hero_geomean"] = round(hg, 5)
            ev = max(ev, math.log2((hero_target or target) / hg))
        else:
            hero_px = np.array([], dtype=np.float32)
    if ceiling:
        ev = min(ev, math.log2(ceiling / max(info["p90"], 1e-6)))
    full = np.sort(lum.ravel())
    nobulb = full[: max(1, int(len(full) * 0.98))]
    lit = np.concatenate([nobulb[int(len(nobulb) * 0.7):], hero_px])  # brightest 30% without bulbs + hero pixels
    info["lit_median"] = round(float(np.median(lit)), 5)
    if floor:
        ev = max(ev, math.log2(floor / max(info["lit_median"], 1e-6)))  # the floor wins over the ceiling
    clamped = max(-10.0, min(10.0, ev))
    info.update(ev=round(clamped, 3), clamped=clamped != ev, key_after=round(key * 2 ** clamped, 4), p50_after=round(info["p50"] * 2 ** clamped, 4))
    if apply:
        s.view_settings.exposure = clamped
    return info


# ---------------------------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------------------------
def main():
    cam = bpy.data.objects.get(P["camera"]) if P.get("camera") else s.camera
    if cam is None or cam.type != "CAMERA":
        fail("the scene has no camera; pass camera=")
    s.camera = cam
    if P.get("frame") is not None:
        s.frame_set(int(P["frame"]))
    if P["cmd"] == "look" and P.get("remove"):
        return "OH_LOOK", remove_look()
    hero = bpy.data.objects.get(P["hero_object"]) if P.get("hero_object") else pick_hero(cam)
    if P.get("hero_object") and hero is None:
        fail("hero_object not found: " + P["hero_object"])
    if P["cmd"] == "exposure":
        info = auto_exposure(cam, hero, P["target"], P.get("hero_target"), P.get("ceiling"), P.get("floor", 0.12), P.get("apply", True))
        info["hero"] = hero.name if hero else None
        return "OH_EXPOSURE", info

    name, layers, k = P.get("name"), P.get("layers"), float(P.get("intensity", 1.0))
    if name and name not in LOOKS:
        fail("unknown look %r; use one of %s" % (name, ", ".join(LOOKS)))
    for l in layers or []:
        if l not in LAYERS:
            fail("unknown layer %r; use one of %s" % (l, ", ".join(LAYERS)))
    cfg = dict(NEUTRAL, **LOOKS[name]) if name else dict(NEUTRAL)
    active = set(layers) if layers else (set(cfg["layers"]) | {"rig", "post"} if name else set())
    if "godrays" in active and "rig" not in active:  # the sun is needed: add the rig without replacing the world
        active.add("rig")
        cfg["world"] = None
        if not any(x[1] == "SUN" for x in cfg["rig"]):
            cfg["rig"] = NEUTRAL["rig"]
    if "rig" in active and not any(x[1] == "SUN" for x in cfg["rig"]) and "godrays" in active:
        cfg["rig"] = cfg["rig"] + NEUTRAL["rig"]
    remove_look()  # idempotent: re-applying always starts from the user's scene
    prev = {"exposure": s.view_settings.exposure, "view_transform": s.view_settings.view_transform, "look": s.view_settings.look,
            "world": s.world.name if s.world else "", "use_compositing": r.use_compositing,
            "dof": {"use": cam.data.dof.use_dof, "fstop": cam.data.dof.aperture_fstop,
                    "focus": cam.data.dof.focus_object.name if cam.data.dof.focus_object else ""}}
    if "rig" in active:  # the look's rig replaces the scene's own lights (restored by remove)
        prev["lights_off"] = [o.name for o in s.objects if o.type == "LIGHT" and not o.hide_render and not o.name.startswith("OH ")]
        for n in prev["lights_off"]:
            bpy.data.objects[n].hide_render = True
    s[KEY] = json.dumps({"name": name or "layers", "layers": sorted(active), "intensity": k, "prev": prev})
    center, size, dist = subject(cam, hero)
    coll = bpy.data.collections.new(COLL)
    s.collection.children.link(coll)
    aim = add_obj(coll, "OH Look Target", None)
    aim.location, aim.empty_display_size = center, size * 0.1
    rep = {"look": name, "layers": sorted(active), "intensity": k, "hero": hero.name if hero else None,
           "subject_distance_m": round(dist, 2), "subject_size_m": round(size, 2)}
    if "rig" in active:
        build_rig(coll, cam, aim, size, cfg, k, "godrays" in active, rep)
    if "fog" in active and cfg["fog"] > 0:
        build_fog(coll, cam, size, dist, cfg, k, rep)
    if "godrays" in active:
        build_godrays(coll, center, size, cfg, rep)
    if "practicals" in active and build_practicals(coll, k, rep) < 2:
        motivated_pair(coll, cam, aim, size, k, rep)
    if "wet" in active and cfg.get("wet"):
        rep["wet_materials"] = wet_materials(min(1.0, cfg["wet"] * k), cfg.get("puddles", False))
    if "rain" in active and cfg.get("rain"):
        build_rain(coll, cam, k, rep)
    if "camera" in active and cfg.get("fstop"):
        cam.data.dof.use_dof = True
        cam.data.dof.aperture_fstop = cfg["fstop"]
        if hero is not None:
            cam.data.dof.focus_object = hero
        rep["dof_fstop"] = cfg["fstop"]
    if "post" in active:
        s.view_settings.view_transform = "AgX"
        try:
            s.view_settings.look = cfg["look"]
        except TypeError:
            rep["look_skipped"] = cfg["look"]
        try:
            build_post(cfg, k, rep)
        except Exception as e:  # compositor node/socket names differ between Blender versions: keep the rest
            rep["post_skipped"] = "compositor: %s" % e
    if P.get("auto_exposure", bool(name)):
        rep["exposure"] = auto_exposure(cam, hero, P.get("target") or cfg["target"], P.get("hero_target"), cfg.get("ceiling"), cfg.get("floor", 0.12), True)
    return "OH_LOOK", rep


def preview(path, width=640):
    """Small beauty render of the result (compositing on, exposure applied)."""
    r.resolution_percentage = max(1, round(100 * width / max(1, r.resolution_x)))
    r.film_transparent = False
    if r.engine == "CYCLES":
        s.cycles.samples, s.cycles.use_denoising = min(32, s.cycles.samples), True
    elif r.engine.startswith("BLENDER_EEVEE"):
        s.eevee.taa_render_samples = min(16, s.eevee.taa_render_samples)
    r.image_settings.file_format, r.image_settings.color_mode, r.image_settings.color_depth = "PNG", "RGB", "8"
    r.filepath = path
    bpy.ops.render.render(write_still=True)


_tag, _rep = main()
if P.get("save"):
    bpy.ops.wm.save_as_mainfile(filepath=P["save"], copy=True)
if P.get("preview"):
    t0 = time.time()
    preview(P["preview"])
    _rep["preview_sec"] = round(time.time() - t0, 1)
print(_tag, json.dumps(_rep))

# Camera rig with classic moves for the current Blender scene (Open Herness).
#
# Run through blender_exec / blender_script: send this file's text as `code` with a first line like
#   PARAMS = {"move": "orbit", "target": "Hero", "degrees": 90, "frames": [1, 120]}
# Parameters (all optional):
#   move       static | dolly_in | dolly_out | truck | orbit | crane_up | crane_down | push_zoom  (default static)
#   target     object to frame; default = bounding box of visible non-flat meshes
#   name       rig name (default "OH Cam"); re-running with the same name rebuilds that rig
#   lens       focal length mm (default 50; 24-35 wide/establishing, 50 natural, 85-135 portrait/compressed)
#   distance   camera-to-target distance in m (default: frames the target at this lens)
#   height     camera height above the target centre, in m (default distance * 0.25)
#   azimuth    start angle around the target in degrees, 0 = camera on -Y looking +Y (default -20)
#   degrees    orbit sweep (default 60)
#   amount     dolly/truck/crane travel as a fraction of distance (default 0.35)
#   frames     [start, end] of the move (default the scene range)
#   easing     ease | linear | ease_in | ease_out (default ease = ease in and out)
#   dof        True enables depth of field focused on the target (default False)
#   fstop      aperture when dof is on (default 2.8; 1.4 very shallow, 8 deep)
#   shake      handheld aim wobble in degrees (default 0; 0.3-0.8 subtle)
#   active     make it the scene camera (default True)
# Sets `result`.

import math

import bpy
from mathutils import Vector

PARAMS = globals().get("PARAMS", {})


def _bounds(target_name):
    scene = bpy.context.scene
    if target_name:
        obj = bpy.data.objects.get(target_name)
        if obj is None:
            raise ValueError("No object named %r" % target_name)
        objs = [obj] + list(obj.children_recursive)
    else:
        objs = [o for o in scene.objects if o.type == "MESH" and o.visible_get() and min(o.dimensions) > 0.02 * max(o.dimensions)]
    pts = [o.matrix_world @ Vector(c) for o in objs if o.type == "MESH" for c in o.bound_box]
    if not pts:
        return (objs[0].matrix_world.translation.copy() if objs else Vector((0, 0, 1))), Vector((1, 1, 1))
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return (lo + hi) / 2, Vector((max(v, 0.05) for v in (hi - lo)))


def fcurves_of(obj):
    """F-curves of an object's action in Blender 5.x (layered actions) and 4.x."""
    ad = obj.animation_data
    if not ad or not ad.action:
        return []
    action = ad.action
    if hasattr(action, "fcurves") and not getattr(action, "is_action_layered", False):
        return list(action.fcurves)
    from bpy_extras import anim_utils

    bag = anim_utils.action_get_channelbag_for_slot(action, ad.action_slot)
    return list(bag.fcurves) if bag else []


def set_easing(obj, easing="ease"):
    interp, ease = {
        "linear": ("LINEAR", "AUTO"),
        "ease": ("SINE", "EASE_IN_OUT"),
        "ease_in": ("SINE", "EASE_IN"),
        "ease_out": ("SINE", "EASE_OUT"),
    }[easing]
    for fc in fcurves_of(obj):
        for kp in fc.keyframe_points:
            kp.interpolation = interp
            kp.easing = ease


def _clear(name):
    for suffix in ("", " Pivot", " Target"):
        obj = bpy.data.objects.get(name + suffix)
        if obj is not None:
            data = obj.data
            bpy.data.objects.remove(obj)
            if data is not None and data.users == 0:
                bpy.data.cameras.remove(data)


def build_rig(move="static", target=None, name="OH Cam", lens=50.0, distance=None, height=None, azimuth=-20.0, degrees=60.0,
              amount=0.35, frames=None, easing="ease", dof=False, fstop=2.8, shake=0.0, active=True):
    scene = bpy.context.scene
    start, end = frames or (scene.frame_start, scene.frame_end)
    _clear(name)
    center, dims = _bounds(target)
    size = dims.length
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    cam_data.sensor_width = 36.0
    cam_data.clip_start = max(0.01, size * 0.005)
    cam_data.clip_end = max(200.0, size * 200)
    if distance is None:
        # Fit the subject into ~70% of the frame (height or width, whichever is tighter) at this lens.
        aspect = scene.render.resolution_x / scene.render.resolution_y
        half_w = math.tan(math.atan(cam_data.sensor_width / (2 * lens)))
        half_h = half_w / aspect
        wide = max(dims.x, dims.y)
        distance = max(dims.z / (2 * half_h * 0.7), wide / (2 * half_w * 0.7)) + wide / 2
    if height is None:
        height = distance * 0.25

    tgt = bpy.data.objects.new(name + " Target", None)
    tgt.location = center
    tgt.empty_display_size = size * 0.15
    scene.collection.objects.link(tgt)
    pivot = bpy.data.objects.new(name + " Pivot", None)  # orbit happens by turning this
    pivot.location = center
    pivot.rotation_euler[2] = math.radians(azimuth)
    pivot.empty_display_size = size * 0.1
    scene.collection.objects.link(pivot)
    cam = bpy.data.objects.new(name, cam_data)
    scene.collection.objects.link(cam)
    cam.parent = pivot
    cam.location = (0.0, -distance, height)
    track = cam.constraints.new("TRACK_TO")
    track.target = tgt
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    travel = distance * amount
    animated = [cam]
    if move == "orbit":
        pivot.keyframe_insert("rotation_euler", index=2, frame=start)
        pivot.rotation_euler[2] += math.radians(degrees)
        pivot.keyframe_insert("rotation_euler", index=2, frame=end)
        animated = [pivot]
    elif move in ("dolly_in", "dolly_out"):
        d0, d1 = (distance, distance - travel) if move == "dolly_in" else (distance - travel, distance)
        cam.location.y = -d0
        cam.keyframe_insert("location", index=1, frame=start)
        cam.location.y = -d1
        cam.keyframe_insert("location", index=1, frame=end)
    elif move == "truck":
        # Sideways slide with the aim locked on the target: parallax against the background.
        cam.location.x = -travel / 2
        cam.keyframe_insert("location", index=0, frame=start)
        cam.location.x = travel / 2
        cam.keyframe_insert("location", index=0, frame=end)
    elif move in ("crane_up", "crane_down"):
        z0, z1 = (height, height + travel) if move == "crane_up" else (height + travel, height)
        cam.location.z = z0
        cam.keyframe_insert("location", index=2, frame=start)
        cam.location.z = z1
        cam.keyframe_insert("location", index=2, frame=end)
    elif move == "push_zoom":
        # Dolly in while widening the lens: the subject stays put, the background stretches.
        cam.location.y = -distance
        cam_data.lens = lens
        cam.keyframe_insert("location", index=1, frame=start)
        cam_data.keyframe_insert("lens", frame=start)
        cam.location.y = -(distance - travel)
        cam_data.lens = lens * (distance - travel) / distance
        cam.keyframe_insert("location", index=1, frame=end)
        cam_data.keyframe_insert("lens", frame=end)
        animated.append(cam_data)
    elif move != "static":
        raise ValueError("Unknown move %r" % move)
    if move != "static":
        for item in animated:
            set_easing(item, easing)

    if shake > 0:
        # Handheld feel: jitter the aim point with noise modifiers (Track To keeps the camera on it).
        amp = distance * math.tan(math.radians(shake))
        tgt.keyframe_insert("location", frame=start)
        for fc in fcurves_of(tgt):
            mod = fc.modifiers.new("NOISE")
            mod.scale = 14.0
            mod.strength = amp
            mod.phase = 11.0 * (fc.array_index + 1)

    if dof:
        cam_data.dof.use_dof = True
        cam_data.dof.focus_object = tgt
        cam_data.dof.aperture_fstop = fstop
    if active:
        scene.camera = cam
    if frames:
        scene.frame_start, scene.frame_end = start, end
    return {"camera": cam.name, "pivot": pivot.name, "target": tgt.name, "move": move, "lens": lens, "distance_m": round(distance, 3),
            "height_m": round(height, 3), "frames": [start, end], "dof": dof}


result = build_rig(**PARAMS)

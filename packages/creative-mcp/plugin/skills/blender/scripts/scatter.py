# Scatter copies of an object (or a collection of variants) over a surface with Geometry Nodes
# (Open Herness). Non-destructive: the result is one object with a node modifier you can tweak.
#
# Run through blender_exec / blender_script: send this file's text as `code` with a first line like
#   PARAMS = {"surface": "Ground", "source": "Rock", "density": 3, "seed": 7}
# Parameters:
#   surface        mesh object to scatter on (required)
#   source         object name, or collection name for random picks among variants (required)
#   density        instances per square metre (default 2); or set count for an exact total
#   count          exact number of instances (overrides density)
#   min_distance   Poisson-disk spacing in m, keeps instances from overlapping (default 0 = random)
#   seed           random seed (default 0); change it for another take
#   scale          [min, max] uniform random scale (default [0.7, 1.3])
#   align_normal   tilt instances to the surface normal (default False: upright, good for trees/props on gentle ground)
#   random_tilt    extra random tilt in degrees on X/Y (default 0; 5-15 for rocks/debris)
#   name           result object name (default "Scatter <source>")
#   hide_source    hide the source object/collection in renders and viewport (default True)
#   Collection sources: each variant is moved to the world origin (rotation and scale are kept and
#   carried into the instances); the collection is hidden, so the moved variants are not seen.
# Sets `result` with the instance count.

import math

import bpy

PARAMS = globals().get("PARAMS", {})


def _sockets(tree):
    tree.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")


def scatter(surface, source, density=2.0, count=None, min_distance=0.0, seed=0, scale=(0.7, 1.3), align_normal=False,
            random_tilt=0.0, name=None, hide_source=True):
    scene = bpy.context.scene
    surf = bpy.data.objects.get(surface)
    if surf is None or surf.type != "MESH":
        raise ValueError("surface %r must be a mesh object" % surface)
    src_obj = bpy.data.objects.get(source)
    src_coll = None if src_obj else bpy.data.collections.get(source)
    if src_obj is None and src_coll is None:
        raise ValueError("No object or collection named %r" % source)
    name = name or "Scatter %s" % source

    old = bpy.data.objects.get(name)
    if old is not None:
        bpy.data.objects.remove(old)
    mesh = bpy.data.meshes.new(name)
    holder = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(holder)

    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    _sockets(tree)
    n = tree.nodes
    link = tree.links.new
    out = n.new("NodeGroupOutput"); out.location = (1100, 0)
    surf_info = n.new("GeometryNodeObjectInfo"); surf_info.location = (-800, 0)
    surf_info.inputs["Object"].default_value = surf
    surf_info.transform_space = "RELATIVE"  # follow the surface's transform

    dist = n.new("GeometryNodeDistributePointsOnFaces"); dist.location = (-550, 0)
    area = sum(p.area for p in surf.data.polygons) * abs(surf.scale.x * surf.scale.y)
    dens = (count / max(area, 1e-6)) if count else density
    if min_distance > 0:
        dist.distribute_method = "POISSON"
        dist.inputs["Distance Min"].default_value = min_distance
        dist.inputs["Density Max"].default_value = dens
    else:
        dist.inputs["Density"].default_value = dens
    dist.inputs["Seed"].default_value = seed
    link(surf_info.outputs["Geometry"], dist.inputs["Mesh"])

    inst = n.new("GeometryNodeInstanceOnPoints"); inst.location = (500, 0)
    link(dist.outputs["Points"], inst.inputs["Points"])
    if src_obj is not None:
        src = n.new("GeometryNodeObjectInfo")
        src.inputs["Object"].default_value = src_obj
        src.inputs["As Instance"].default_value = True
        link(src.outputs["Geometry"], inst.inputs["Instance"])
    else:
        src = n.new("GeometryNodeCollectionInfo")
        src.inputs["Collection"].default_value = src_coll
        src.inputs["Separate Children"].default_value = True
        src.inputs["Reset Children"].default_value = False
        # Instances carry each variant's own transform; with the variant at the origin, only its
        # rotation/scale remain (Reset Children did not reliably drop the offset in renders).
        for child in src_coll.all_objects:
            if child.parent is None:
                child.location = (0.0, 0.0, 0.0)
        link(src.outputs["Instances"], inst.inputs["Instance"])
        inst.inputs["Pick Instance"].default_value = True
        pick = n.new("FunctionNodeRandomValue"); pick.location = (250, -350)
        pick.data_type = "INT"
        pick.inputs["Max"].default_value = 1000  # modulo by the number of children happens inside Instance on Points
        pick.inputs["Seed"].default_value = seed + 3
        link(pick.outputs[2], inst.inputs["Instance Index"])
    src.location = (250, 250)

    # Rotation: random spin around the up axis, optional tilt, optionally on top of the surface normal.
    spin = n.new("FunctionNodeRandomValue"); spin.location = (-300, -300)
    spin.data_type = "FLOAT_VECTOR"
    tilt = math.radians(random_tilt)
    spin.inputs["Min"].default_value = (-tilt, -tilt, 0.0)
    spin.inputs["Max"].default_value = (tilt, tilt, 2 * math.pi)
    spin.inputs["Seed"].default_value = seed + 1
    euler = n.new("FunctionNodeEulerToRotation"); euler.location = (-100, -300)
    link(spin.outputs["Value"], euler.inputs["Euler"])
    if align_normal:
        rot = n.new("FunctionNodeRotateRotation"); rot.location = (150, -200)
        rot.rotation_space = "LOCAL"
        link(dist.outputs["Rotation"], rot.inputs["Rotation"])
        link(euler.outputs["Rotation"], rot.inputs["Rotate By"])
        link(rot.outputs["Rotation"], inst.inputs["Rotation"])
    else:
        link(euler.outputs["Rotation"], inst.inputs["Rotation"])

    size = n.new("FunctionNodeRandomValue"); size.location = (150, -500)
    size.data_type = "FLOAT"
    size.inputs[2].default_value = scale[0]  # float Min
    size.inputs[3].default_value = scale[1]  # float Max
    size.inputs["Seed"].default_value = seed + 2
    link(size.outputs[1], inst.inputs["Scale"])

    link(inst.outputs["Instances"], out.inputs["Geometry"])
    mod = holder.modifiers.new("Scatter", "NODES")
    mod.node_group = tree

    if hide_source:
        if src_obj is not None:
            src_obj.hide_render = True
            src_obj.hide_set(True)
        else:
            for layer_coll in bpy.context.view_layer.layer_collection.children:
                if layer_coll.collection == src_coll:
                    layer_coll.exclude = True
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    instances = sum(1 for i in depsgraph.object_instances if i.is_instance and i.parent and i.parent.original == holder)
    return {"object": holder.name, "node_group": tree.name, "instances": instances, "density_per_m2": round(dens, 4), "surface_area_m2": round(area, 2)}


result = scatter(**PARAMS)

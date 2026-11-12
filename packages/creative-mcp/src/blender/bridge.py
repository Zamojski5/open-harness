# Open Herness bridge for Blender.
# Started by the Open Herness creative MCP server:  blender --python bridge.py [file.blend]
# Runs a localhost TCP server (newline-delimited JSON) so an agent can drive the live session.
# Commands run on Blender's main thread through bpy.app.timers (bpy is not thread-safe).
#
# Env: OH_BLENDER_PORT (default 9876), OH_BLENDER_TOKEN (required token for every request).

import base64
import contextlib
import io
import json
import os
import queue
import socket
import tempfile
import threading
import traceback

import bpy

PORT = int(os.environ.get("OH_BLENDER_PORT", "9876"))
TOKEN = os.environ.get("OH_BLENDER_TOKEN", "")

_requests = queue.Queue()


def _jsonable(value, depth=0):
    if depth > 4:
        return repr(value)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, depth + 1) for v in value[:200]]
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in list(value.items())[:200]}
    try:
        return [round(float(v), 5) for v in value]  # mathutils vectors, colors
    except Exception:
        return repr(value)


def scene_info():
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        item = {
            "name": obj.name,
            "type": obj.type,
            "location": _jsonable(obj.location),
            "rotation": _jsonable(obj.rotation_euler),
            "scale": _jsonable(obj.scale),
            "dimensions": _jsonable(obj.dimensions),
            "visible": obj.visible_get(),
            "parent": obj.parent.name if obj.parent else None,
        }
        if obj.type == "MESH" and obj.data:
            item["vertices"] = len(obj.data.vertices)
            item["materials"] = [m.name for m in obj.data.materials if m]
        if obj.type == "LIGHT":
            item["light"] = {"type": obj.data.type, "energy": obj.data.energy, "color": _jsonable(obj.data.color)}
        if obj.type == "CAMERA":
            item["lens"] = obj.data.lens
        if obj.animation_data and obj.animation_data.action:
            item["animated"] = True
        objects.append(item)
    render = scene.render
    return {
        "file": bpy.data.filepath or None,
        "scene": scene.name,
        "frame": {"start": scene.frame_start, "end": scene.frame_end, "current": scene.frame_current, "fps": render.fps},
        "render": {
            "engine": render.engine,
            "resolution": [render.resolution_x, render.resolution_y, render.resolution_percentage],
            "output": render.filepath,
        },
        "camera": scene.camera.name if scene.camera else None,
        "selected": [o.name for o in bpy.context.selected_objects],
        "active": bpy.context.view_layer.objects.active.name if bpy.context.view_layer.objects.active else None,
        "collections": [c.name for c in bpy.data.collections],
        "materials": [m.name for m in bpy.data.materials],
        "objects": objects,
        "version": bpy.app.version_string,
    }


def run_code(code):
    namespace = {"bpy": bpy, "__name__": "__oh__"}
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        exec(compile(code, "<agent>", "exec"), namespace)
    return {"output": out.getvalue()[-1000000:], "result": _jsonable(namespace.get("result"))}


def view3d_screenshot(width, shading=None):
    path = os.path.join(tempfile.gettempdir(), f"oh-blender-view-{os.getpid()}.png")
    window = bpy.context.window_manager.windows[0]
    area = max((a for a in window.screen.areas if a.type == "VIEW_3D"), key=lambda a: a.width * a.height, default=None)
    if area is None:
        raise RuntimeError("No 3D viewport is open")
    space = area.spaces.active
    previous = space.shading.type
    if shading:
        space.shading.type = shading
        area.tag_redraw()
    # Material/rendered previews compile shaders over several redraws; give them time so the
    # capture is not a "Compiling shaders" frame.
    redraws = 12 if (shading or space.shading.type) in ("MATERIAL", "RENDERED") else 1
    bpy.ops.wm.redraw_timer(type="DRAW_WIN_SWAP", iterations=redraws)
    try:
        with bpy.context.temp_override(window=window, area=area):
            bpy.ops.screen.screenshot_area(filepath=path)
    finally:
        if shading:
            space.shading.type = previous
    img = bpy.data.images.load(path, check_existing=False)
    try:
        if width and img.size[0] > width:
            img.scale(width, int(img.size[1] * width / img.size[0]))
            img.save()
    finally:
        bpy.data.images.remove(img)
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    os.remove(path)
    return {"png": data}


def handle(req):
    cmd = req.get("cmd")
    if cmd == "ping":
        return {"pong": True, "version": bpy.app.version_string, "file": bpy.data.filepath or None}
    if cmd == "scene":
        return scene_info()
    if cmd == "exec":
        result = run_code(req.get("code", ""))
        # keep the viewport in sync after edits
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                area.tag_redraw()
        return result
    if cmd == "screenshot":
        return view3d_screenshot(int(req.get("width") or 1400), req.get("shading"))
    if cmd == "save":
        path = req.get("path")
        if req.get("copy"):
            bpy.ops.wm.save_as_mainfile(filepath=path, copy=True)
        elif path:
            bpy.ops.wm.save_as_mainfile(filepath=path)
        else:
            bpy.ops.wm.save_mainfile()
        return {"saved": path or bpy.data.filepath}
    if cmd == "open":
        bpy.ops.wm.open_mainfile(filepath=req["path"])
        return {"opened": req["path"]}
    raise ValueError(f"unknown command {cmd}")


def _drain():
    while True:
        try:
            req, reply = _requests.get_nowait()
        except queue.Empty:
            break
        try:
            reply({"id": req.get("id"), "ok": True, "data": handle(req)})
        except Exception as error:
            reply({"id": req.get("id"), "ok": False, "error": str(error), "traceback": traceback.format_exc()[-6000:]})
    return 0.05


def _serve_client(conn):
    with conn:
        buf = b""
        lock = threading.Lock()

        def reply(payload):
            with lock:
                try:
                    conn.sendall((json.dumps(payload) + "\n").encode())
                except OSError:
                    pass

        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line)
                except ValueError:
                    reply({"ok": False, "error": "bad json"})
                    continue
                if TOKEN and req.get("token") != TOKEN:
                    reply({"id": req.get("id"), "ok": False, "error": "unauthorized"})
                    continue
                _requests.put((req, reply))


def _listen():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(4)
    print(f"[open-herness] Blender bridge listening on 127.0.0.1:{PORT}", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=_serve_client, args=(conn,), daemon=True).start()


threading.Thread(target=_listen, daemon=True).start()
bpy.app.timers.register(_drain, persistent=True)

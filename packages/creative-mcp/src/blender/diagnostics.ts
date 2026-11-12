// Blender diagnostics: light-solo renders, per-object look comparison against a reference and
// render-time budgeting. Everything runs in a background Blender on the given .blend or a snapshot of
// the live scene; the source file is opened read-only and never saved (derived copies go to ./takes/).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { crop, drawRect, drawText, grid, hueName, type Img, type Look, measureLook, mediaSize, newImg, paste, readImage, type RGB, writeJpeg } from "../quality/raster.ts";
import { headless, slug, sourceFile, takePath } from "./tools.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
};
const qaDir = () => {
  const d = join(process.cwd(), "takes", "qa");
  mkdirSync(d, { recursive: true });
  return d;
};

/** Shared prelude: scene/render handles, optional camera + frame, GPU for Cycles. */
const prelude = (params: Record<string, unknown>) => `import bpy, json, os, time
P = json.loads(${JSON.stringify(JSON.stringify(params))})
s = bpy.context.scene
r = s.render
vl = bpy.context.view_layer
if P.get('camera'):
    cam = bpy.data.objects.get(P['camera'])
    if cam is None or cam.type != 'CAMERA':
        raise Exception('OH_ERR camera not found: ' + P['camera'] + ' (cameras: ' + ', '.join(o.name for o in s.objects if o.type == 'CAMERA') + ')')
    s.camera = cam
if s.camera is None:
    raise Exception('OH_ERR the scene has no camera; pass camera=')
if P.get('frame') is not None:
    s.frame_set(int(P['frame']))
def use_gpu():
    if r.engine != 'CYCLES':
        return
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        s.cycles.device = 'GPU'
    except Exception:
        pass
`;

/** Runs a script in background Blender; Python errors come back as a readable message. */
async function blender(file: string, script: string, timeoutMs?: number) {
  try {
    return await headless(file, script, timeoutMs);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const all = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    const oh = [...all.matchAll(/^\w*(?:Error|Exception): OH_ERR (.+)$/gm)].at(-1)?.[1];
    throw new Error(oh ?? `${e.message ?? error}\n${all.slice(-2500)}`);
  }
}

const marker = <T>(log: string, tag: string): T => {
  const line = log.split("\n").find((l) => l.startsWith(`${tag} `));
  if (!line) throw new Error(`Blender did not report ${tag}.\n${log.slice(-2500)}`);
  return JSON.parse(line.slice(tag.length + 1)) as T;
};

async function resolveSource(file?: string) {
  const src = await sourceFile(file);
  if (!src) throw new Error("No scene: pass file=<.blend> or start the live session with blender_launch.");
  return src;
}

// ---------------------------------------------------------------------------------------------
// Light solo
// ---------------------------------------------------------------------------------------------
const SOLO_PY = `
import numpy as np
use_gpu()
pct = P.get('pct') or max(5, min(100, round(100 * 480 / max(1, r.resolution_x))))
r.resolution_percentage = pct
r.film_transparent = False
r.use_stamp = False
samples = P.get('samples') or 16
if r.engine == 'CYCLES':
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    r.use_persistent_data = True
elif r.engine.startswith('BLENDER_EEVEE'):
    s.eevee.taa_render_samples = samples
lights = [o for o in s.objects if o.type == 'LIGHT' and not o.hide_render and o.name in vl.objects]
world = s.world
black = bpy.data.worlds.new('OH solo black')
if black.node_tree is None:
    black.use_nodes = True
for n in black.node_tree.nodes:
    if n.type == 'BACKGROUND':
        n.inputs['Color'].default_value = (0, 0, 0, 1)
        n.inputs['Strength'].default_value = 0
black.color = (0, 0, 0)
emissive = []
for m in bpy.data.materials:
    if not m.users or not m.node_tree:
        continue
    for n in m.node_tree.nodes:
        if (n.type == 'EMISSION' and n.inputs['Strength'].default_value > 0) or (n.type == 'BSDF_PRINCIPLED' and n.inputs['Emission Strength'].default_value > 0 and max(n.inputs['Emission Color'].default_value[:3]) > 0):
            emissive.append(m.name)
            break
def light_info(o):
    l = o.data
    info = {'type': l.type, 'energy': round(l.energy, 3), 'color': [round(c, 3) for c in l.color]}
    if getattr(l, 'use_temperature', False):
        info['temperature'] = getattr(l, 'temperature', None)
    return info
passes = [('ALL', [o.name for o in lights], world, None)]
passes += [(o.name, [o.name], black, light_info(o)) for o in lights]
if world is not None:
    passes.append(('WORLD ONLY', [], world, None))
if emissive:
    passes.append(('EMISSION ONLY', [], black, None))
res = []
for i, (label, on, w, info) in enumerate(passes):
    for o in lights:
        o.hide_render = o.name not in on
    s.world = w
    t = time.time()
    bpy.ops.render.render()
    sec = time.time() - t
    rr = bpy.data.images['Render Result']
    r.image_settings.file_format = 'OPEN_EXR'
    r.image_settings.color_depth = '32'
    exr = os.path.join(P['out'], 'p%02d.exr' % i)
    rr.save_render(exr, scene=s)
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    r.image_settings.color_depth = '8'
    png = os.path.join(P['out'], 'p%02d.png' % i)
    rr.save_render(png, scene=s)
    im = bpy.data.images.load(exr)
    px = np.empty(len(im.pixels), dtype=np.float32)
    im.pixels.foreach_get(px)
    rgb = px.reshape(-1, 4)[:, :3]
    mean = rgb.mean(axis=0)
    bpy.data.images.remove(im)
    res.append({'label': label, 'png': png, 'mean': [float(x) for x in mean], 'Y': float(mean[0] * 0.2126 + mean[1] * 0.7152 + mean[2] * 0.0722), 'sec': round(sec, 2), 'light': info})
print('OH_SOLO ' + json.dumps({'passes': res, 'engine': r.engine, 'pct': pct, 'emissive': emissive, 'camera': s.camera.name}))
`;

interface SoloPass {
  label: string;
  png: string;
  mean: number[];
  Y: number;
  sec: number;
  light: { type: string; energy: number; color: number[]; temperature?: number } | null;
}

function clippedShare(img: Img) {
  let c = 0;
  for (let i = 0; i < img.w * img.h; i++) if (Math.max(img.data[i * 3]!, img.data[i * 3 + 1]!, img.data[i * 3 + 2]!) >= 250) c++;
  return (100 * c) / (img.w * img.h);
}

// ---------------------------------------------------------------------------------------------
// Compare to reference
// ---------------------------------------------------------------------------------------------
const BBOX_PY = `
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
cam = s.camera
deps = bpy.context.evaluated_depsgraph_get()
kinds = {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT'}
names = P.get('objects') or [o.name for o in s.objects if o.type in kinds and not o.hide_render and o.name in vl.objects]
out = []
for name in names:
    o = s.objects.get(name)
    if o is None:
        out.append({'name': name, 'error': 'not found'})
        continue
    ev = o.evaluated_get(deps)
    mw = ev.matrix_world
    pts = []
    try:
        me = ev.to_mesh()
        vs = me.vertices
        step = max(1, len(vs) // 4000)
        pts = [mw @ vs[i].co for i in range(0, len(vs), step)]
        if len(vs) < 2000:
            # Low-poly (planes, boxes): sample along edges too, so big faces crossing the camera plane still get a box.
            for e in me.edges[:4000]:
                a, b = vs[e.vertices[0]].co, vs[e.vertices[1]].co
                pts += [mw @ a.lerp(b, k / 8) for k in range(1, 8)]
        ev.to_mesh_clear()
    except Exception:
        pass
    if not pts:
        pts = [mw @ Vector(c) for c in ev.bound_box]
    ndc = [world_to_camera_view(s, cam, p) for p in pts]
    front = [v for v in ndc if v.z > 0]
    if not front:
        out.append({'name': name, 'visible': False})
        continue
    xs = [min(1.0, max(0.0, v.x)) for v in front]
    ys = [min(1.0, max(0.0, v.y)) for v in front]
    box = [min(xs), 1 - max(ys), max(xs), 1 - min(ys)]
    out.append({'name': name, 'box': box, 'visible': (box[2] - box[0]) > 0.003 and (box[3] - box[1]) > 0.003, 'depth': round(min(v.z for v in front), 3)})
aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y)
print('OH_BBOX ' + json.dumps({'camera': cam.name, 'aspect': aspect, 'objects': out}))
`;

type Box = [number, number, number, number]; // normalized x0, y0, x1, y1 (top-left origin)
const COLORS: RGB[] = [[255, 70, 70], [70, 200, 255], [255, 210, 60], [120, 255, 120], [255, 120, 255], [255, 150, 60], [160, 140, 255], [60, 255, 210], [255, 255, 255], [200, 200, 120]];

interface Gap {
  text: string;
  fix: string;
  weight: number;
}

/** Plain-language gaps of region R (render) vs F (reference); detail=false skips texture/contrast for tiny regions. */
function gapsFor(name: string, R: Look, F: Look, detail: boolean): Gap[] {
  const g: Gap[] = [];
  const dL = R.L - F.L;
  if (Math.abs(dL) > 8) g.push({ text: `${name} ${dL < 0 ? "darker" : "brighter"} than the reference (L* ${R.L.toFixed(0)} vs ${F.L.toFixed(0)})`, fix: dL < 0 ? "raise base colour value/albedo or the light reaching it (or exposure +0.3-1 stop)" : "darken base colour/albedo, lower the light on it or exposure", weight: Math.abs(dL) / 8 });
  const da = R.a - F.a;
  const db = R.b - F.b;
  const shift = Math.hypot(da, db);
  if (shift > 6) g.push({ text: `${name} colour shifted toward ${hueName(da, db)} (Δa* ${da.toFixed(0)}, Δb* ${db.toFixed(0)})`, fix: `tint base colour / light temperature toward ${hueName(-da, -db)}, or correct in the grade`, weight: shift / 6 });
  const dC = R.chroma - F.chroma;
  if (Math.abs(dC) > 7) g.push({ text: `${name} ${dC > 0 ? "more" : "less"} saturated (chroma ${R.chroma.toFixed(0)} vs ${F.chroma.toFixed(0)})`, fix: dC > 0 ? "desaturate base colour (HSV saturation) or the grade" : "richer base colour, coloured bounce/fill, or saturation in the grade", weight: Math.abs(dC) / 7 });
  if (!detail) return g;
  const cr = R.contrast / Math.max(0.5, F.contrast);
  if (cr < 0.7) g.push({ text: `${name} flatter than the reference (contrast ${R.contrast.toFixed(1)} vs ${F.contrast.toFixed(1)})`, fix: "stronger key:fill ratio (less fill/world light), darker crevices (AO/cavity mask into base colour or roughness), a contrast curve", weight: (1 / cr - 1) * 2 });
  else if (cr > 1.45) g.push({ text: `${name} harsher than the reference (contrast ${R.contrast.toFixed(1)} vs ${F.contrast.toFixed(1)})`, fix: "more fill/bounce, larger (softer) key light, lift shadows", weight: (cr - 1) * 2 });
  if (F.highlights > 4 && R.highlights < F.highlights * 0.5) g.push({ text: `${name} lacks specular highlights (peak ${R.highlights.toFixed(0)} vs ${F.highlights.toFixed(0)} L* above the 90th percentile)`, fix: "lower roughness (with variation), add a rim/back light or an HDRI hot spot that reflects in it", weight: F.highlights / Math.max(1, R.highlights) - 0.5 });
  else if (R.highlights > 6 && R.highlights > F.highlights * 1.8) g.push({ text: `${name} too glossy / hot highlights (peak ${R.highlights.toFixed(0)} vs ${F.highlights.toFixed(0)} L*)`, fix: "raise roughness (and vary it with a grunge map), lower specular or the key light hitting it", weight: R.highlights / Math.max(1, F.highlights) - 0.5 });
  const tr = R.texture / Math.max(0.05, F.texture);
  if (tr < 0.6) g.push({ text: `${name} too smooth (fine detail ${R.texture.toFixed(2)} vs ${F.texture.toFixed(2)})`, fix: "raise roughness variation (grunge/noise into Roughness), add normal/bump detail or displacement, use a higher-res or more detailed texture", weight: (1 / tr - 1) * 1.5 });
  else if (tr > 1.7) g.push({ text: `${name} busier/noisier than the reference (fine detail ${R.texture.toFixed(2)} vs ${F.texture.toFixed(2)})`, fix: "lower bump/normal strength or noise scale, larger texture scale; if it is render noise, more samples or denoise", weight: (tr - 1) * 1.2 });
  return g;
}

// ---------------------------------------------------------------------------------------------
// Render budget
// ---------------------------------------------------------------------------------------------
const PROBE_PY = `
use_gpu()
st = P.get('settings') or {}
if 'engine' in st:
    r.engine = st['engine']
use_gpu()
if 'pct' in st:
    r.resolution_percentage = st['pct']
if r.engine == 'CYCLES':
    c = s.cycles
    if 'samples' in st: c.samples = st['samples']
    if 'denoise' in st: c.use_denoising = st['denoise']
    if 'max_bounces' in st: c.max_bounces = st['max_bounces']
    if 'volume_step_rate' in st: c.volume_step_rate = st['volume_step_rate']
    if 'adaptive_threshold' in st:
        c.use_adaptive_sampling = True
        c.adaptive_threshold = st['adaptive_threshold']
    r.use_persistent_data = True
elif r.engine.startswith('BLENDER_EEVEE'):
    e = s.eevee
    if 'samples' in st: e.taa_render_samples = st['samples']
    if 'vol_tile' in st: e.volumetric_tile_size = st['vol_tile']
    if 'vol_samples' in st: e.volumetric_samples = st['vol_samples']
    if 'raytracing' in st: e.use_raytracing = st['raytracing']
def has_volume():
    for m in bpy.data.materials:
        if m.users and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'OUTPUT_MATERIAL' and n.inputs['Volume'].is_linked:
                    return True
    w = s.world
    if w and w.node_tree:
        for n in w.node_tree.nodes:
            if n.type == 'OUTPUT_WORLD' and n.inputs['Volume'].is_linked:
                return True
    return False
start = P.get('start') if P.get('start') is not None else s.frame_start
end = P.get('end') if P.get('end') is not None else (start + P['count'] - 1 if P.get('count') else s.frame_end)
info = {'engine': r.engine, 'pct': r.resolution_percentage, 'res': [r.resolution_x, r.resolution_y], 'start': start, 'end': end, 'volume': has_volume(), 'fps': r.fps}
if r.engine == 'CYCLES':
    c = s.cycles
    info.update({'samples': c.samples, 'denoise': c.use_denoising, 'max_bounces': c.max_bounces, 'volume_step_rate': c.volume_step_rate, 'adaptive': c.use_adaptive_sampling})
elif r.engine.startswith('BLENDER_EEVEE'):
    e = s.eevee
    info.update({'samples': e.taa_render_samples, 'raytracing': e.use_raytracing, 'vol_tile': e.volumetric_tile_size, 'vol_samples': e.volumetric_samples})
r.image_settings.file_format = 'PNG'
times = []
mid = (start + end) // 2
for k, f in enumerate([mid, min(end, mid + 1)]):
    s.frame_set(f)
    r.filepath = P['out']
    t = time.time()
    bpy.ops.render.render(write_still=True)
    times.append(round(time.time() - t, 2))
    if times[0] > 90 or end == start:
        break
info['times'] = times
info['sec'] = times[-1]
if P.get('save'):
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=P['save'], copy=True)
    info['saved'] = P['save']
print('OH_PROBE ' + json.dumps(info))
`;

interface ProbeInfo {
  engine: string;
  pct: number;
  res: [number, number];
  start: number;
  end: number;
  volume: boolean;
  fps: number;
  samples?: number;
  denoise?: boolean;
  max_bounces?: number;
  volume_step_rate?: number;
  raytracing?: boolean;
  vol_tile?: string;
  vol_samples?: number;
  times: number[];
  sec: number;
  saved?: string;
}

/** Degradation ladder: cheapest visual loss first, until the estimated speed-up covers `need`. */
function planSettings(p: ProbeInfo, need: number, samplesSaturated = false) {
  const st: Record<string, unknown> = {};
  const steps: string[] = [];
  let f = 1;
  const more = () => f < need;
  if (p.engine === "CYCLES") {
    if (!p.denoise) {
      st.denoise = true;
      steps.push("denoiser on (OpenImageDenoise) so fewer samples stay clean");
    }
    const s0 = p.samples ?? 128;
    if (more() && s0 > 32 && !samplesSaturated) {
      const s1 = Math.max(32, Math.round(s0 / need));
      st.samples = s1;
      st.adaptive_threshold = 0.03;
      f *= s0 / s1;
      steps.push(`samples ${s0} -> ${s1}, adaptive threshold 0.03 (~${(s0 / s1).toFixed(1)}x)`);
    }
    if (more() && p.volume && (p.volume_step_rate ?? 1) < 4) {
      st.volume_step_rate = 4;
      f *= 1.5;
      steps.push(`volume step rate ${p.volume_step_rate} -> 4 (~1.5x, blotchier fog)`);
    }
    if (more() && (p.max_bounces ?? 12) > 4) {
      st.max_bounces = 4;
      f *= 1.2;
      steps.push(`max bounces ${p.max_bounces} -> 4 (~1.2x, darker interiors)`);
    }
  } else if (p.engine.startsWith("BLENDER_EEVEE")) {
    const s0 = p.samples ?? 64;
    if (s0 > 16 && !samplesSaturated) {
      const s1 = Math.max(16, Math.round(s0 / need));
      st.samples = s1;
      f *= Math.max(1, (s0 / s1) * 0.8);
      steps.push(`EEVEE samples ${s0} -> ${s1} (~${Math.max(1, (s0 / s1) * 0.8).toFixed(1)}x; soft shadows/DOF get noisier)`);
    }
    if (more() && p.volume && Number(p.vol_tile ?? 8) < 16) {
      st.vol_tile = "16";
      st.vol_samples = 32;
      f *= 1.3;
      steps.push("volumetric tile 16 px, 32 samples (~1.3x, softer shafts)");
    }
    if (more() && p.raytracing) {
      st.raytracing = false;
      f *= 1.3;
      steps.push("raytracing off (~1.3x, loses screen-space reflections/GI)");
    }
  }
  if (more() && p.pct > 50) {
    const pct = Math.max(50, Math.min(p.pct - 5, Math.round(p.pct / Math.sqrt(need / f))));
    st.pct = pct;
    f *= (p.pct / pct) ** 2;
    steps.push(`resolution ${p.pct}% -> ${pct}% (~${((p.pct / pct) ** 2).toFixed(1)}x; upscale in the edit, or deliver smaller)`);
  }
  if (f < need * 0.85 && p.engine === "CYCLES") {
    st.engine = "BLENDER_EEVEE";
    f *= 8;
    steps.push("switch to EEVEE (~5-20x; the look changes: check GI, shadows, glass and volumes on a still first)");
  }
  return { st, steps, factor: f };
}

const frameRange = (frames: number | string | undefined) => {
  if (frames === undefined) return {};
  if (typeof frames === "number") return { count: frames };
  const m = /^\s*(-?\d+)\s*[-:]\s*(-?\d+)\s*$/.exec(frames);
  if (m) return { start: Number(m[1]), end: Number(m[2]) };
  if (/^\d+$/.test(frames.trim())) return { count: Number(frames) };
  throw new Error(`frames must be a count (240) or a range ("1-240"), got '${frames}'`);
};

const mins = (sec: number) => (sec >= 90 ? `${(sec / 60).toFixed(1)} min` : `${sec.toFixed(0)} s`);

export function registerBlenderDiagnostics(server: McpServer) {
  server.registerTool(
    "blender_light_solo",
    {
      description:
        "Diagnose lighting: renders each light alone (all other lights hidden, black world), the world alone, emission alone (if any emissive materials) and everything together, at low samples/resolution in a background Blender (the scene is never modified or saved). Returns a labelled contact sheet plus per-pass numbers: share of the total light (linear), mean L*, colour cast (a*/b* hue), clipped %. Use it when a render looks washed out, flat, too dark or tinted, to see which light causes it before changing anything.",
      inputSchema: {
        file: z.string().optional().describe(".blend to diagnose (default: snapshot of the live scene)"),
        camera: z.string().optional().describe("Camera object name (default: scene camera)"),
        frame: z.number().int().optional(),
        resolution_percentage: z.number().int().min(5).max(100).optional().describe("Default: about 480 px wide"),
        samples: z.number().int().min(1).max(1024).optional().describe("Default 16 (Cycles with denoise / EEVEE)"),
      },
    },
    async ({ file, camera, frame, resolution_percentage, samples }) => {
      const out = mkdtempSync(join(tmpdir(), "oh-solo-"));
      try {
        const src = await resolveSource(file);
        const log = await blender(src, prelude({ camera, frame, pct: resolution_percentage, samples, out }) + SOLO_PY, 3_600_000);
        const data = marker<{ passes: SoloPass[]; engine: string; pct: number; emissive: string[]; camera: string }>(log, "OH_SOLO");
        const all = data.passes[0]!;
        const rows: string[] = [];
        const flags: string[] = [];
        const cells: Img[] = [];
        const lightShares: { label: string; share: number }[] = [];
        for (const p of data.passes) {
          const img = await readImage(p.png, 320);
          const look = measureLook(img);
          const clip = clippedShare(img);
          const share = all.Y > 1e-6 ? (100 * p.Y) / all.Y : 0;
          const cast = Math.hypot(look.a, look.b);
          const castText = cast > 5 ? `${hueName(look.a, look.b)} cast ${cast.toFixed(0)}` : "neutral";
          const isLight = !!p.light;
          rows.push(`- ${p.label}${p.light ? ` (${p.light.type} ${p.light.energy}${p.light.type === "SUN" ? " W/m2" : " W"}, colour ${p.light.color.map((c) => c.toFixed(2)).join("/")}${p.light.temperature ? `, ${p.light.temperature} K` : ""})` : ""}: ${p.label === "ALL" ? "100" : share.toFixed(0)}% of the light, L* ${look.L.toFixed(0)}, ${castText}, clipped ${clip.toFixed(1)}%, ${p.sec}s`);
          if (isLight) lightShares.push({ label: p.label, share });
          if (isLight && share < 3) flags.push(`${p.label} barely contributes (${share.toFixed(1)}% of the light): raise it, aim it at the subject, or delete it to save render time.`);
          if (isLight && (clip > 3 || look.L > 75)) flags.push(`${p.label} washes out on its own (clipped ${clip.toFixed(1)}%, L* ${look.L.toFixed(0)}): lower its power, move it back, or enlarge it for a softer falloff.`);
          if (isLight && share > 60 && data.passes.filter((x) => x.light).length >= 2) flags.push(`${p.label} dominates (${share.toFixed(0)}% of all light)${/rim|back|kick/i.test(p.label) ? "; a rim/back light should be an accent, not the main source" : ""}: if it is not meant to be the key, cut its power by ~${Math.round(100 - 4000 / share)}% or narrow/aim it so it stops flooding the set.`);
          if (isLight && cast > 10) flags.push(`${p.label} casts ${hueName(look.a, look.b)} (strength ${cast.toFixed(0)}). Intended? Otherwise use a more neutral colour/temperature (5000-6500 K) or balance it with a complementary fill.`);
          if (p.label === "WORLD ONLY") {
            if (share > 55 && data.passes.some((x) => x.light)) flags.push(`The world/HDRI gives ${share.toFixed(0)}% of the light: flat, ambient look. Lower world strength (or rotate the HDRI) and let the key light shape the subject.`);
            if (cast > 10) flags.push(`The world tints everything ${hueName(look.a, look.b)} (strength ${cast.toFixed(0)}): desaturate/neutralise the HDRI or world colour, or white-balance in the grade.`);
          }
          if (p.label === "ALL") {
            if (clip > 3) flags.push(`Full render clips ${clip.toFixed(1)}% of pixels: lower exposure or the strongest light (see shares).`);
            if (look.L > 72) flags.push(`Full render is washed out (L* ${look.L.toFixed(0)}): lower exposure or the dominant light; keep large bright areas (floor, sky) below L* ~70 unless high-key is the brief.`);
            if (look.L < 22) flags.push(`Full render is dark (L* ${look.L.toFixed(0)}): raise exposure or the key light.`);
            if (cast > 10) flags.push(`Full render has a ${hueName(look.a, look.b)} cast (strength ${cast.toFixed(0)}); the per-light rows show which source causes it.`);
            if (look.contrast < 12) flags.push(`Full render is flat (L* std ${look.contrast.toFixed(1)}): increase the key:fill ratio, reduce world/fill light.`);
          }
          drawText(img, 2, 2, p.label, [255, 255, 255], 1);
          drawText(img, 2, img.h - 11, `${p.label === "ALL" ? "100" : share.toFixed(0)}% L${look.L.toFixed(0)} ${cast > 5 ? hueName(look.a, look.b).split("/")[0] : "neutral"}`, [255, 230, 120], 1);
          cells.push(img);
        }
        const sorted = [...lightShares].sort((a, b) => b.share - a.share);
        if (sorted.length >= 2 && sorted[1]!.share > 0.5) rows.push(`Key:fill ratio (two strongest lights) ${sorted[0]!.label}:${sorted[1]!.label} = ${(sorted[0]!.share / sorted[1]!.share).toFixed(1)}:1 (drama 4-8:1, soft/commercial 2-3:1).`);
        if (!lightShares.length) flags.push("No light objects: everything comes from the world and emissive materials.");
        const sheet = await writeJpeg(grid(cells, 3, 320, cells[0]!.h), join(qaDir(), `light-solo-${slug(basename(file ?? "live", ".blend"))}.jpg`));
        const lines = [
          `blender_light_solo (${data.engine}, camera ${data.camera}, ${data.pct}% resolution): shares are linear light relative to ALL; they may not sum to 100 (bounces, emission, denoiser).`,
          ...rows,
          data.emissive.length ? `Emissive materials (lit in every pass, isolated in EMISSION ONLY): ${data.emissive.join(", ")}.` : "",
          "",
          flags.length ? "Findings:" : "No obvious wash-out or cast from a single source.",
          ...flags.map((f) => `- ${f}`),
          "",
          `Contact sheet saved ${rel(join(qaDir(), `light-solo-${slug(basename(file ?? "live", ".blend"))}.jpg`))} (label top-left, share/L*/cast bottom-left).`,
        ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
        return { content: [{ type: "text" as const, text: lines.join("\n") }, { type: "image" as const, data: sheet, mimeType: "image/jpeg" }] satisfies Content[] };
      } catch (error) {
        return fail(`blender_light_solo failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 5000));
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );

  server.registerTool(
    "blender_compare_reference",
    {
      description:
        "Per-object look comparison of a render against a reference image. Projects each object's geometry through the shot camera (world_to_camera_view) to get its screen box in the render, then compares that region with the reference: lightness, colour shift, saturation, contrast, specular highlights and fine texture → plain-language gaps with a fix direction (e.g. 'Rock too smooth: raise roughness variation / add normal detail'). The reference side is the whole reference image unless you give ref_box for an object or same_framing=true (reference shot with the same framing, e.g. a plate or an earlier approved take). Without a scene (no file, no live session) it compares whole frames only. Returns text + an annotated side-by-side image.",
      inputSchema: {
        image: z.string().describe("The render (png/jpg) to judge"),
        reference: z.string().describe("Reference image"),
        objects: z
          .array(z.union([z.string(), z.object({ name: z.string(), ref_box: z.array(z.number().min(0).max(1)).length(4).optional().describe("Region of this object in the reference, normalized [x0,y0,x1,y1], top-left origin") })]))
          .optional()
          .describe("Objects to compare (default: the 8 largest visible meshes)"),
        same_framing: z.boolean().optional().describe("The reference has the same framing as the render: compare the same boxes"),
        file: z.string().optional().describe(".blend the render came from (default: snapshot of the live scene)"),
        camera: z.string().optional(),
        frame: z.number().int().optional(),
      },
    },
    async ({ image, reference, objects, same_framing, file, camera, frame }) => {
      try {
        const imgPath = resolve(process.cwd(), image);
        const refPath = resolve(process.cwd(), reference);
        const R = await readImage(imgPath, 1280);
        const F = await readImage(refPath, 1280);
        const names = objects?.map((o) => (typeof o === "string" ? o : o.name));
        const refBoxes = new Map((objects ?? []).flatMap((o) => (typeof o !== "string" && o.ref_box ? [[o.name, o.ref_box as Box] as const] : [])));
        const notes: string[] = [];
        let boxes: { name: string; box: Box }[] = [];
        let src: string | undefined;
        try {
          src = await sourceFile(file);
        } catch (error) {
          notes.push(`Scene unavailable (${error instanceof Error ? error.message : error}); whole-frame comparison only.`);
        }
        if (!src && !notes.length) notes.push("No scene (no file given, live session not running): whole-frame comparison only.");
        if (src) {
          const log = await blender(src, prelude({ camera, frame, objects: names }) + BBOX_PY, 600_000);
          const bb = marker<{ camera: string; aspect: number; objects: { name: string; box?: Box; visible?: boolean; error?: string }[] }>(log, "OH_BBOX");
          if (Math.abs(bb.aspect - R.w / R.h) / bb.aspect > 0.02) notes.push(`Warning: render aspect ${(R.w / R.h).toFixed(3)} differs from the scene's ${bb.aspect.toFixed(3)}; boxes may be off (wrong camera/resolution?).`);
          for (const o of bb.objects) {
            if (o.error) notes.push(`${o.name}: ${o.error}.`);
            else if (!o.visible || !o.box) notes.push(`${o.name}: not in the camera view.`);
            else boxes.push({ name: o.name, box: o.box });
          }
          if (!names) {
            const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
            const skipped = boxes.filter((b) => area(b.box) < 0.005).length;
            boxes = boxes.filter((b) => area(b.box) >= 0.005 && area(b.box) < 0.97).sort((a, b) => area(b.box) - area(a.box)).slice(0, 8);
            if (skipped) notes.push(`${skipped} tiny objects (<0.5% of frame) skipped.`);
          }
          notes.unshift(`Camera ${bb.camera}; boxes from projected geometry (occlusion ignored: a box includes whatever covers the object).`);
        }
        const regions = [{ name: "Whole frame", box: [0, 0, 1, 1] as Box, ref: [0, 0, 1, 1] as Box, mapped: true }, ...boxes.map((b) => ({ name: b.name, box: b.box, ref: refBoxes.get(b.name) ?? (same_framing ? b.box : ([0, 0, 1, 1] as Box)), mapped: refBoxes.has(b.name) || !!same_framing }))];
        const cropOf = (img: Img, b: Box) => crop(img, b[0] * img.w, b[1] * img.h, b[2] * img.w, b[3] * img.h);
        const lines: string[] = [];
        const allGaps: (Gap & { region: string })[] = [];
        const f1 = (n: number) => n.toFixed(1);
        for (const [i, reg] of regions.entries()) {
          const rc = cropOf(R, reg.box);
          const fc = cropOf(F, reg.ref);
          const detail = Math.max(rc.w, rc.h) >= 64 && Math.max(fc.w, fc.h) >= 64;
          const a = measureLook(rc);
          const b = measureLook(fc);
          const gaps = gapsFor(reg.name, a, b, detail);
          allGaps.push(...gaps.map((g) => ({ ...g, region: reg.name })));
          lines.push(
            `${i}. ${reg.name}${i ? ` [box ${reg.box.map((v) => v.toFixed(2)).join(",")}] vs ${reg.mapped ? "same region of the reference" : "whole reference"}` : ""}: L* ${f1(a.L)}/${f1(b.L)}, a*b* ${f1(a.a)},${f1(a.b)}/${f1(b.a)},${f1(b.b)}, chroma ${f1(a.chroma)}/${f1(b.chroma)}, contrast ${f1(a.contrast)}/${f1(b.contrast)}, specular peak ${f1(a.highlights)}/${f1(b.highlights)}, texture ${a.texture.toFixed(2)}/${b.texture.toFixed(2)}${detail ? "" : " (region too small: texture/contrast not judged)"}`,
            ...(gaps.length ? gaps.map((g) => `   - ${g.text} -> ${g.fix}`) : ["   - close to the reference"]),
          );
        }
        // Annotated side-by-side at 360 px height.
        const H = 360;
        const left = await readImage(imgPath, Math.round((H * R.w) / R.h / 2) * 2, H);
        const refSize = await mediaSize(refPath);
        const right = await readImage(refPath, Math.round((H * refSize.w) / refSize.h / 2) * 2, H);
        regions.forEach((reg, i) => {
          if (!i) return;
          const c = COLORS[(i - 1) % COLORS.length]!;
          drawRect(left, reg.box[0] * left.w, reg.box[1] * left.h, reg.box[2] * left.w, reg.box[3] * left.h, c, 2);
          drawText(left, reg.box[0] * left.w + 3, reg.box[1] * left.h + 3, `${i} ${reg.name}`, c, 1);
          if (reg.mapped) {
            drawRect(right, reg.ref[0] * right.w, reg.ref[1] * right.h, reg.ref[2] * right.w, reg.ref[3] * right.h, c, 2);
            drawText(right, reg.ref[0] * right.w + 3, reg.ref[1] * right.h + 3, `${i}`, c, 1);
          }
        });
        drawText(left, 2, H - 20, "RENDER", [255, 255, 255], 2);
        drawText(right, 2, H - 20, "REFERENCE", [255, 255, 255], 2);
        const sheet = newImg(left.w + right.w + 12, H + 8, [255, 255, 255]);
        paste(sheet, left, 4, 4);
        paste(sheet, right, left.w + 8, 4);
        const out = join(process.cwd(), "takes", "compare", `${basename(imgPath, extname(imgPath)).replace(/[^\w-]+/g, "-").slice(0, 40)}-vs-ref-regions.jpg`);
        mkdirSync(join(process.cwd(), "takes", "compare"), { recursive: true });
        const data = await writeJpeg(sheet, out);
        const top = [...allGaps].sort((x, y) => y.weight - x.weight).slice(0, 5);
        const text = [
          `blender_compare_reference ${rel(imgPath)} vs ${rel(refPath)} (values render/reference; L* 0-100, chroma/contrast in L*a*b* units, specular peak = L* of the brightest 0.5% above the 90th percentile, texture = fine surface detail).`,
          ...notes,
          "",
          top.length ? "Biggest gaps (fix these first, one change per take):" : "No significant gaps found.",
          ...top.map((g, i) => `${i + 1}. ${g.text} -> ${g.fix}`),
          "",
          "Per region:",
          ...lines,
          "",
          `Annotated image saved ${rel(out)}. Numbers judge colour/tone/texture statistics, not shape or composition: look at the image too.`,
        ];
        return { content: [{ type: "text" as const, text: text.join("\n") }, { type: "image" as const, data, mimeType: "image/jpeg" }] satisfies Content[] };
      } catch (error) {
        return fail(`blender_compare_reference failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 5000));
      }
    },
  );

  server.registerTool(
    "blender_render_budget",
    {
      description:
        "Fit an animation render into a time budget. Renders a probe frame (mid-shot, timed inside Blender so startup is not counted) with the current settings, estimates the total, and if it is over budget proposes degraded settings in order of least visible loss (Cycles: denoiser + fewer samples/adaptive threshold, volume step rate, bounces, resolution %, then EEVEE; EEVEE: samples, volumetric tile, raytracing, resolution %), re-probes with them and reports the measured new estimate. apply=true saves those settings into a copy ./takes/<name>-budget.blend (the source is never changed). Then render the copy with blender_render file=<copy> animation=true frames_dir=takes/<name>-frames interleaved=true (every 8th frame first for an early preview, resumable, max_minutes slices).",
      inputSchema: {
        budget_minutes: z.number().positive().describe("Wall-clock minutes available for the whole render"),
        frames: z.union([z.number().int().positive(), z.string()]).optional().describe('Frame count from the scene start (240) or a range ("1-240"); default: scene range'),
        file: z.string().optional().describe(".blend to plan (default: snapshot of the live scene)"),
        apply: z.boolean().optional().describe("Save the proposed settings into ./takes/<name>-budget.blend"),
      },
    },
    async ({ budget_minutes, frames, file, apply }) => {
      const tmp = mkdtempSync(join(tmpdir(), "oh-budget-"));
      try {
        const src = await resolveSource(file);
        const range = frameRange(frames);
        const params = { out: join(tmp, "probe.png"), ...range };
        const p0 = marker<ProbeInfo>(await blender(src, prelude(params) + PROBE_PY, 3_600_000), "OH_PROBE");
        const n = p0.end - p0.start + 1;
        const budget = budget_minutes * 60;
        const est = p0.sec * n;
        const lines = [
          `Probe (${p0.engine}${p0.samples ? `, ${p0.samples} samples` : ""}, ${Math.round((p0.res[0] * p0.pct) / 100)}x${Math.round((p0.res[1] * p0.pct) / 100)} = ${p0.pct}%${p0.volume ? ", volumes" : ""}): ${p0.sec}s/frame${p0.times.length > 1 ? ` (first frame ${p0.times[0]}s incl. warm-up)` : ""}.`,
          `Frames ${p0.start}-${p0.end} (${n}) -> estimated ${mins(est)} vs budget ${mins(budget)}.`,
        ];
        const name = slug(basename(file ?? "live", ".blend"));
        const copy = join(process.cwd(), "takes", `${name}-budget.blend`);
        if (est <= budget * 0.9) {
          lines.push(`Fits with ${Math.round(100 - (100 * est) / budget)}% margin: no changes needed. Render with blender_render animation=true frames_dir=takes/${name}-frames interleaved=true.`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }
        const need = est / (budget * 0.9);
        const plan = planSettings(p0, need);
        lines.push(`Over budget: needs ~${need.toFixed(1)}x faster (aiming at 90% of the budget). Proposed, least visible loss first:`, ...plan.steps.map((s) => `- ${s}`));
        if (!plan.steps.length) {
          lines.push("- nothing left to degrade automatically: shorten the shot, lower fps, render fewer frames and interpolate, or render on a faster machine.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }
        mkdirSync(join(process.cwd(), "takes"), { recursive: true });
        // Measure, don't guess: re-probe with the plan; if fixed per-frame costs ate the gain, step further down (max 3 rounds).
        let settings = plan.st;
        let p1 = p0;
        let planned = plan.factor;
        for (let round = 1; round <= 3; round++) {
          p1 = marker<ProbeInfo>(await blender(src, prelude({ ...params, settings, save: apply ? copy : undefined }) + PROBE_PY, 3_600_000), "OH_PROBE");
          lines.push(`Re-probe ${round}: ${p1.sec}s/frame (${(p0.sec / Math.max(0.01, p1.sec)).toFixed(1)}x faster) -> ${mins(p1.sec * n)} for ${n} frames.`);
          const left = (p1.sec * n) / (budget * 0.9);
          if (left <= 1 || round === 3) break;
          // Samples stop paying off when fixed per-frame costs (sync, denoise, I/O) dominate: then go for pixels/engine.
          const saturated = p0.sec / Math.max(0.01, p1.sec) < 0.6 * planned;
          const more = planSettings(p1, left, saturated);
          planned *= more.factor;
          const fresh = Object.keys(more.st).filter((k) => JSON.stringify(more.st[k]) !== JSON.stringify(settings[k]));
          if (!fresh.length) break;
          settings = { ...settings, ...more.st };
          lines.push(`Still over (fixed per-frame costs don't scale with samples); next step:`, ...more.steps.map((s) => `- ${s}`));
        }
        const est1 = p1.sec * n;
        lines.push(
          "",
          `Result: ${mins(est1)} for ${n} frames vs budget ${mins(budget)}: ${est1 <= budget ? "FITS" : "still OVER budget: shorten the shot, render on 2s (every other frame) and interpolate, deliver a smaller size, or ask for a longer budget"}.`,
          apply ? `Saved the degraded settings to ${rel(p1.saved ?? copy)} (source untouched). Look at a still from it before the full run.` : "Not applied: call again with apply=true to save these settings into a copy.",
          `Render: blender_render file=${apply ? rel(copy) : "<copy>"} animation=true frames_dir=takes/${name}-frames interleaved=true max_minutes=<slice>; re-run the same call to resume. Interleaved order gives every 8th frame first, so review motion/timing early and stop if something is wrong.`,
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return fail(`blender_render_budget failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 5000));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
}

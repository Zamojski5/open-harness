// Free CC0 assets from Poly Haven (HDRIs, PBR textures, models): search, download into the
// project and apply them in the live Blender session through the bridge.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { request } from "../blender/client.ts";

const run = promisify(execFile);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const API = "https://api.polyhaven.com";
// Poly Haven asks API users to identify themselves with a descriptive User-Agent.
const USER_AGENT = "OpenHerness/0.1 (creative-mcp asset tools; https://github.com/pingdotgg/t3code)";
const TYPES = ["hdris", "textures", "models"] as const;
type AssetType = (typeof TYPES)[number];
const TYPE_BY_CODE: Record<number, AssetType> = { 0: "hdris", 1: "textures", 2: "models" };

interface AssetInfo {
  type: number;
  name: string;
  categories?: string[];
  tags?: string[];
  authors?: Record<string, string>;
  download_count?: number;
  max_resolution?: number[];
  dimensions?: number[];
  thumbnail_url?: string;
  description?: string;
}

interface RemoteFile {
  url: string;
  size?: number;
  md5?: string;
  include?: Record<string, RemoteFile>;
}

/** Saved next to the files so the apply tools know what was downloaded. */
interface Manifest {
  id: string;
  name: string;
  type: AssetType;
  resolution: string;
  license: "CC0";
  source: string;
  authors: string[];
  files: string[];
  hdri?: string;
  maps?: Record<string, string>;
  model?: string;
  dimensions_mm?: number[];
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Poly Haven API ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchTo(url: string, dest: string, timeoutMs = 600_000) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const assetDir = (id: string) => resolve(process.cwd(), "assets", "polyhaven", id);
const safeId = (id: string) => /^[A-Za-z0-9_.-]+$/.test(id) && !id.includes("..");

/** A relative path from the API, kept inside the asset folder. */
function inside(dir: string, rel: string) {
  const target = normalize(join(dir, rel));
  if (!target.startsWith(dir + sep)) throw new Error(`Refusing unsafe path from API: ${rel}`);
  return target;
}

function readManifest(id: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(assetDir(id), "asset.json"), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/** Which Principled input a texture map feeds, from its Poly Haven map name. */
function mapRole(key: string): string | undefined {
  const k = key.toLowerCase();
  if (k === "nor_dx" || k === "blend" || k === "gltf" || k === "mtlx" || k === "usd" || k === "fbx") return undefined;
  if (k === "nor_gl" || k.endsWith("_nor_gl")) return "normal";
  if (k === "arm" || k.endsWith("_arm")) return "arm";
  if (k === "ao" || k.endsWith("_ao")) return "ao";
  if (k.startsWith("disp") || k.endsWith("_disp") || k.endsWith("displacement")) return "displacement";
  if (k.startsWith("rough") || k.endsWith("_rough") || k.endsWith("_roughness")) return "roughness";
  if (k.startsWith("metal") || k.endsWith("_metal") || k.endsWith("_metallic")) return "metallic";
  if (k === "diffuse" || k === "diff" || k === "albedo" || k === "col" || k.endsWith("_diff") || k.endsWith("_diffuse")) return "base_color";
  if (k.startsWith("alpha") || k.startsWith("opacity") || k === "mask") return "alpha";
  if (k.startsWith("emiss") || k === "emission") return "emission";
  if (k.startsWith("trans")) return "transmission";
  return undefined;
}

async function download(id: string, resolution: string, format: string | undefined): Promise<Manifest> {
  if (!safeId(id)) throw new Error(`Invalid asset id: ${id}`);
  const info = await api<AssetInfo>(`/info/${encodeURIComponent(id)}`);
  const type = TYPE_BY_CODE[info.type];
  if (!type) throw new Error(`Unknown asset type ${info.type} for ${id}`);
  const files = await api<Record<string, Record<string, Record<string, RemoteFile>>>>(`/files/${encodeURIComponent(id)}`);
  const dir = assetDir(id);
  mkdirSync(dir, { recursive: true });
  const jobs: { url: string; dest: string }[] = [];
  const pick = <T>(byRes: Record<string, T> | undefined) => {
    if (!byRes) return undefined;
    if (byRes[resolution]) return { res: resolution, value: byRes[resolution]! };
    // Nearest smaller resolution, else the smallest available.
    const order = ["16k", "8k", "4k", "2k", "1k"].filter((r) => byRes[r]);
    const lower = order.filter((r) => Number.parseInt(r) <= Number.parseInt(resolution));
    const res = lower[0] ?? order[order.length - 1];
    return res ? { res, value: byRes[res]! } : undefined;
  };
  const manifest: Manifest = {
    id,
    name: info.name,
    type,
    resolution,
    license: "CC0",
    source: `https://polyhaven.com/a/${id}`,
    authors: Object.keys(info.authors ?? {}),
    files: [],
  };
  if (type === "hdris") {
    const fmt = format === "exr" ? "exr" : "hdr";
    const chosen = pick(files.hdri as Record<string, Record<string, RemoteFile>>);
    const file = chosen?.value[fmt] ?? chosen?.value.hdr ?? chosen?.value.exr;
    if (!chosen || !file) throw new Error(`No HDRI file for ${id}`);
    manifest.resolution = chosen.res;
    const dest = inside(dir, decodeURIComponent(file.url.split("/").pop()!));
    jobs.push({ url: file.url, dest });
    manifest.hdri = dest;
  } else if (type === "textures") {
    const fmt = format === "png" ? "png" : "jpg";
    manifest.maps = {};
    for (const [key, byRes] of Object.entries(files)) {
      const role = mapRole(key);
      if (!role || manifest.maps[role]) continue;
      const chosen = pick(byRes);
      if (!chosen) continue;
      // 8-bit jpg displacement bands visibly; use the 16-bit png when there is one.
      const variants = chosen.value as Record<string, RemoteFile>;
      const file = role === "displacement" ? (variants.png ?? variants[fmt] ?? variants.jpg) : (variants[fmt] ?? variants.jpg ?? variants.png);
      if (!file?.url) continue;
      manifest.resolution = chosen.res;
      const dest = inside(dir, decodeURIComponent(file.url.split("/").pop()!));
      jobs.push({ url: file.url, dest });
      manifest.maps[role] = dest;
    }
    if (Object.keys(manifest.maps).length === 0) throw new Error(`No texture maps found for ${id}`);
  } else {
    const fmt = format === "gltf" ? "gltf" : "blend";
    const chosen = pick(files[fmt]);
    const main = chosen?.value[fmt];
    if (!chosen || !main) throw new Error(`No ${fmt} file for ${id}`);
    manifest.resolution = chosen.res;
    const dest = inside(dir, decodeURIComponent(main.url.split("/").pop()!));
    jobs.push({ url: main.url, dest });
    for (const [rel, inc] of Object.entries(main.include ?? {})) jobs.push({ url: inc.url, dest: inside(dir, rel) });
    manifest.model = dest;
    if (info.dimensions) manifest.dimensions_mm = info.dimensions;
  }
  // A few files at a time; skip ones already on disk.
  const queue = jobs.filter((j) => !existsSync(j.dest));
  const workers = Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await fetchTo(job.url, job.dest);
  });
  await Promise.all(workers);
  manifest.files = jobs.map((j) => j.dest);
  writeFileSync(join(dir, "asset.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Use the downloaded copy when its type matches, otherwise download now. */
async function ensure(id: string, want: AssetType, resolution = "2k", format?: string): Promise<Manifest> {
  const have = readManifest(id);
  const fits = have && have.type === want && (!format || (want === "models" ? have.model?.endsWith(`.${format}`) : true));
  const manifest = fits ? have : await download(id, resolution, format);
  if (manifest.type !== want) throw new Error(`${id} is a ${manifest.type.slice(0, -1)}, not a ${want.slice(0, -1)}.`);
  return manifest;
}

async function contactSheet(urls: string[]): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "oh-ph-"));
  try {
    const cells: string[] = [];
    await Promise.all(
      urls.map(async (url, i) => {
        const src = join(dir, `t${i}`);
        const cell = join(dir, `c${String(i).padStart(3, "0")}.png`);
        try {
          await fetchTo(url, src, 20_000);
          await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", "scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=0x1c1c1c", "-frames:v", "1", cell]);
          cells[i] = cell;
        } catch {
          // a missing thumbnail just leaves a gap
        }
      }),
    );
    // Fill gaps with blank cells so positions match the numbered list.
    let any = false;
    for (let i = 0; i < urls.length; i++) {
      if (cells[i]) any = true;
      else await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x1c1c1c:s=256x256", "-frames:v", "1", join(dir, `c${String(i).padStart(3, "0")}.png`)]);
    }
    if (!any) return undefined;
    const cols = Math.min(6, urls.length);
    const sheet = join(dir, "sheet.jpg");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", join(dir, "c%03d.png"), "-vf", `tile=${cols}x${Math.ceil(urls.length / cols)}:padding=4:color=0x000000`, "-frames:v", "1", "-q:v", "4", sheet]);
    return readFileSync(sheet).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Python run in the live Blender session (parameters arrive as a JSON string literal) ----

const py = (params: unknown, body: string) => `import json, math, os\nimport bpy, mathutils\nP = json.loads(${JSON.stringify(JSON.stringify(params))})\n${body}`;

const HDRI_PY = `
scene = bpy.context.scene
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
if world.node_tree is None:
    world.use_nodes = True  # Blender 4.x; 5.x worlds always have nodes
nt = world.node_tree
nt.nodes.clear()
coord = nt.nodes.new("ShaderNodeTexCoord"); coord.location = (-1000, 0)
mapping = nt.nodes.new("ShaderNodeMapping"); mapping.location = (-800, 0)
mapping.inputs["Rotation"].default_value[2] = math.radians(P["rotation"])
env = nt.nodes.new("ShaderNodeTexEnvironment"); env.location = (-560, 0)
env.image = bpy.data.images.load(P["path"], check_existing=True)
bg = nt.nodes.new("ShaderNodeBackground"); bg.location = (-240, 60)
bg.inputs["Strength"].default_value = P["strength"]
out = nt.nodes.new("ShaderNodeOutputWorld"); out.location = (300, 0)
nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
nt.links.new(env.outputs["Color"], bg.inputs["Color"])
if P["show_background"]:
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
else:
    # Lights the scene with the HDRI but the camera sees a plain colour.
    plain = nt.nodes.new("ShaderNodeBackground"); plain.location = (-240, -140)
    plain.inputs["Color"].default_value = (*P["background_color"], 1.0)
    path = nt.nodes.new("ShaderNodeLightPath"); path.location = (-240, 300)
    mix = nt.nodes.new("ShaderNodeMixShader"); mix.location = (60, 0)
    nt.links.new(path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(bg.outputs["Background"], mix.inputs[1])
    nt.links.new(plain.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
world.name = "HDRI " + P["id"]
result = {"world": world.name, "image": env.image.name, "size": list(env.image.size), "strength": P["strength"], "rotation_deg": P["rotation"]}
`;

const MATERIAL_PY = `
obj = bpy.data.objects.get(P["object"])
if obj is None:
    raise ValueError("No object named %r. Objects: %s" % (P["object"], ", ".join(o.name for o in bpy.data.objects)[:800]))
if not hasattr(obj.data, "materials"):
    raise ValueError("%s (%s) cannot hold materials" % (obj.name, obj.type))
maps = P["maps"]
mat = bpy.data.materials.new(P["material"])
if mat.node_tree is None:
    mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
out = nt.nodes.new("ShaderNodeOutputMaterial"); out.location = (500, 0)
bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled"); bsdf.location = (100, 0)
nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
has_uv = obj.type == "MESH" and len(obj.data.uv_layers) > 0
projection = P["projection"] if P["projection"] != "auto" else ("uv" if has_uv else "box")
coord = nt.nodes.new("ShaderNodeTexCoord"); coord.location = (-1300, 0)
mapping = nt.nodes.new("ShaderNodeMapping"); mapping.location = (-1100, 0)
mapping.inputs["Scale"].default_value = (P["scale"], P["scale"], P["scale"])
mapping.inputs["Rotation"].default_value[2] = math.radians(P["rotation"])
nt.links.new(coord.outputs["UV" if projection == "uv" else "Object"], mapping.inputs["Vector"])
y = [400]
def tex(role, color):
    node = nt.nodes.new("ShaderNodeTexImage")
    node.location = (-800, y[0]); y[0] -= 300
    node.image = bpy.data.images.load(maps[role], check_existing=True)
    if not color:
        node.image.colorspace_settings.name = "Non-Color"
    if projection == "box":
        node.projection = "BOX"; node.projection_blend = 0.2
    nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
    node.label = role
    return node
used = []
color_out = None
if "base_color" in maps:
    color_out = tex("base_color", True).outputs["Color"]; used.append("base_color")
ao_out = None
rough_out = None
metal_out = None
if "arm" in maps:
    arm = tex("arm", False)
    sep_node = nt.nodes.new("ShaderNodeSeparateColor"); sep_node.location = (-450, y[0] + 300)
    nt.links.new(arm.outputs["Color"], sep_node.inputs["Color"])
    ao_out, rough_out, metal_out = sep_node.outputs[0], sep_node.outputs[1], sep_node.outputs[2]
    used.append("arm")
if "roughness" in maps:
    rough_out = tex("roughness", False).outputs["Color"]; used.append("roughness")
if "metallic" in maps:
    metal_out = tex("metallic", False).outputs["Color"]; used.append("metallic")
if "ao" in maps and ao_out is None:
    ao_out = tex("ao", False).outputs["Color"]; used.append("ao")
if color_out is not None and ao_out is not None and P["ao_strength"] > 0:
    # Principled has no AO input: multiply it into the base colour, gently.
    mix = nt.nodes.new("ShaderNodeMix"); mix.location = (-250, 400)
    mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = P["ao_strength"]
    nt.links.new(color_out, mix.inputs[6]); nt.links.new(ao_out, mix.inputs[7])
    color_out = mix.outputs[2]
if color_out is not None:
    nt.links.new(color_out, bsdf.inputs["Base Color"])
if rough_out is not None:
    nt.links.new(rough_out, bsdf.inputs["Roughness"])
if metal_out is not None:
    nt.links.new(metal_out, bsdf.inputs["Metallic"])
if "alpha" in maps:
    nt.links.new(tex("alpha", False).outputs["Color"], bsdf.inputs["Alpha"]); used.append("alpha")
if "normal" in maps:
    nmap = nt.nodes.new("ShaderNodeNormalMap"); nmap.location = (-250, -400)
    nmap.inputs["Strength"].default_value = P["normal_strength"]
    nt.links.new(tex("normal", False).outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    used.append("normal")
if "displacement" in maps and P["displacement"] > 0:
    disp = nt.nodes.new("ShaderNodeDisplacement"); disp.location = (100, -500)
    disp.inputs["Scale"].default_value = P["displacement"]
    disp.inputs["Midlevel"].default_value = 0.5
    nt.links.new(tex("displacement", False).outputs["Color"], disp.inputs["Height"])
    nt.links.new(disp.outputs["Displacement"], out.inputs["Displacement"])
    try:
        mat.displacement_method = "BOTH"
    except Exception:
        try:
            mat.cycles.displacement_method = "BOTH"
        except Exception:
            pass
    used.append("displacement")
slots = obj.data.materials
if len(slots) == 0:
    slots.append(mat)
elif P["all_slots"]:
    for i in range(len(slots)):
        slots[i] = mat
else:
    slots[obj.active_material_index] = mat
result = {"material": mat.name, "object": obj.name, "maps": used, "projection": projection, "scale": P["scale"]}
`;

const MODEL_PY = `
before = set(bpy.data.objects)
path = P["path"]
if path.endswith(".blend"):
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = list(src.objects)
    new = [o for o in dst.objects if o is not None]
else:
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
coll = bpy.data.collections.new(P["collection"])
bpy.context.scene.collection.children.link(coll)
for o in new:
    for c in list(o.users_collection):
        c.objects.unlink(o)
    coll.objects.link(o)
# Appended images may keep paths relative to the library file; point them at our copy.
folder = os.path.dirname(path)
for img in bpy.data.images:
    if img.source == "FILE" and img.filepath and not os.path.exists(bpy.path.abspath(img.filepath)):
        for cand in (os.path.join(folder, "textures", os.path.basename(img.filepath)), os.path.join(folder, os.path.basename(img.filepath))):
            if os.path.exists(cand):
                img.filepath = cand; img.reload(); break
roots = [o for o in new if o.parent is None]
# One empty to move/scale/rotate the whole asset, whatever its parts' origins are.
handle = bpy.data.objects.new(P["collection"] + " root", None)
handle.empty_display_type = "PLAIN_AXES"
coll.objects.link(handle)
for o in roots:
    o.parent = handle
handle.location = P["location"]
handle.scale = (P["scale"], P["scale"], P["scale"])
handle.rotation_euler[2] = math.radians(P["rotation"])
bpy.context.view_layer.update()
missing = sorted({img.filepath for img in bpy.data.images if img.source == "FILE" and img.filepath and not os.path.exists(bpy.path.abspath(img.filepath))})
corners = [o.matrix_world @ mathutils.Vector(b) for o in new if o.type == "MESH" for b in o.bound_box]
lo = [min(c[i] for c in corners) for i in range(3)] if corners else None
hi = [max(c[i] for c in corners) for i in range(3)] if corners else None
result = {"handle": handle.name, "collection": coll.name, "objects": [o.name for o in new][:60], "size_m": [round(hi[i] - lo[i], 3) for i in range(3)] if lo else None, "bbox_min": [round(v, 3) for v in lo] if lo else None, "missing_textures": missing[:20]}
`;

async function live(code: string) {
  const reply = await request<{ output: string; result: unknown }>({ cmd: "exec", code }, 300_000);
  if (!reply.ok) throw new Error(`${reply.error}\n${reply.traceback ?? ""}`);
  return reply.data!.result;
}

const hexColor = (hex: string) => {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  // sRGB hex to the linear values Blender stores.
  return m ? m.slice(1, 4).map((h) => ((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))(Number.parseInt(h, 16) / 255)) : [0.05, 0.05, 0.05];
};

const resolutionSchema = z.enum(["1k", "2k", "4k", "8k"]).optional().describe("Default 2k. 1k for previews/background props, 4k for hero close-ups, 8k rarely.");

export function registerAssetTools(server: McpServer) {
  server.registerTool(
    "asset_search",
    {
      description:
        "Search Poly Haven's free CC0 library (no attribution needed): HDRIs (world lighting), PBR textures (materials) and models. Returns ids, names, categories and a numbered thumbnail contact sheet. Filter by categories (e.g. hdris: outdoor, indoor, studio, night, sunrise-sunset, overcast; textures: wood, brick, rock, floor, metal, fabric; models: furniture, props, nature) and/or free-text query matched against names and tags. Without query or categories it lists the available categories.",
      inputSchema: {
        type: z.enum(TYPES),
        query: z.string().optional().describe("Words matched against id, name, tags and categories, e.g. 'forest night', 'oak planks', 'rusty barrel'"),
        categories: z.array(z.string()).optional().describe("Poly Haven categories, all must match"),
        count: z.number().int().min(1).max(36).optional().describe("Default 12"),
      },
    },
    async ({ type, query, categories, count = 12 }) => {
      try {
        if (!query && !categories?.length) {
          const cats = await api<Record<string, number>>(`/categories/${type}`);
          return text(`Poly Haven ${type} categories (count): ${Object.entries(cats).map(([c, n]) => `${c} (${n})`).join(", ")}`);
        }
        const c = categories?.length ? `&c=${encodeURIComponent(categories.join(","))}` : "";
        const all = await api<Record<string, AssetInfo>>(`/assets?t=${type}${c}`);
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const scored = Object.entries(all)
          .map(([id, a]) => {
            const hay = [id, a.name, ...(a.tags ?? []), ...(a.categories ?? [])].join(" ").toLowerCase();
            const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
            return { id, a, score };
          })
          .filter((x) => words.length === 0 || x.score > 0)
          .sort((x, y) => y.score - x.score || (y.a.download_count ?? 0) - (x.a.download_count ?? 0))
          .slice(0, count);
        if (scored.length === 0) {
          const cats = await api<Record<string, number>>(`/categories/${type}`);
          return text(`Nothing found. Try fewer or other words, or these categories: ${Object.keys(cats).join(", ")}`);
        }
        const lines = scored.map(({ id, a }, i) => {
          const size = a.dimensions ? ` ~${a.dimensions.map((d) => (d / 1000).toFixed(2)).join("x")} m` : "";
          const res = a.max_resolution ? ` max ${a.max_resolution[0]}px` : "";
          return `${i + 1}. ${id} — ${a.name} [${(a.categories ?? []).slice(0, 6).join(", ")}]${size}${res}${a.tags?.length ? ` tags: ${a.tags.slice(0, 6).join(", ")}` : ""}`;
        });
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: `${scored.length} Poly Haven ${type} (CC0):\n${lines.join("\n")}\n\nContact sheet: numbered left to right, top to bottom. Next: asset_download id, or the asset_apply_* tools (they download on demand).` },
        ];
        // Thumbnails as small pngs (the default webp is fine for ffmpeg too, png is safer).
        const thumbs = scored.map(({ a }) => (a.thumbnail_url ?? "").replace("format=webp", "format=png")).filter(Boolean);
        if (thumbs.length === scored.length) {
          const sheet = await contactSheet(thumbs).catch(() => undefined);
          if (sheet) content.push({ type: "image", data: sheet, mimeType: "image/jpeg" });
        }
        return { content };
      } catch (error) {
        return fail(`Poly Haven search failed: ${message(error)}`);
      }
    },
  );

  server.registerTool(
    "asset_download",
    {
      description:
        "Download a Poly Haven asset (CC0) into ./assets/polyhaven/<id>/ and return the file paths. HDRIs: .hdr (default) or .exr. Textures: every PBR map (diffuse, roughness, OpenGL normal, ARM/AO, displacement as 16-bit png, metal/alpha when present) as jpg (default) or png. Models: .blend (default, materials intact) or .gltf, with their textures. Writes asset.json (maps by role, license) that the asset_apply_* tools read.",
      inputSchema: {
        id: z.string().describe("Asset id from asset_search, e.g. 'brick_wall_001'"),
        resolution: resolutionSchema,
        format: z.enum(["hdr", "exr", "jpg", "png", "blend", "gltf"]).optional(),
      },
    },
    async ({ id, resolution = "2k", format }) => {
      try {
        const m = await download(id, resolution, format);
        const roles = m.maps ? `\nMaps: ${Object.entries(m.maps).map(([r, p]) => `${r}=${p}`).join("\n  ")}` : "";
        return text(`${m.name} (${m.type}, ${m.resolution}, CC0 by ${m.authors.join(", ") || "Poly Haven"}) in ${assetDir(id)}${m.hdri ? `\nHDRI: ${m.hdri}` : ""}${m.model ? `\nModel: ${m.model}` : ""}${roles}\nFiles (${m.files.length}):\n${m.files.join("\n")}`);
      } catch (error) {
        return fail(`Download failed: ${message(error)}`);
      }
    },
  );

  server.registerTool(
    "asset_apply_hdri",
    {
      description:
        "Light the live Blender scene with a Poly Haven HDRI (downloads it if needed): builds the world nodes (Environment Texture with Mapping rotation, Background strength). show_background=false keeps the HDRI lighting and reflections but shows a plain colour to the camera. Rotate to move the sun/key direction; strength 0.3-0.6 for moody shots with your own lights, 1 for natural.",
      inputSchema: {
        id: z.string(),
        strength: z.number().min(0).max(50).optional().describe("Default 1"),
        rotation: z.number().optional().describe("Z rotation in degrees, default 0"),
        show_background: z.boolean().optional().describe("Default true"),
        background_color: z.string().optional().describe("Hex colour seen by the camera when show_background=false, default #0d0d0d"),
        resolution: resolutionSchema,
      },
    },
    async ({ id, strength = 1, rotation = 0, show_background = true, background_color = "#0d0d0d", resolution }) => {
      try {
        const m = await ensure(id, "hdris", resolution);
        const result = await live(py({ id, path: m.hdri, strength, rotation, show_background, background_color: hexColor(background_color) }, HDRI_PY));
        return text(`World lit by ${m.name}: ${JSON.stringify(result)}. Check with blender_screenshot shading=rendered.`);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "asset_apply_material",
    {
      description:
        "Build a full PBR material from a Poly Haven texture (downloads it if needed) and assign it to a named object in the live scene: base colour (sRGB), roughness/metallic/AO (Non-Color, ARM split with Separate Color, AO multiplied into colour), OpenGL normal through a Normal Map node, optional displacement (true displacement in Cycles needs a subdivided mesh; EEVEE shows it as bump). Uses UVs when the mesh has them, otherwise box projection in object space. scale = texture repeats per UV unit / per metre on box projection.",
      inputSchema: {
        id: z.string().describe("Texture id, e.g. 'wood_floor_deck'"),
        object: z.string().describe("Object name in the live scene"),
        scale: z.number().positive().optional().describe("Tiling, default 1. Real-world size: a texture covering ~2 m on a 10 m floor with UVs 0-1 needs scale 5"),
        rotation: z.number().optional().describe("Texture rotation in degrees"),
        projection: z.enum(["auto", "uv", "box"]).optional(),
        normal_strength: z.number().min(0).max(5).optional().describe("Default 1"),
        ao_strength: z.number().min(0).max(1).optional().describe("How much AO darkens the colour, default 0.5; 0 to skip"),
        displacement: z.number().min(0).max(2).optional().describe("Displacement scale in metres, default 0 (off). Typical 0.02-0.1"),
        all_slots: z.boolean().optional().describe("Replace every material slot (default: only the active slot, or add one)"),
        material_name: z.string().optional(),
        resolution: resolutionSchema,
      },
    },
    async (o) => {
      try {
        const m = await ensure(o.id, "textures", o.resolution);
        const result = await live(
          py(
            {
              object: o.object,
              material: o.material_name ?? m.name,
              maps: m.maps ?? {},
              scale: o.scale ?? 1,
              rotation: o.rotation ?? 0,
              projection: o.projection ?? "auto",
              normal_strength: o.normal_strength ?? 1,
              ao_strength: o.ao_strength ?? 0.5,
              displacement: o.displacement ?? 0,
              all_slots: o.all_slots ?? false,
            },
            MATERIAL_PY,
          ),
        );
        return text(`Material applied: ${JSON.stringify(result)}. Check with blender_screenshot (material).`);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    "asset_import_model",
    {
      description:
        "Bring a Poly Haven model (downloads it if needed) into the live scene: appends the objects from the .blend (or imports the .gltf) into a new collection named after the asset, parents its root objects to an empty (the returned handle) placed at location with scale/rotation; move the asset later through that empty. Poly Haven models are real-world size in metres; check the returned dimensions before scaling.",
      inputSchema: {
        id: z.string().describe("Model id, e.g. 'Barrel_01'"),
        location: z.array(z.number()).length(3).optional().describe("[x, y, z] offset in metres, default origin"),
        scale: z.number().positive().optional().describe("Uniform scale, default 1"),
        rotation: z.number().optional().describe("Z rotation in degrees"),
        format: z.enum(["blend", "gltf"]).optional().describe("Default blend"),
        collection: z.string().optional(),
        resolution: resolutionSchema,
      },
    },
    async ({ id, location = [0, 0, 0], scale = 1, rotation = 0, format = "blend", collection, resolution }) => {
      try {
        const m = await ensure(id, "models", resolution, format);
        const result = await live(py({ path: m.model, location, scale, rotation, collection: collection ?? m.name }, MODEL_PY));
        return text(`Imported ${m.name}: ${JSON.stringify(result)}`);
      } catch (error) {
        return fail(message(error));
      }
    },
  );
}

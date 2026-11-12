// Blender tools for agents: live session (bridge) + background rendering/scripting.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { drawText, grid, readImage, writeJpeg } from "../quality/raster.ts";
import { blenderBinary, isRunning, launch, request } from "./client.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export function slug(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "render"
  );
}

/** <cwd>/takes/<slug>-take-NN.<ext> with the next free take number. */
export function takePath(title: string, ext: string) {
  const dir = NodePath.join(process.cwd(), "takes");
  NodeFS.mkdirSync(dir, { recursive: true });
  const base = `blender-${slug(title)}`;
  const re = new RegExp(`^${base}-take-(\\d+)`);
  const max = NodeFS.readdirSync(dir).reduce(
    (m, f) => Math.max(m, Number(f.match(re)?.[1] ?? 0)),
    0,
  );
  return NodePath.join(dir, `${base}-take-${String(max + 1).padStart(2, "0")}${ext}`);
}

const ENGINES = {
  eevee: "BLENDER_EEVEE",
  cycles: "CYCLES",
  workbench: "BLENDER_WORKBENCH",
} as const;

function renderScript(o: {
  engine?: keyof typeof ENGINES;
  samples?: number;
  width?: number;
  height?: number;
  percentage?: number;
  output: string;
  frame?: number;
  start?: number;
  end?: number;
  animation: boolean;
  transparent?: boolean;
  /** clay: grey Workbench previs; depth: near-white/far-black depth guide (for depth-conditioned video models). */
  pass?: "beauty" | "clay" | "depth";
  near?: number;
  far?: number;
  /** Per-frame loop instead of animation=True: interleaved order, skip existing frames, stop after maxSeconds. */
  perFrame?: { interleaved: boolean; maxSeconds: number };
}) {
  const lines = [
    "import bpy",
    "s = bpy.context.scene",
    "r = s.render",
    o.engine ? `r.engine = ${JSON.stringify(ENGINES[o.engine])}` : "",
    o.samples && o.engine === "cycles" ? `s.cycles.samples = ${o.samples}` : "",
    o.samples && o.engine === "eevee" ? `s.eevee.taa_render_samples = ${o.samples}` : "",
    o.engine === "cycles"
      ? "s.cycles.device = 'GPU'\ntry:\n    bpy.context.preferences.addons['cycles'].preferences.compute_device_type = 'METAL'\nexcept Exception:\n    pass"
      : "",
    o.width ? `r.resolution_x = ${o.width}` : "",
    o.height ? `r.resolution_y = ${o.height}` : "",
    o.percentage ? `r.resolution_percentage = ${o.percentage}` : "",
    o.transparent ? "r.film_transparent = True" : "",
    o.pass === "clay" ? CLAY_PASS : "",
    o.pass === "depth" ? depthPass(o.near ?? 0.5, o.far ?? 50) : "",
    "r.image_settings.file_format = 'PNG'",
    `r.filepath = ${JSON.stringify(o.output)}`,
    o.start !== undefined ? `s.frame_start = ${o.start}` : "",
    o.end !== undefined ? `s.frame_end = ${o.end}` : "",
    o.animation && o.perFrame
      ? perFrameLoop(o.output, o.perFrame.interleaved, o.perFrame.maxSeconds)
      : o.animation
        ? "bpy.ops.render.render(animation=True)"
        : `s.frame_set(${o.frame ?? "s.frame_current"})\nbpy.ops.render.render(write_still=True)`,
    "print('OH_RENDER_FPS', r.fps)",
  ];
  return lines.filter(Boolean).join("\n");
}

// Grey clay previs: Workbench studio light, one neutral colour, cavity and shadows for form.
const CLAY_PASS = `r.engine = 'BLENDER_WORKBENCH'
sh = s.display.shading
sh.light = 'STUDIO'
sh.color_type = 'SINGLE'
sh.single_color = (0.62, 0.62, 0.62)
sh.show_cavity = True
sh.show_shadows = True
s.view_settings.view_transform = 'Standard'`;

// Depth guide: every material replaced by an emission of camera-space depth mapped near→white,
// far→black, rendered in EEVEE with one sample and a black world.
function depthPass(near: number, far: number) {
  return `r.engine = ${JSON.stringify(ENGINES.eevee)}
s.eevee.taa_render_samples = 1
s.view_settings.view_transform = 'Standard'
s.view_settings.look = 'None'
mat = bpy.data.materials.get('OH_Depth') or bpy.data.materials.new('OH_Depth')
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
cam = nt.nodes.new('ShaderNodeCameraData')
mr = nt.nodes.new('ShaderNodeMapRange')
mr.clamp = True
mr.inputs['From Min'].default_value = ${near}
mr.inputs['From Max'].default_value = ${far}
mr.inputs['To Min'].default_value = 1.0
mr.inputs['To Max'].default_value = 0.0
em = nt.nodes.new('ShaderNodeEmission')
out = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(cam.outputs['View Z Depth'], mr.inputs['Value'])
nt.links.new(mr.outputs['Result'], em.inputs['Color'])
nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
bpy.context.view_layer.material_override = mat
w = s.world or bpy.data.worlds.new('OH_Black')
s.world = w
w.use_nodes = True
bg = next((n for n in w.node_tree.nodes if n.type == 'BACKGROUND'), None)
if bg:
    bg.inputs['Color'].default_value = (0, 0, 0, 1)
    bg.inputs['Strength'].default_value = 0
for o in s.objects:
    if o.type == 'LIGHT':
        o.hide_render = True`;
}

export /** Renders frame by frame into <prefix>NNNN.png: every 8th frame first, then 4th, 2nd, rest (early preview); existing frames are skipped (resumable); stops after maxSeconds. */
function perFrameLoop(prefix: string, interleaved: boolean, maxSeconds: number) {
  return `import os, time
if r.engine == 'CYCLES':
    r.use_persistent_data = True
frames = list(range(s.frame_start, s.frame_end + 1))
if ${interleaved ? "True" : "False"}:
    order, seen = [], set()
    for step in (8, 4, 2, 1):
        for f in frames[::step]:
            if f not in seen:
                seen.add(f); order.append(f)
else:
    order = frames
t0 = time.time(); done = skipped = 0; times = []
for f in order:
    path = ${JSON.stringify(prefix)} + str(f).zfill(4) + '.png'
    if os.path.exists(path):
        skipped += 1; continue
    if time.time() - t0 > ${maxSeconds}:
        break
    s.frame_set(f)
    tmp = path[:-4] + '.part.png'
    r.filepath = tmp
    t1 = time.time()
    bpy.ops.render.render(write_still=True)
    times.append(time.time() - t1)
    os.replace(tmp, path)
    done += 1
left = sum(1 for f in frames if not os.path.exists(${JSON.stringify(prefix)} + str(f).zfill(4) + '.png'))
print('OH_FRAMES', done, skipped, left, round(sum(times) / max(1, len(times)), 2))`;
}

export async function headless(file: string | undefined, script: string, timeoutMs = 3_600_000) {
  const bin = blenderBinary();
  if (!bin) throw new Error("Blender is not installed.");
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-blender-"));
  const scriptPath = NodePath.join(dir, "job.py");
  NodeFS.writeFileSync(scriptPath, script);
  try {
    const { stdout, stderr } = await run(
      bin,
      [
        "-b",
        ...(file ? [file] : ["--factory-startup"]),
        "--python-exit-code",
        "1",
        "--python",
        scriptPath,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return `${stdout}\n${stderr}`;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

/** The .blend to render/script in the background: an explicit file, or a snapshot of the live session. */
export async function sourceFile(file?: string) {
  if (file) return NodePath.resolve(process.cwd(), file);
  if (!(await isRunning())) return undefined;
  const snapshot = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-blend-")),
    "live.blend",
  );
  const reply = await request({ cmd: "save", path: snapshot, copy: true });
  if (!reply.ok) throw new Error(reply.error);
  return snapshot;
}

export function registerBlenderTools(server: McpServer) {
  server.registerTool(
    "blender_status",
    {
      description:
        "Is Blender installed, is the live session (bridge) running, and which file is open.",
      inputSchema: {},
    },
    async () => {
      const bin = blenderBinary();
      const live = await isRunning();
      return text(
        JSON.stringify({ installed: !!bin, binary: bin, live: !!live, ...live }, null, 2),
      );
    },
  );

  server.registerTool(
    "blender_launch",
    {
      description:
        "Open Blender's window with the Open Herness bridge so you can drive the live scene the user sees (or reuse the running session). Optionally open a .blend file.",
      inputSchema: {
        file: z.string().optional().describe(".blend path (absolute or relative to the project)"),
      },
    },
    async ({ file }) => {
      try {
        const info = await launch(file ? NodePath.resolve(process.cwd(), file) : undefined);
        return text(
          `Blender ${info.version ?? ""} ${info.reused ? "already running" : "started"}${info.file ? `: ${info.file}` : ": new scene"}. Use blender_scene to inspect it.`,
        );
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error));
      }
    },
  );

  server.registerTool(
    "blender_scene",
    {
      description:
        "Describe the live scene: objects (type, transforms, dimensions, materials, lights, cameras), frame range, render settings, selection.",
      inputSchema: {},
    },
    async () => {
      try {
        const reply = await request({ cmd: "scene" });
        return reply.ok
          ? text(JSON.stringify(reply.data, null, 1).slice(0, 1_000_000))
          : fail(reply.error ?? "failed");
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error));
      }
    },
  );

  server.registerTool(
    "blender_exec",
    {
      description:
        "Run Python (bpy) in the live Blender session; the user sees the changes immediately. `bpy` is imported. print() output is returned; assign `result = …` to return data. Do one logical step per call, then verify with blender_screenshot or blender_scene. Prefer bpy.data / direct API over bpy.ops where possible.",
      inputSchema: { code: z.string() },
    },
    async ({ code }) => {
      try {
        const reply = await request<{ output: string; result: unknown }>({ cmd: "exec", code });
        if (!reply.ok) return fail(`${reply.error}\n${reply.traceback ?? ""}`);
        const { output, result } = reply.data!;
        return text(
          [
            output && `output:\n${output}`,
            result !== null && result !== undefined && `result: ${JSON.stringify(result, null, 1)}`,
          ]
            .filter(Boolean)
            .join("\n") || "ok",
        );
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error));
      }
    },
  );

  server.registerTool(
    "blender_screenshot",
    {
      description:
        "Screenshot of the live 3D viewport to check the scene. shading: material (default, shows materials/colors quickly), rendered (live render preview, slower), solid (geometry only), wireframe.",
      inputSchema: {
        width: z.number().int().min(320).max(2000).optional(),
        shading: z.enum(["material", "rendered", "solid", "wireframe"]).optional(),
      },
    },
    async ({ width, shading }) => {
      try {
        const reply = await request<{ png: string }>({
          cmd: "screenshot",
          width: width ?? 1200,
          shading: (shading ?? "material").toUpperCase(),
        });
        if (!reply.ok) return fail(reply.error ?? "failed");
        return {
          content: [
            { type: "image" as const, data: reply.data!.png, mimeType: "image/png" },
          ] satisfies Content[],
        };
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error));
      }
    },
  );

  server.registerTool(
    "blender_render",
    {
      description:
        "Render a still image or an animation (MP4) in a background Blender process, so the live window stays responsive. Renders the live scene (snapshot) or a given .blend file. Output goes to ./takes/. Use eevee for fast previews, cycles for final quality.",
      inputSchema: {
        title: z.string().describe("Short name for the output file"),
        animation: z.boolean().optional(),
        frame: z.number().int().optional(),
        frame_start: z.number().int().optional(),
        frame_end: z.number().int().optional(),
        engine: z.enum(["eevee", "cycles", "workbench"]).optional(),
        pass: z
          .enum(["beauty", "clay", "depth"])
          .optional()
          .describe(
            "beauty (default); clay = grey Workbench previs for render-to-real / video-to-video; depth = near-white/far-black depth guide for depth-conditioned models (set near/far in metres)",
          ),
        near: z
          .number()
          .positive()
          .optional()
          .describe("depth pass: distance shown white (default 0.5 m)"),
        far: z
          .number()
          .positive()
          .optional()
          .describe("depth pass: distance shown black (default 50 m)"),
        samples: z.number().int().min(1).max(4096).optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        resolution_percentage: z.number().int().min(1).max(100).optional(),
        transparent: z.boolean().optional(),
        file: z.string().optional().describe(".blend to render instead of the live scene"),
        frames_dir: z
          .string()
          .optional()
          .describe(
            "Animation: keep PNG frames in this folder (e.g. takes/shot1-frames) and skip frames already there, so an interrupted or sliced render resumes. The MP4 is made once all frames exist.",
          ),
        interleaved: z
          .boolean()
          .optional()
          .describe(
            "Animation: render every 8th frame first, then every 4th, 2nd, rest, so a coarse preview of the whole shot exists early (use with frames_dir).",
          ),
        max_minutes: z
          .number()
          .positive()
          .optional()
          .describe(
            "Animation with frames_dir: stop after this many minutes and report progress; call again to continue.",
          ),
      },
    },
    async (o) => {
      try {
        const source = await sourceFile(o.file);
        if (!source)
          return fail(
            "Nothing to render: start the live session with blender_launch or pass a .blend file.",
          );
        if (!o.animation) {
          const out = takePath(o.title, ".png");
          await headless(
            source,
            renderScript({
              engine: o.engine,
              samples: o.samples,
              width: o.width,
              height: o.height,
              percentage: o.resolution_percentage,
              output: out,
              frame: o.frame,
              animation: false,
              transparent: o.transparent,
              pass: o.pass,
              near: o.near,
              far: o.far,
            }),
          );
          const data = NodeFS.readFileSync(out).toString("base64");
          return {
            content: [
              { type: "text" as const, text: `Saved ${out}` },
              { type: "image" as const, data, mimeType: "image/png" },
            ] satisfies Content[],
          };
        }
        const keep = o.frames_dir ? NodePath.resolve(process.cwd(), o.frames_dir) : undefined;
        const frames = keep ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-frames-"));
        if (keep) NodeFS.mkdirSync(keep, { recursive: true });
        const perFrame =
          keep || o.interleaved
            ? { interleaved: !!o.interleaved, maxSeconds: Math.round((o.max_minutes ?? 50) * 60) }
            : undefined;
        const log = await headless(
          source,
          renderScript({
            engine: o.engine,
            samples: o.samples,
            width: o.width,
            height: o.height,
            percentage: o.resolution_percentage,
            output: NodePath.join(frames, "f_"),
            start: o.frame_start,
            end: o.frame_end,
            animation: true,
            perFrame,
            pass: o.pass,
            near: o.near,
            far: o.far,
          }),
          perFrame ? (perFrame.maxSeconds + 900) * 1000 : undefined,
        );
        const progress = log.match(/OH_FRAMES (\d+) (\d+) (\d+) ([\d.]+)/);
        if (progress && Number(progress[3]) > 0) {
          const [, done, skipped, left, sec] = progress.map(Number);
          const have = NodeFS.readdirSync(frames)
            .filter((f) => /^f_\d+\.png$/.test(f))
            .sort();
          const pick = have
            .filter((_, i) => i % Math.max(1, Math.ceil(have.length / 8)) === 0)
            .slice(0, 8);
          const content: Content[] = [
            {
              type: "text" as const,
              text: `Partial: rendered ${done} frames this run (${sec}s/frame), ${skipped} were already there, ${left} still to render in ${frames}. Call blender_render again with the same frames_dir to continue${o.interleaved ? "; the frames rendered so far are spread over the whole shot (interleaved), so review motion and look now" : ""}. ETA ~${Math.ceil((left! * sec!) / 60)} min.`,
            },
          ];
          if (pick.length) {
            const cells = await Promise.all(
              pick.map((f) => readImage(NodePath.join(frames, f), 320)),
            );
            cells.forEach((c, i) =>
              drawText(c, 2, 2, pick[i]!.replace(/^f_0*|\.png$/g, ""), [255, 255, 255], 1),
            );
            const data = await writeJpeg(
              grid(cells, 4, 320, cells[0]!.h),
              NodePath.join(frames, "progress.jpg"),
            );
            content.push({ type: "image" as const, data, mimeType: "image/jpeg" });
          }
          return { content };
        }
        const fps = Number(log.match(/OH_RENDER_FPS (\d+)/)?.[1] ?? 24);
        const first = NodeFS.readdirSync(frames)
          .filter((f) => /^f_\d+\.png$/.test(f))
          .sort()[0];
        if (!first) return fail(`No frames were rendered.\n${log.slice(-3000)}`);
        const digits = first.match(/f_(\d+)\.png/)?.[1].length ?? 4;
        const startNum = Number(first.match(/f_(\d+)\.png/)?.[1] ?? 1);
        const out = takePath(o.title, ".mp4");
        await run(
          "ffmpeg",
          [
            "-y",
            "-loglevel",
            "error",
            "-framerate",
            String(fps),
            "-start_number",
            String(startNum),
            "-i",
            NodePath.join(frames, `f_%0${digits}d.png`),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            out,
          ],
          { timeout: 1_800_000 },
        );
        if (!keep) NodeFS.rmSync(frames, { recursive: true, force: true });
        return text(`Saved ${out} (${fps} fps)${keep ? `; frames kept in ${keep}` : ""}`);
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error).slice(0, 6000));
      }
    },
  );

  server.registerTool(
    "blender_script",
    {
      description:
        "Run a Python script in a background Blender (no window): batch edits, conversions, exports (glTF/FBX/OBJ), procedural generation. Optionally on a .blend file; save inside the script if needed.",
      inputSchema: { code: z.string(), file: z.string().optional() },
    },
    async ({ code, file }) => {
      try {
        const log = await headless(
          file ? NodePath.resolve(process.cwd(), file) : undefined,
          `import bpy\n${code}`,
        );
        const lines = log
          .split("\n")
          .filter((l) => !/^(Blender |Read |Color management|Warning: Python)/.test(l));
        return text(lines.join("\n").slice(-1_000_000) || "ok");
      } catch (error) {
        const e = error as { stderr?: string; stdout?: string; message?: string };
        return fail(
          `${e.message ?? error}\n${(e.stdout ?? "").slice(-500_000)}\n${(e.stderr ?? "").slice(-500_000)}`,
        );
      }
    },
  );

  server.registerTool(
    "blender_save",
    {
      description:
        "Save the live scene (to its current file, or to a new .blend path in the project).",
      inputSchema: { path: z.string().optional() },
    },
    async ({ path }) => {
      try {
        const reply = await request({
          cmd: "save",
          path: path ? NodePath.resolve(process.cwd(), path) : undefined,
        });
        return reply.ok ? text(JSON.stringify(reply.data)) : fail(reply.error ?? "failed");
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error));
      }
    },
  );
}

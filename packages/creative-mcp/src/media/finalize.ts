// render_finalize: a numbered frame folder -> one verified video.
// Verify = frame count, size, duration (frames/fps within one frame), then decode EVERY frame with
// zero decoder errors. A sidecar <video>.blender.json is written, and source frames are deleted only
// when every check passed AND delete_frames=true. Any failure keeps every frame.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const run = promisify(execFile);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const abs = (p: string) => resolve(process.cwd(), p);
const BIG = { maxBuffer: 256 * 1024 * 1024, timeout: 3_600_000 };

function parseFps(s: string): [number, number] | undefined {
  const t = s.trim();
  const known: Record<string, [number, number]> = {
    "23.976": [24000, 1001],
    "29.97": [30000, 1001],
    "59.94": [60000, 1001],
  };
  if (known[t]) return known[t];
  const m = t.match(/^(\d+)(?:\/(\d+))?$/);
  if (m) return [Number(m[1]), Number(m[2] ?? 1)];
  const f = Number(t);
  return Number.isFinite(f) && f > 0 && f <= 240 ? [Math.round(f * 1000), 1000] : undefined;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
type Result =
  | {
      ok: true;
      output: string;
      sidecar: string;
      checks: Check[];
      encoder: string;
      framesDeleted: number;
    }
  | {
      ok: false;
      code: "INVALID_INPUT" | "ENCODER_UNAVAILABLE" | "INVALID_MEDIA" | "OUTPUT_EXISTS";
      message: string;
      checks: Check[];
    };

export interface FinalizeArgs {
  frames_dir: string;
  fps: string;
  frame_count?: number;
  start_frame?: number;
  intent?: "edit" | "deliver" | "draft";
  output?: string;
  overwrite?: boolean;
  delete_frames?: boolean;
}

async function probeVideo(file: string) {
  const { stdout } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,nb_read_frames,pix_fmt,codec_name:format=duration",
      "-of",
      "json",
      file,
    ],
    BIG,
  );
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] ?? {};
  return {
    width: Number(s.width),
    height: Number(s.height),
    frames: Number(s.nb_read_frames),
    duration: Number(j.format?.duration),
    codec: String(s.codec_name ?? ""),
  };
}

export async function finalize(a: FinalizeArgs): Promise<Result> {
  const checks: Check[] = [];
  const bad = (
    code: "INVALID_INPUT" | "ENCODER_UNAVAILABLE" | "INVALID_MEDIA" | "OUTPUT_EXISTS",
    message: string,
  ): Result => ({ ok: false, code, message, checks });
  const dir = abs(a.frames_dir);
  if (!existsSync(dir)) return bad("INVALID_INPUT", `frames_dir not found: ${dir}`);
  const rate = parseFps(a.fps);
  if (!rate)
    return bad("INVALID_INPUT", `fps "${a.fps}" not understood (use 24, 29.97 or 30000/1001)`);
  const intent = a.intent ?? "edit";
  const draft = intent === "draft";

  // Frames: ^\d+\.(png|jpg|jpeg)$, same extension and zero padding, contiguous.
  const all = readdirSync(dir);
  if (all.some((f) => /^\d+\.exr$/i.test(f)))
    return bad(
      "INVALID_INPUT",
      "EXR sequences are kept as they are: convert to PNG first (blender_render PNG output) or grade them in a compositor",
    );
  const files = all.filter((f) => /^\d+\.(png|jpe?g)$/i.test(f));
  if (!files.length) return bad("INVALID_INPUT", `no numbered frames (0001.png ...) in ${dir}`);
  const ext = extname(files[0]).toLowerCase();
  const width = basename(files[0], extname(files[0])).length;
  const same = files.filter(
    (f) => extname(f).toLowerCase() === ext && basename(f, extname(f)).length === width,
  );
  if (same.length !== files.length)
    return bad(
      "INVALID_INPUT",
      `frames mix extensions or zero padding (${ext}, ${width} digits expected): clean the folder`,
    );
  const nums = files.map((f) => Number(basename(f, extname(f)))).sort((x, y) => x - y);
  const startFrame = a.start_frame ?? nums[0];
  if (nums[0] !== startFrame)
    return bad("INVALID_INPUT", `first frame is ${nums[0]}, expected start_frame ${startFrame}`);
  const gaps: number[] = [];
  for (let i = 1; i < nums.length; i++)
    for (let k = nums[i - 1] + 1; k < nums[i] && gaps.length < 20; k++) gaps.push(k);
  if (gaps.length) {
    checks.push({ name: "contiguous", ok: false, detail: `missing frames: ${gaps.join(", ")}` });
    return bad(
      "INVALID_INPUT",
      `frame numbering has gaps (missing ${gaps.join(", ")}): re-render them; nothing was encoded or deleted`,
    );
  }
  const count = nums.length;
  const expected = a.frame_count ?? count;
  checks.push({
    name: "frame_count_input",
    ok: count === expected,
    detail: `${count} frames found, ${expected} expected`,
  });
  if (count !== expected)
    return bad("INVALID_INPUT", `found ${count} frames, expected ${expected}: frames kept`);

  const first = join(
    dir,
    files.find((f) => Number(basename(f, extname(f))) === nums[0])!,
  );
  const pf = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,pix_fmt",
    "-of",
    "json",
    first,
  ])
    .then((r) => JSON.parse(r.stdout).streams[0])
    .catch(() => undefined);
  if (!pf) return bad("INVALID_INPUT", `first frame unreadable: ${first}`);
  const alpha = /(rgba|argb|bgra|abgr|ya8|ya16|yuva|gbrap)/.test(String(pf.pix_fmt));
  const outW = draft ? Math.max(2, Math.round(pf.width / 4) * 2) : pf.width;
  const outH = draft ? Math.max(2, Math.round(pf.height / 4) * 2) : pf.height;
  if (!draft && (pf.width % 2 || pf.height % 2) && intent === "deliver")
    return bad(
      "INVALID_INPUT",
      `odd frame size ${pf.width}x${pf.height} cannot be encoded as H.264 yuv420p: render an even size`,
    );

  const outExt = intent === "edit" ? ".mov" : ".mp4";
  let out: string;
  if (a.output) out = abs(a.output);
  else {
    const stem = join(process.cwd(), "takes", `${basename(dir)}-${intent}`);
    let n = 1;
    while (existsSync(`${stem}-take-${String(n).padStart(2, "0")}${outExt}`)) n++;
    out = `${stem}-take-${String(n).padStart(2, "0")}${outExt}`;
  }
  if (existsSync(out) && !a.overwrite)
    return bad("OUTPUT_EXISTS", `${out} exists: choose another output or overwrite=true`);
  mkdirSync(dirname(out), { recursive: true });
  const part = join(dirname(out), `.${basename(out)}.part${extname(out)}`);

  // Encoder candidates in order of preference.
  const input = [
    "-nostdin",
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-framerate",
    `${rate[0]}/${rate[1]}`,
    "-start_number",
    String(startFrame),
    "-i",
    join(dir, `%0${width}d${ext}`),
  ];
  const scale = draft ? ["-vf", `scale=${outW}:${outH}:flags=lanczos`] : [];
  const cands: { name: string; args: string[] }[] =
    intent === "edit"
      ? [
          alpha
            ? {
                name: "prores_ks 4444 yuva444p10le",
                args: ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"],
              }
            : {
                name: "prores_ks 422 HQ",
                args: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"],
              },
        ]
      : draft
        ? [
            {
              name: "libx264 crf 28 (draft 50%)",
              args: ["-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
            },
          ]
        : [
            {
              name: "h264_videotoolbox",
              args: ["-c:v", "h264_videotoolbox", "-q:v", "75", "-pix_fmt", "yuv420p"],
            },
            {
              name: "libx264 crf 16",
              args: ["-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p"],
            },
          ];
  let encoder = "";
  const errs: string[] = [];
  for (const c of cands) {
    rmSync(part, { force: true });
    try {
      await run(
        "ffmpeg",
        [
          ...input,
          ...scale,
          ...c.args,
          "-an",
          ...(outExt === ".mp4" ? ["-movflags", "+faststart"] : []),
          part,
        ],
        BIG,
      );
      encoder = c.name;
      break;
    } catch (e) {
      errs.push(
        `${c.name}: ${String((e as { stderr?: string }).stderr ?? e)
          .trim()
          .split("\n")
          .slice(-2)
          .join(" ")}`,
      );
    }
  }
  if (!encoder) {
    rmSync(part, { force: true });
    return bad("ENCODER_UNAVAILABLE", `no encoder worked (${errs.join(" | ")}): frames kept`);
  }

  // Verify.
  const v = await probeVideo(part).catch(() => undefined);
  if (!v) {
    rmSync(part, { force: true });
    return bad("INVALID_MEDIA", "encoded file could not be probed: frames kept");
  }
  const frameDur = rate[1] / rate[0];
  const planned = (count * rate[1]) / rate[0];
  checks.push({
    name: "frame_count",
    ok: v.frames === count,
    detail: `${v.frames} decoded-counted vs ${count} input`,
  });
  checks.push({
    name: "size",
    ok: v.width === outW && v.height === outH,
    detail: `${v.width}x${v.height} vs ${outW}x${outH}`,
  });
  checks.push({
    name: "duration",
    ok: Math.abs(v.duration - planned) <= frameDur + 1e-6,
    detail: `${v.duration.toFixed(4)}s vs ${planned.toFixed(4)}s (frames/fps)`,
  });
  let decodeLog = "";
  try {
    const r = await run(
      "ffmpeg",
      ["-nostdin", "-hide_banner", "-v", "error", "-i", part, "-f", "null", "-"],
      BIG,
    );
    decodeLog = r.stderr.trim();
  } catch (e) {
    decodeLog = String((e as { stderr?: string }).stderr ?? e).trim() || "decode failed";
  }
  checks.push({
    name: "decode_all_frames",
    ok: decodeLog === "",
    detail: decodeLog
      ? decodeLog.split("\n").slice(0, 3).join(" | ")
      : "every frame decoded, no errors",
  });
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    rmSync(part, { force: true });
    return bad(
      "INVALID_MEDIA",
      `verification failed (${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}): all ${count} frames kept`,
    );
  }
  renameSync(part, out);
  const sidecar = `${out}.blender.json`;
  writeFileSync(
    sidecar,
    JSON.stringify(
      {
        fps: `${rate[0]}/${rate[1]}`,
        fpsValue: rate[0] / rate[1],
        frameCount: count,
        startFrame,
        intent,
        encoder,
        width: outW,
        height: outH,
        sourceDir: dir,
        sourceExt: ext,
        checks,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  let deleted = 0;
  if (a.delete_frames) {
    for (const f of files) {
      rmSync(join(dir, f), { force: true });
      deleted++;
    }
  }
  return { ok: true, output: out, sidecar, checks, encoder, framesDeleted: deleted };
}

export function registerFinalizeTools(server: McpServer) {
  server.registerTool(
    "render_finalize",
    {
      description: `Turn a rendered frame folder (0001.png ... from blender_render frames_dir) into ONE verified video. Requires contiguous numbering (gaps are listed, nothing encoded), refuses EXR. Encodes (intent edit = ProRes 422 HQ .mov, 4444 when the frames have alpha; deliver = H.264 h264_videotoolbox with libx264 crf 16 fallback; draft = 50% size crf 28), then verifies: decoded frame count == input frames, size, duration == frames/fps within one frame, and a full decode of EVERY frame with zero errors. Writes <video>.blender.json (fps, frameCount, startFrame, intent, encoder, checks). Source frames are deleted ONLY if every check passed and delete_frames=true (default: kept). Any failure keeps all frames and returns ENCODER_UNAVAILABLE / INVALID_MEDIA / INVALID_INPUT with the failed check. Default output ./takes/<folder>-<intent>-take-NN; never overwrites unless overwrite=true. fps: "24", "29.97" or "30000/1001".`,
      inputSchema: {
        frames_dir: z.string(),
        fps: z.string(),
        frame_count: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Expected number of frames (default: whatever is in the folder)"),
        start_frame: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("First frame number (default: lowest in the folder)"),
        intent: z.enum(["edit", "deliver", "draft"]).optional(),
        output: z.string().optional(),
        overwrite: z.boolean().optional(),
        delete_frames: z
          .boolean()
          .optional()
          .describe("Delete the source frames after all checks pass (default false)"),
      },
    },
    async (args) => {
      try {
        const r = await finalize(args);
        if (!r.ok)
          return fail(
            `render_finalize ${r.code}: ${r.message}\n${JSON.stringify(r.checks, null, 2)}`,
          );
        return text(JSON.stringify(r, null, 2));
      } catch (e) {
        return fail(`render_finalize failed: ${String(e)}`);
      }
    },
  );
}

// media_assemble + plan_validate: a declarative edit recipe -> one ffmpeg graph.
//
// Timeline rules: every in/duration/transition is snapped to the output frame grid first; transitions
// OVERLAP the clips (clip i+1 starts at start_i + dur_i - transition_i); clip audio is placed on the
// timeline with adelay and faded across the same span (equivalent to acrossfade, but lets J/L cuts and
// ducking use the same mixer). J/L cuts are extra audio pieces (picture is not re-timed) with 20 ms
// outer edges. Music ducking: key = sum of every non-ducked source; the ducked track is split into a
// floor copy (-amount dB) and a (1 - floor) copy through sidechaincompress, then re-summed. Final mix is
// amix normalize=0 -> optional gain to a loudness target -> alimiter 0.95.
// A sidecar <output>.edit.json (clip ranges, joins, source scale) lets media review read the structure.

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const run = promisify(execFile);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

// ---------------------------------------------------------------------------------------------
// Recipe schema
// ---------------------------------------------------------------------------------------------
const FPS: Record<number, [number, number]> = {
  23.976: [24000, 1001],
  24: [24, 1],
  25: [25, 1],
  29.97: [30000, 1001],
  30: [30, 1],
  48: [48, 1],
  50: [50, 1],
  59.94: [60000, 1001],
  60: [60, 1],
};
const EDGE = 0.02; // J/L piece outer-edge fade (s)
const AUDIO_RATE = 48000;

const clipSchema = z.object({
  path: z.string(),
  in: z.number().min(0).optional().describe("Source in point, seconds (default 0)"),
  out: z
    .number()
    .positive()
    .optional()
    .describe("Source out point, seconds (alternative to duration)"),
  duration: z
    .number()
    .positive()
    .optional()
    .describe("Seconds of source used (default: to the end of the file)"),
  fit: z.enum(["cover", "contain"]).optional(),
  audio: z
    .boolean()
    .optional()
    .describe("Use the clip's own audio (default: true when the file has audio)"),
  volume: z.number().min(0).max(2).optional(),
  transition: z
    .enum(["cut", "dissolve", "fade"])
    .optional()
    .describe(
      "How this clip ends and the next one starts. The overlap shortens the timeline. The last clip cannot transition.",
    ),
  transition_duration: z.number().positive().max(10).optional().describe("Seconds, default 0.5"),
  audio_lead: z
    .number()
    .positive()
    .optional()
    .describe("J-cut: this clip's audio starts N s before its picture"),
  audio_trail: z
    .number()
    .positive()
    .optional()
    .describe("L-cut: this clip's audio continues N s after its picture ends"),
});
const trackSchema = z.object({
  path: z.string(),
  start: z.number().min(0).optional().describe("Timeline start, seconds (default 0)"),
  trim: z.number().min(0).optional().describe("Skip this many seconds of the file"),
  end: z
    .number()
    .positive()
    .optional()
    .describe("Timeline end, seconds (default: file end or timeline end)"),
  volume: z.number().min(0).max(2).optional(),
  fade_in: z.number().min(0).optional(),
  fade_out: z.number().min(0).optional(),
  duck: z
    .object({
      amount_db: z
        .number()
        .positive()
        .max(60)
        .optional()
        .describe("Floor: how far the track dips under the other audio (default 12)"),
      attack: z.number().min(0.00001).max(2).optional().describe("seconds, default 0.05"),
      release: z.number().min(0.00001).max(9).optional().describe("seconds, default 0.5"),
    })
    .optional()
    .describe("Duck this track under every non-ducked audio source (voice, clip audio)"),
});
export const recipeShape = {
  output: z
    .string()
    .describe(
      "Output .mp4 path (relative to directory). Existing files are never overwritten unless overwrite=true.",
    ),
  directory: z.string().optional().describe("Base folder for relative paths (default: project)"),
  width: z.number().int().optional().describe("256-4096, even (default 1280)"),
  height: z.number().int().optional().describe("256-4096, even (default 720)"),
  fps: z
    .number()
    .optional()
    .describe("23.976, 24, 25, 29.97, 30, 48, 50, 59.94 or 60 (default 30)"),
  clips: z.array(clipSchema).min(1),
  audio: z.array(trackSchema).optional().describe("Music/voice/sfx tracks placed on the timeline"),
  loudness_target: z
    .number()
    .min(-40)
    .max(-5)
    .optional()
    .describe(
      "Integrated LUFS to reach (measured on the mix, applied as gain before the limiter), e.g. -16",
    ),
  strict: z
    .boolean()
    .optional()
    .describe("Treat source fps/size mismatches as errors instead of warnings"),
};
const recipeSchema = z.object(recipeShape);
export type Recipe = z.infer<typeof recipeSchema>;

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------
interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioDuration: number;
  isImage: boolean;
  sar: number;
}
async function probe(path: string): Promise<Probe> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s: any) => s.codec_type === "video");
  const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
  const rat = (s?: string) => {
    const [n, d] = String(s ?? "0/1")
      .split("/")
      .map(Number);
    return d ? n / d : n || 0;
  };
  const fmt = String(j.format?.format_name ?? "");
  const sarParts = String(v?.sample_aspect_ratio ?? "1:1")
    .split(":")
    .map(Number);
  const sar = sarParts[1] && sarParts[0] ? sarParts[0] / sarParts[1] : 1;
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    duration: Number(j.format?.duration ?? v?.duration ?? 0),
    fps: rat(v?.avg_frame_rate) || rat(v?.r_frame_rate),
    hasVideo: !!v,
    hasAudio: !!a,
    audioDuration: Number(a?.duration ?? j.format?.duration ?? 0),
    isImage: !!v && (fmt.includes("image2") || fmt.endsWith("_pipe")),
    sar,
  };
}

// ---------------------------------------------------------------------------------------------
// Plan + validation
// ---------------------------------------------------------------------------------------------
interface Issue {
  code: string;
  message: string;
  fix: string;
}
interface PClip {
  i: number;
  path: string;
  src: Probe;
  srcIn: number;
  dur: number;
  start: number;
  end: number;
  fit: "cover" | "contain";
  useAudio: boolean;
  volume: number;
  kind: "cut" | "dissolve" | "fade"; // how this clip ends
  tOut: number;
  tIn: number;
  lead: number;
  trail: number;
}
interface PTrack {
  path: string;
  src: Probe;
  start: number;
  trim: number;
  len: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  duck?: { floor: number; amountDb: number; attack: number; release: number };
}
interface Plan {
  width: number;
  height: number;
  fps: number;
  fpsRat: [number, number];
  total: number;
  clips: PClip[];
  tracks: PTrack[];
}

const R6 = (n: number) => Number(n.toFixed(6));
const baseDir = (r: Recipe) => resolve(r.directory ?? process.cwd());
const at = (r: Recipe, p: string) => resolve(baseDir(r), p);

async function makePlan(r: Recipe): Promise<{ errors: Issue[]; warnings: string[]; plan?: Plan }> {
  const errors: Issue[] = [];
  const warnings: string[] = [];
  const err = (code: string, message: string, fix: string) => errors.push({ code, message, fix });
  const width = r.width ?? 1280;
  const height = r.height ?? 720;
  const fps = r.fps ?? 30;
  const fpsRat = FPS[fps];
  if (!fpsRat)
    err("BAD_FPS", `fps ${fps} is not supported`, `Use one of ${Object.keys(FPS).join(", ")}.`);
  if (width < 256 || width > 4096 || width % 2)
    err("BAD_SIZE", `width ${width} must be even and 256-4096`, "Pick an even width in range.");
  if (height < 256 || height > 4096 || height % 2)
    err("BAD_SIZE", `height ${height} must be even and 256-4096`, "Pick an even height in range.");
  if (!existsSync(baseDir(r)))
    err("MISSING_FILE", `directory not found: ${baseDir(r)}`, "Create it or fix `directory`.");
  if (fpsRat && !errors.length) {
    const mb = Math.ceil(width / 16) * Math.ceil(height / 16);
    if (mb > 36864 || mb * fps > 2_073_600)
      err(
        "LEVEL_LIMIT",
        `${width}x${height}@${fps} exceeds H.264 level 5.2 (${mb} macroblocks, ${Math.round(mb * fps)} MB/s)`,
        "Lower the size or fps (max 36864 macroblocks and 2,073,600 MB/s).",
      );
  }
  if (errors.length) return { errors, warnings };
  const fr = fpsRat![0] / fpsRat![1];
  const snap = (t: number) => Math.round(t * fr) / fr;
  const frame = 1 / fr;

  const out = at(r, r.output);
  if (!/\.mp4$/i.test(out))
    err("BAD_OUTPUT", "output must end in .mp4", "Name the file e.g. takes/edit-take-01.mp4.");
  if (!existsSync(dirname(out))) warnings.push(`output folder ${dirname(out)} will be created`);

  const cache = new Map<string, Probe>();
  const get = async (p: string, what: string) => {
    const full = at(r, p);
    if (cache.has(full)) return cache.get(full)!;
    if (!existsSync(full) || !statSync(full).isFile()) {
      err(
        "MISSING_FILE",
        `${what} not found: ${full}`,
        "Fix the path or generate/copy the file first.",
      );
      return undefined;
    }
    try {
      const pr = await probe(full);
      cache.set(full, pr);
      return pr;
    } catch {
      err(
        "UNREADABLE_FILE",
        `${what} could not be read by ffprobe: ${full}`,
        "Check that it is a complete media file.",
      );
      return undefined;
    }
  };

  const clips: PClip[] = [];
  const n = r.clips.length;
  for (let i = 0; i < n; i++) {
    const c = r.clips[i];
    const label = `clips[${i}] (${basename(c.path)})`;
    const src = await get(c.path, label);
    if (!src) continue;
    if (!src.hasVideo) {
      err("NO_VIDEO", `${label} has no video stream`, "Use a video or still image file.");
      continue;
    }
    if (c.out !== undefined && c.out <= (c.in ?? 0)) {
      err(
        "BAD_RANGE",
        `${label}: out (${c.out}) must be after in (${c.in ?? 0})`,
        "Swap or fix the in/out points.",
      );
      continue;
    }
    let rawDur = c.duration ?? (c.out !== undefined ? c.out - (c.in ?? 0) : undefined);
    if (rawDur === undefined) {
      if (src.isImage) {
        err(
          "MISSING_DURATION",
          `${label} is a still: it needs a duration`,
          "Set duration (or in/out) in seconds.",
        );
        continue;
      }
      rawDur = src.duration - (c.in ?? 0);
    }
    const srcIn = snap(c.in ?? 0);
    const dur = snap(rawDur);
    if (dur < frame / 2) {
      err(
        "EMPTY_CLIP",
        `${label} is empty after snapping to the ${fps} fps frame grid (or in is past the end of the file)`,
        "Use at least one frame (1/fps s) inside the file.",
      );
      continue;
    }
    if (!src.isImage && srcIn + dur > src.duration + frame) {
      err(
        "RANGE_PAST_END",
        `${label}: ${R6(srcIn)}s + ${R6(dur)}s runs past the end of the file (${R6(src.duration)}s)`,
        `Use out <= ${R6(src.duration)} or a shorter duration.`,
      );
      continue;
    }
    const kind = i === n - 1 ? "cut" : (c.transition ?? "cut");
    if (i === n - 1 && c.transition && c.transition !== "cut")
      err(
        "LAST_TRANSITION",
        `${label} is the last clip and cannot transition`,
        "Remove transition on the last clip.",
      );
    let tOut = 0;
    if (kind !== "cut") {
      tOut = snap(c.transition_duration ?? 0.5);
      if (tOut < frame - 1e-9)
        err(
          "TRANSITION_TOO_SHORT",
          `${label}: transition is shorter than one frame`,
          `Use transition_duration >= ${R6(frame)}.`,
        );
    }
    const hasAud = src.hasAudio && !src.isImage;
    const useAudio = c.audio ?? hasAud;
    if (useAudio && !hasAud)
      err(
        "NO_AUDIO",
        `${label} has no audio stream but audio=true`,
        "Set audio=false or use a file with sound.",
      );
    if ((c.audio_lead || c.audio_trail) && !useAudio)
      err(
        "LEAD_NEEDS_AUDIO",
        `${label}: audio_lead/audio_trail need the clip's audio`,
        "Set audio=true on a file that has sound.",
      );
    const prev = clips[clips.length - 1];
    const start = prev ? R6(prev.end - prev.tOut) : 0;
    clips.push({
      i,
      path: at(r, c.path),
      src,
      srcIn,
      dur,
      start,
      end: R6(start + dur),
      fit: c.fit ?? "cover",
      useAudio,
      volume: c.volume ?? 1,
      kind,
      tOut,
      tIn: prev ? prev.tOut : 0,
      lead: c.audio_lead ? snap(c.audio_lead) : 0,
      trail: c.audio_trail ? snap(c.audio_trail) : 0,
    });
    if (src.fps && Math.abs(src.fps - fps) > 0.05 && !src.isImage) {
      const m = `${label}: source is ${R6(src.fps)} fps, timeline is ${fps} (frames dropped/duplicated)`;
      r.strict
        ? err("FPS_MISMATCH", m, `Set fps=${R6(src.fps)} or convert the clip first.`)
        : warnings.push(m);
    }
    if (!src.isImage && src.width && (src.width !== width || src.height !== height)) {
      const sa = (src.width * src.sar) / src.height;
      const differs = Math.abs(sa - width / height) >= 0.01;
      const m = `${label}: ${src.width}x${src.height} -> ${width}x${height} (${differs ? `aspect differs, fit=${c.fit ?? "cover"} ${c.fit === "contain" ? "pads" : "crops"}` : "scaled"})`;
      if (r.strict) err("SIZE_MISMATCH", m, "Set width/height to the source size or drop strict.");
      else if (differs) warnings.push(m);
    }
    const scale = Math.max(width / (src.width * src.sar || 1), height / (src.height || 1));
    if (scale > 1.5)
      warnings.push(`${label} is shown at ${scale.toFixed(2)}x its own pixels (soft)`);
  }
  for (const c of clips) {
    if (c.dur < c.tIn + c.tOut + frame - 1e-9)
      err(
        "CLIP_TOO_SHORT",
        `clips[${c.i}] (${R6(c.dur)}s) must outlast its transitions (${R6(c.tIn)}s in + ${R6(c.tOut)}s out) by one frame`,
        "Lengthen the clip or shorten the transitions.",
      );
  }
  const total = clips.length ? clips[clips.length - 1].end : 0;
  let extras = 0;
  for (const c of clips) {
    if (c.lead) {
      extras++;
      if (c.start - c.lead < -1e-9)
        err(
          "LEAD_BEFORE_START",
          `clips[${c.i}]: audio_lead ${R6(c.lead)}s would start before 0 on the timeline`,
          `Use audio_lead <= ${R6(c.start)}.`,
        );
      if (c.srcIn - c.lead < -1e-9)
        err(
          "LEAD_BEFORE_SOURCE",
          `clips[${c.i}]: no source audio before the in point (${R6(c.srcIn)}s)`,
          `Use audio_lead <= ${R6(c.srcIn)}.`,
        );
    }
    if (c.trail) {
      extras++;
      if (c.end + c.trail > total + 1e-9)
        err(
          "TRAIL_PAST_END",
          `clips[${c.i}]: audio_trail ${R6(c.trail)}s passes the end of the timeline (${R6(total)}s)`,
          `Use audio_trail <= ${R6(total - c.end)} or add a following clip.`,
        );
      if (c.srcIn + c.dur + c.trail > c.src.audioDuration + 0.05)
        err(
          "TRAIL_PAST_SOURCE",
          `clips[${c.i}]: source audio ends at ${R6(c.src.audioDuration)}s, trail needs ${R6(c.srcIn + c.dur + c.trail)}s`,
          "Shorten audio_trail.",
        );
    }
  }
  const tracks: PTrack[] = [];
  for (let k = 0; k < (r.audio ?? []).length; k++) {
    const t = r.audio![k];
    const label = `audio[${k}] (${basename(t.path)})`;
    const src = await get(t.path, label);
    if (!src) continue;
    if (!src.hasAudio) {
      err("NO_AUDIO", `${label} has no audio stream`, "Use an audio file.");
      continue;
    }
    const start = snap(t.start ?? 0);
    const trim = t.trim ?? 0;
    if (start >= total) {
      err(
        "TRACK_AFTER_END",
        `${label} starts at ${R6(start)}s, after the timeline end (${R6(total)}s)`,
        "Move it earlier.",
      );
      continue;
    }
    if (trim >= src.audioDuration) {
      err(
        "TRIM_PAST_END",
        `${label}: trim ${trim}s is past the file's end (${R6(src.audioDuration)}s)`,
        "Lower trim.",
      );
      continue;
    }
    if (t.end !== undefined && t.end <= start) {
      err("BAD_RANGE", `${label}: end (${t.end}) must be after start (${start})`, "Fix start/end.");
      continue;
    }
    const len = R6(
      Math.min(
        t.end !== undefined ? t.end - start : Infinity,
        src.audioDuration - trim,
        total - start,
      ),
    );
    if ((t.fade_in ?? 0) + (t.fade_out ?? 0) > len)
      err(
        "FADES_TOO_LONG",
        `${label}: fade_in + fade_out exceed the track length (${len}s)`,
        "Shorten the fades.",
      );
    const d = t.duck;
    const amountDb = d ? (d.amount_db ?? 12) : 0;
    tracks.push({
      path: at(r, t.path),
      src,
      start,
      trim,
      len,
      volume: t.volume ?? 1,
      fadeIn: t.fade_in ?? 0,
      fadeOut: t.fade_out ?? 0,
      duck: d
        ? {
            floor: 10 ** (-amountDb / 20),
            amountDb,
            attack: d.attack ?? 0.05,
            release: d.release ?? 0.5,
          }
        : undefined,
    });
  }
  if (tracks.length + extras > 96)
    err(
      "TOO_MANY_INPUTS",
      `${tracks.length + extras} audio tracks + lead/trail pieces exceed 96`,
      "Premix tracks first.",
    );
  if (tracks.some((t) => t.duck) && !clips.some((c) => c.useAudio) && !tracks.some((t) => !t.duck))
    warnings.push(
      "a track has duck set but there is no clip audio or non-ducked track to key from: ducking is ignored",
    );
  if (errors.length) return { errors, warnings };
  return { errors, warnings, plan: { width, height, fps, fpsRat: fpsRat!, total, clips, tracks } };
}

// ---------------------------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------------------------
const STEREO = `aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
const ms = (t: number) => Math.max(0, Math.round(t * 1000));

function buildGraph(
  p: Plan,
  o: { video: boolean; gainDb: number },
): { graph: string; hasAudio: boolean } {
  const g: string[] = [];
  const n = p.clips.length;
  const fpsStr = `${p.fpsRat[0]}/${p.fpsRat[1]}`;
  if (o.video) {
    for (const c of p.clips) {
      const f: string[] = [
        c.src.isImage
          ? `trim=start=0:duration=${R6(c.dur)}`
          : `trim=start=${R6(c.srcIn)}:duration=${R6(c.dur)}`,
        "setpts=PTS-STARTPTS",
      ];
      if (Math.abs(c.src.sar - 1) > 0.001) f.push("scale=trunc(iw*sar/2)*2:ih", "setsar=1");
      f.push(`fps=${fpsStr}`);
      f.push(
        c.fit === "cover"
          ? `scale=${p.width}:${p.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${p.width}:${p.height}`
          : `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:black`,
      );
      f.push("setsar=1", "format=yuv420p");
      g.push(`[${c.i}:v]${f.join(",")}[v${c.i}]`);
    }
    let cur = "v0";
    for (let i = 1; i < n; i++) {
      const prev = p.clips[i - 1];
      const nxt = `j${i}`;
      if (prev.kind === "cut") g.push(`[${cur}][v${i}]concat=n=2:v=1:a=0[${nxt}]`);
      else
        g.push(
          `[${cur}][v${i}]xfade=transition=${prev.kind === "fade" ? "fadeblack" : "fade"}:duration=${R6(prev.tOut)}:offset=${R6(p.clips[i].start)}[${nxt}]`,
        );
      cur = nxt;
    }
    g.push(`[${cur}]null[vout]`);
  }

  const keyed: string[] = []; // non-ducked sources = the sidechain key
  const ducked: { label: string; t: PTrack }[] = [];
  for (const c of p.clips) {
    if (!c.useAudio) continue;
    const f = [
      `atrim=start=${R6(c.srcIn)}:duration=${R6(c.dur)}`,
      "asetpts=PTS-STARTPTS",
      STEREO,
      `volume=${c.volume}`,
    ];
    if (c.tIn) f.push(`afade=t=in:st=0:d=${R6(c.tIn)}`);
    if (c.tOut) f.push(`afade=t=out:st=${R6(c.dur - c.tOut)}:d=${R6(c.tOut)}`);
    f.push(`adelay=${ms(c.start)}:all=1`);
    g.push(`[${c.i}:a]${f.join(",")}[ca${c.i}]`);
    keyed.push(`ca${c.i}`);
    if (c.lead) {
      g.push(
        `[${c.i}:a]atrim=start=${R6(c.srcIn - c.lead)}:duration=${R6(c.lead)},asetpts=PTS-STARTPTS,${STEREO},volume=${c.volume},afade=t=in:st=0:d=${EDGE},adelay=${ms(c.start - c.lead)}:all=1[cl${c.i}]`,
      );
      keyed.push(`cl${c.i}`);
    }
    if (c.trail) {
      g.push(
        `[${c.i}:a]atrim=start=${R6(c.srcIn + c.dur)}:duration=${R6(c.trail)},asetpts=PTS-STARTPTS,${STEREO},volume=${c.volume},afade=t=out:st=${R6(Math.max(0, c.trail - EDGE))}:d=${EDGE},adelay=${ms(c.end)}:all=1[ct${c.i}]`,
      );
      keyed.push(`ct${c.i}`);
    }
  }
  p.tracks.forEach((t, k) => {
    const f = [
      `atrim=start=${R6(t.trim)}:duration=${R6(t.len)}`,
      "asetpts=PTS-STARTPTS",
      STEREO,
      `volume=${t.volume}`,
    ];
    if (t.fadeIn) f.push(`afade=t=in:st=0:d=${R6(t.fadeIn)}`);
    if (t.fadeOut)
      f.push(`afade=t=out:st=${R6(Math.max(0, t.len - t.fadeOut))}:d=${R6(t.fadeOut)}`);
    f.push(`adelay=${ms(t.start)}:all=1`);
    g.push(`[${p.clips.length + k}:a]${f.join(",")}[ta${k}]`);
  });
  // Tracks are routed after the loop so `keyed` is complete before deciding who gets ducked.
  p.tracks.forEach((t, k) => {
    if (!t.duck) keyed.push(`ta${k}`);
  });
  const keyAvailable = keyed.length > 0;
  p.tracks.forEach((t, k) => {
    if (t.duck) {
      if (keyAvailable) ducked.push({ label: `ta${k}`, t });
      else keyed.push(`ta${k}`);
    }
  });
  const hasAudio = keyed.length + ducked.length > 0;
  if (hasAudio) {
    const mixParts: string[] = [];
    if (keyAvailable) {
      const sum =
        keyed.length === 1
          ? `[${keyed[0]}]anull`
          : `${keyed.map((l) => `[${l}]`).join("")}amix=inputs=${keyed.length}:normalize=0:duration=longest`;
      if (ducked.length) {
        const copies = ["keyfinal", ...ducked.map((_, d) => `key${d}`)];
        // Pad the key with silence to the full length: a key that ends early would leave the compressor stuck.
        g.push(
          `${sum},apad=whole_dur=${R6(p.total)}[keymix]`,
          `[keymix]asplit=${copies.length}${copies.map((c) => `[${c}]`).join("")}`,
        );
      } else g.push(`${sum}[keyfinal]`);
      mixParts.push("keyfinal");
    } else mixParts.push(...keyed); // only ducked tracks and nothing to key from: plain mix
    ducked.forEach(({ label, t }, d) => {
      const dk = t.duck!;
      g.push(
        `[${label}]asplit=2[${label}f][${label}s]`,
        `[${label}f]volume=${dk.floor.toFixed(6)}[${label}fl]`,
        `[${label}s]volume=${(1 - dk.floor).toFixed(6)}[${label}sv]`,
        `[${label}sv][key${d}]sidechaincompress=threshold=0.001:ratio=20:attack=${R6(dk.attack * 1000)}:release=${R6(dk.release * 1000)}:makeup=1[${label}c]`,
        `[${label}c][${label}fl]amix=inputs=2:normalize=0:duration=longest[dk${d}]`,
      );
      mixParts.push(`dk${d}`);
    });
    const tail = [
      o.gainDb ? `volume=${o.gainDb.toFixed(3)}dB` : "",
      "alimiter=limit=0.95:level=0",
      `atrim=duration=${R6(p.total)}`,
      "asetpts=PTS-STARTPTS",
    ]
      .filter(Boolean)
      .join(",");
    g.push(
      mixParts.length === 1
        ? `[${mixParts[0]}]${tail}[aout]`
        : `${mixParts.map((l) => `[${l}]`).join("")}amix=inputs=${mixParts.length}:normalize=0:duration=longest,${tail}[aout]`,
    );
  }
  return { graph: g.join(";\n"), hasAudio };
}

function inputArgs(p: Plan): string[] {
  const a: string[] = [];
  for (const c of p.clips) {
    if (c.src.isImage)
      a.push(
        "-loop",
        "1",
        "-framerate",
        `${p.fpsRat[0]}/${p.fpsRat[1]}`,
        "-t",
        String(R6(c.dur + 1)),
        "-i",
        c.path,
      );
    else a.push("-i", c.path);
  }
  for (const t of p.tracks) a.push("-i", t.path);
  return a;
}

/** Integrated loudness via loudnorm's analysis json. Pass a graph (ending in [aout]) or a file. */
async function measureLufs(
  src: { file: string } | { graph: string; inputs: string[] },
): Promise<{ lufs: number; tp: number } | undefined> {
  try {
    const a = ["-nostdin", "-hide_banner", "-v", "info"];
    if ("file" in src) a.push("-i", src.file, "-vn", "-af", "loudnorm=I=-23:print_format=json");
    else
      a.push(
        ...src.inputs,
        "-filter_complex",
        `${src.graph};[aout]loudnorm=I=-23:print_format=json[lm]`,
        "-map",
        "[lm]",
      );
    a.push("-f", "null", "-");
    const { stderr } = await run("ffmpeg", a, { maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 });
    const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/);
    if (!m) return undefined;
    const j = JSON.parse(m[0]);
    const lufs = Number(j.input_i);
    return Number.isFinite(lufs) ? { lufs, tp: Number(j.input_tp) } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------
export async function assemble(
  recipe: Recipe,
  opts: { overwrite?: boolean; dryRun?: boolean } = {},
) {
  const { errors, warnings, plan } = await makePlan(recipe);
  if (!plan) return { ok: false as const, errors, warnings };
  const out = at(recipe, recipe.output);
  if (existsSync(out) && !opts.overwrite) {
    return {
      ok: false as const,
      errors: [
        {
          code: "OUTPUT_EXISTS",
          message: `${out} exists`,
          fix: "Use a new name (e.g. -take-02) or overwrite=true.",
        },
      ],
      warnings,
    };
  }
  if (opts.dryRun) return { ok: true as const, dryRun: true as const, plan, warnings };
  mkdirSync(dirname(out), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "oh-assemble-"));
  try {
    const inputs = inputArgs(plan);
    let gainDb = 0;
    let measured: { lufs: number; tp: number } | undefined;
    const audioOnly = buildGraph(plan, { video: false, gainDb: 0 });
    if (recipe.loudness_target !== undefined && audioOnly.hasAudio) {
      measured = await measureLufs({ graph: audioOnly.graph, inputs });
      if (measured) gainDb = Math.max(-24, Math.min(24, recipe.loudness_target - measured.lufs));
      else warnings.push("loudness could not be measured: no gain applied");
    }
    const { graph, hasAudio } = buildGraph(plan, { video: true, gainDb });
    const gfile = join(work, "graph.fg");
    writeFileSync(gfile, graph);
    const tmpOut = join(dirname(out), `.${basename(out)}.part.mp4`);
    const fpsStr = `${plan.fpsRat[0]}/${plan.fpsRat[1]}`;
    const args = [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-y",
      ...inputs,
      "-/filter_complex",
      gfile,
      "-map",
      "[vout]",
      ...(hasAudio ? ["-map", "[aout]"] : []),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-r",
      fpsStr,
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", String(AUDIO_RATE)] : ["-an"]),
      "-t",
      String(R6(plan.total)),
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      tmpOut,
    ];
    const budgetMs = Math.max(
      300_000,
      10_000 * plan.total * ((plan.width * plan.height * plan.fps) / (1920 * 1080 * 30)),
    );
    try {
      await run("ffmpeg", args, { maxBuffer: 64 * 1024 * 1024, timeout: budgetMs });
    } catch (e) {
      rmSync(tmpOut, { force: true });
      return {
        ok: false as const,
        errors: [
          {
            code: "FFMPEG_FAILED",
            message: String((e as { stderr?: string }).stderr ?? e).slice(-2500),
            fix: "Check the recipe inputs; run plan_validate.",
          },
        ],
        warnings,
      };
    }
    const info = await probe(tmpOut);
    if (!info.hasVideo || Math.abs(info.duration - plan.total) > 0.25) {
      rmSync(tmpOut, { force: true });
      return {
        ok: false as const,
        errors: [
          {
            code: "INVALID_MEDIA",
            message: `output ${info.hasVideo ? "" : "has no video, "}duration ${R6(info.duration)}s, planned ${R6(plan.total)}s`,
            fix: "Re-run with dry_run=true and check the timeline.",
          },
        ],
        warnings,
      };
    }
    renameSync(tmpOut, out);
    const outLufs = hasAudio ? await measureLufs({ file: out }) : undefined;
    const sidecar = {
      kind: "edit",
      version: 1,
      output: out,
      createdAt: new Date().toISOString(),
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration: R6(info.duration),
      plannedDuration: R6(plan.total),
      clips: plan.clips.map((c) => ({
        index: c.i,
        path: c.path,
        sourceIn: R6(c.srcIn),
        sourceOut: R6(c.srcIn + c.dur),
        timelineStart: c.start,
        timelineEnd: c.end,
        fit: c.fit,
        transitionOut: c.kind,
        transitionOutDuration: R6(c.tOut),
        audio: c.useAudio,
        audioLead: c.lead || undefined,
        audioTrail: c.trail || undefined,
        sourceWidth: c.src.width,
        sourceHeight: c.src.height,
        shownScale: R6(
          Math.max(plan.width / (c.src.width * c.src.sar || 1), plan.height / (c.src.height || 1)),
        ),
      })),
      boundaries: plan.clips
        .slice(1)
        .map((c, i) => ({
          time: c.start,
          type: plan.clips[i].kind,
          duration: R6(plan.clips[i].tOut),
          from: i,
          to: c.i,
          joinMotion: plan.clips[i].kind === "cut" ? "hard-cut" : "overlap",
        })),
      audio: plan.tracks.map((t) => ({
        path: t.path,
        start: t.start,
        length: t.len,
        volume: t.volume,
        ducked: !!t.duck,
        duckAmountDb: t.duck?.amountDb,
      })),
      mix: {
        limiter: 0.95,
        loudnessTarget: recipe.loudness_target,
        measuredLufs: measured?.lufs,
        gainDb: gainDb || undefined,
        outputLufs: outLufs?.lufs,
      },
      warnings,
    };
    writeFileSync(`${out}.edit.json`, JSON.stringify(sidecar, null, 2));
    return {
      ok: true as const,
      output: out,
      sidecar: `${out}.edit.json`,
      duration: R6(info.duration),
      warnings,
      mix: sidecar.mix,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function validate(recipe: Recipe) {
  const { errors, warnings, plan } = await makePlan(recipe);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    timeline: plan && {
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      duration: plan.total,
      clips: plan.clips.map((c) => ({
        index: c.i,
        start: c.start,
        end: c.end,
        sourceIn: R6(c.srcIn),
        transitionOut: c.kind,
        transitionOutDuration: R6(c.tOut),
      })),
    },
  };
}

export function registerAssembleTools(server: McpServer) {
  server.registerTool(
    "plan_validate",
    {
      description:
        "Validate a media_assemble recipe WITHOUT rendering. Refuses impossible ranges (in/out past the end of a source, empty after frame snapping), missing files, bad size/fps (even 256-4096, fps set, H.264 level 5.2 limits), transitions too short for their clips, the last clip transitioning, J/L cuts without audio or outside the timeline, too many audio inputs. Every error has a fix hint; warnings cover fps/size mismatch (strict=true makes them errors) and clips shown above 1.5x their pixels. Returns the snapped timeline. Run it before media_assemble on any multi-clip edit.",
      inputSchema: recipeShape,
    },
    async (args) => {
      try {
        return text(JSON.stringify(await validate(args as Recipe), null, 2));
      } catch (e) {
        return fail(`plan_validate failed: ${String(e)}`);
      }
    },
  );
  server.registerTool(
    "media_assemble",
    {
      description: `Render a declarative edit recipe to one MP4 (H.264 + AAC) in a single ffmpeg pass, and write the sidecar <output>.edit.json (clip ranges, joins, source scale, mix) that media_review reads.
clips[]: path, in/out or duration, fit cover|contain, audio, volume, transition cut|dissolve|fade (+transition_duration, default 0.5) that OVERLAPS the next clip (the output shortens by the overlap), audio_lead (J-cut) / audio_trail (L-cut): the clip's own audio starts earlier / runs on over the next picture with 20 ms outer edges while the picture is not re-timed. Stills need a duration. All times snap to the frame grid. audio[]: music/voice tracks with start, trim, end, volume, fade_in/fade_out and duck {amount_db 12, attack 0.05, release 0.5}: a ducked track dips under all clip audio and non-ducked tracks but never below the floor. Final mix: amix normalize=0 -> optional loudness_target gain (measured first) -> alimiter 0.95. No text/logo overlays (this ffmpeg has no drawtext): composite those separately. Validates first (see plan_validate); never overwrites unless overwrite=true; dry_run=true only validates and returns the plan. Output goes to ./takes/ by convention (e.g. takes/edit-take-01.mp4).`,
      inputSchema: {
        ...recipeShape,
        overwrite: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async ({ overwrite, dry_run, ...recipe }) => {
      try {
        const r = await assemble(recipe as Recipe, { overwrite, dryRun: dry_run });
        if (!r.ok)
          return fail(
            `media_assemble refused/failed:\n${JSON.stringify({ errors: r.errors, warnings: r.warnings }, null, 2)}`,
          );
        return text(
          JSON.stringify(
            "dryRun" in r ? { dryRun: true, duration: r.plan.total, warnings: r.warnings } : r,
            null,
            2,
          ),
        );
      } catch (e) {
        return fail(`media_assemble failed: ${String(e)}`);
      }
    },
  );
}

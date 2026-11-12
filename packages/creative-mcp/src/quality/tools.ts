// Quality harness: deterministic media QA, a take ledger, side-by-side take comparison and the
// house-style memory that turns user corrections into lasting rules.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeBoundaries, type Boundary, recipeTiming, writeBoundaryStills } from "./boundary.ts";
import {
  drawRect,
  drawText,
  fitWidth,
  grid,
  type Img,
  luma,
  mad,
  type RGB,
  streamFrames,
  writeJpeg,
} from "./raster.ts";
import {
  X,
  audioExtras,
  audioSourceCheck,
  type AudioStats,
  frameCountCheck,
  type Flag,
  joinChecks,
  parseMomentary,
  readRecipe,
  type Recipe,
  recipeCuts,
  recipeSources,
  type Severity,
  sourceScaleCheck,
  type SourceSpec,
} from "./review-extra.ts";
import { SAFE_ZONES, visionChecks } from "./vision.ts";

const run = promisify(execFile);
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const project = () => process.cwd();
const abs = (p: string) => resolve(project(), p);
const fmt = (t: number) => `${t.toFixed(2)}s`;
const BIG = { maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 };

// ---------------------------------------------------------------------------------------------
// Thresholds (documented in the media_review description and the review-media skill).
// ---------------------------------------------------------------------------------------------
const T = {
  silenceDb: -50, // audio below this level counts as silence
  silenceMinSec: 1.0, // report silent spans at least this long
  blackPixel: 0.1, // blackdetect pix_th: pixel is "black" below 10% luma
  blackMinSec: 0.1, // report black spans at least this long
  freezeNoiseDb: -60, // freezedetect noise tolerance
  freezeMinSec: 0.5, // report frozen spans at least this long
  sceneScore: 10, // scdet threshold (0-100) for a cut
  cutJump: 80, // mean-luma jump (0-255) across a cut that reads as a flash
  flashDelta: 40, // frame-to-frame mean-luma change counted as one flash transition
  flashPerSec: 6, // more transitions than this in any 1 s window = more than 3 flashes/s
  letterbox: 0.97, // active picture smaller than 97% of the frame = bars
  truePeakMax: -1.0, // dBTP ceiling for delivery
  durationTolerance: 0.05, // 5% (at least 0.5 s) off the expected duration
};

interface Platform {
  aspect: [number, number];
  width: number;
  height: number;
  maxSeconds?: number;
  lufs: number;
}
const PLATFORMS: Record<string, Platform> = {
  youtube: { aspect: [16, 9], width: 1920, height: 1080, lufs: -14 },
  shorts: { aspect: [9, 16], width: 1080, height: 1920, maxSeconds: 180, lufs: -14 },
  tiktok: { aspect: [9, 16], width: 1080, height: 1920, maxSeconds: 600, lufs: -14 },
  reels: { aspect: [9, 16], width: 1080, height: 1920, maxSeconds: 180, lufs: -14 },
  square: { aspect: [1, 1], width: 1080, height: 1080, lufs: -14 },
};

/** Optional inputs of media_review beyond the file itself. */
interface ReviewOpts {
  audioSource?: string;
  cuts: number[];
  sources: SourceSpec[];
  samples: number;
  edgeMargin: number;
  tolerance: number;
  readText?: boolean;
  recipe?: Recipe;
  save: (img: Img, name: string) => Promise<string>;
}

interface Probe {
  duration: number;
  formatName: string;
  video?: {
    width: number;
    height: number;
    fps: number;
    avgFps: number;
    codec: string;
    pixFmt: string;
    frames?: number;
  };
  audio?: { codec: string; sampleRate: number; channels: number };
}

const ratio = (s?: string) => {
  const [n, d] = (s ?? "0/1").split("/").map(Number);
  return d ? n! / d : 0;
};

async function probe(src: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    src,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      pix_fmt?: string;
      nb_frames?: string;
      sample_rate?: string;
      channels?: number;
      side_data_list?: { rotation?: number }[];
      disposition?: { attached_pic?: number };
    }[];
  };
  const v = data.streams?.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = data.streams?.find((s) => s.codec_type === "audio");
  const rotated =
    Math.abs(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) === 90;
  return {
    duration: Number(data.format?.duration) || 0,
    formatName: data.format?.format_name ?? "",
    video: v && {
      width: (rotated ? v.height : v.width) ?? 0,
      height: (rotated ? v.width : v.height) ?? 0,
      fps: ratio(v.r_frame_rate),
      avgFps: ratio(v.avg_frame_rate),
      codec: v.codec_name,
      pixFmt: v.pix_fmt ?? "",
      frames: v.nb_frames ? Number(v.nb_frames) : undefined,
    },
    audio: a && {
      codec: a.codec_name,
      sampleRate: Number(a.sample_rate) || 0,
      channels: a.channels ?? 0,
    },
  };
}

const isStill = (p: Probe) =>
  !!p.video &&
  (/image2|_pipe$|png|jpeg|webp|tiff|bmp/.test(p.formatName) ||
    (!p.audio && (p.duration === 0 || p.video.frames === 1))) &&
  !/gif/.test(p.formatName);

/** Per-frame metadata written by ffmpeg's metadata=print filter. */
function parseFrameMeta(file: string): { t: number; m: Record<string, string> }[] {
  const out: { t: number; m: Record<string, string> }[] = [];
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const frame = /pts_time:([\d.eE+-]+)/.exec(line);
    if (line.startsWith("frame:") && frame) out.push({ t: Number(frame[1]), m: {} });
    else if (out.length && line.includes("=")) {
      const i = line.indexOf("=");
      out[out.length - 1]!.m[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return out;
}

/** signalstats of a single image after an optional filter prefix, full-range luma. */
async function stillStats(src: string, prefix: string): Promise<Record<string, number>> {
  const dir = mkdtempSync(join(tmpdir(), "oh-qa-"));
  try {
    const meta = join(dir, "m.txt");
    await run("ffmpeg", [
      "-v",
      "error",
      "-i",
      src,
      "-frames:v",
      "1",
      "-vf",
      `scale=w='min(1600,iw)':h=-2:out_range=full,format=yuv444p${prefix ? `,${prefix}` : ""},signalstats,metadata=mode=print:file=${meta}`,
      "-f",
      "null",
      "-",
    ]);
    const [frame] = parseFrameMeta(meta);
    return Object.fromEntries(
      Object.entries(frame?.m ?? {}).map(([k, v]) => [
        k.replace("lavfi.signalstats.", ""),
        Number(v),
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkGeometry(
  width: number,
  height: number,
  platform: Platform | undefined,
  name: string | undefined,
  flags: Flag[],
) {
  if (width % 2 || height % 2)
    flags.push({
      severity: "warn",
      what: `Odd dimensions ${width}x${height}; many encoders/players need even sizes.`,
      fix: "Scale or pad to even width and height.",
    });
  if (!platform) return;
  const want = platform.aspect[0] / platform.aspect[1];
  const have = width / height;
  if (Math.abs(have - want) / want > 0.02)
    flags.push({
      severity: "error",
      what: `Aspect ${width}x${height} (${have.toFixed(3)}) does not match ${name} ${platform.aspect.join(":")}.`,
      fix: `Reframe to ${platform.width}x${platform.height}; crop/reposition rather than stretch.`,
    });
  else if (width < platform.width || height < platform.height)
    flags.push({
      severity: "warn",
      what: `Resolution ${width}x${height} is below the ${name} target ${platform.width}x${platform.height}.`,
      fix: "Render or upscale to the target size.",
    });
}

async function reviewStill(
  src: string,
  info: Probe,
  platform: Platform | undefined,
  name: string | undefined,
  opts: ReviewOpts,
) {
  const flags: Flag[] = [];
  const { width, height } = info.video!;
  checkGeometry(width, height, platform, name, flags);
  const base = await stillStats(src, "");
  const high = await stillStats(src, "lutyuv=y='if(gte(val,250),255,0)'");
  const low = await stillStats(src, "lutyuv=y='if(lte(val,5),255,0)'");
  const mean = base.YAVG ?? 0;
  const spread = (base.YHIGH ?? 0) - (base.YLOW ?? 0);
  const clipped = ((high.YAVG ?? 0) / 255) * 100;
  const crushed = ((low.YAVG ?? 0) / 255) * 100;
  if (spread < 60 && (base.YMAX ?? 0) - (base.YMIN ?? 0) < 160)
    flags.push({
      severity: "warn",
      what: `Low contrast: 10-90% luma spread ${spread.toFixed(0)}/255 (flat, washed out).`,
      fix: "Add a tone curve / contrast, deepen shadows, add a clear light source.",
    });
  if (mean < 50)
    flags.push({
      severity: "warn",
      what: `Very dark overall (mean luma ${mean.toFixed(0)}/255).`,
      fix: "Lift exposure or add fill/rim light unless a low-key look is intended.",
    });
  if (mean > 205)
    flags.push({
      severity: "warn",
      what: `Very bright overall (mean luma ${mean.toFixed(0)}/255).`,
      fix: "Lower exposure / highlights unless a high-key look is intended.",
    });
  if (clipped > 5)
    flags.push({
      severity: "warn",
      what: `${clipped.toFixed(1)}% of pixels are clipped highlights (luma >= 250).`,
      fix: "Reduce exposure or use Filmic/AgX view transform; fine if it's a flat white background.",
    });
  if (crushed > 10)
    flags.push({
      severity: "warn",
      what: `${crushed.toFixed(1)}% of pixels are crushed shadows (luma <= 5).`,
      fix: "Lift shadows or add fill light; fine if it's a flat black background.",
    });
  const detail: string[] = [];
  try {
    await upscaleCheck(src, { w: width, h: height }, undefined, flags, detail);
  } catch {
    // detail check is best effort
  }
  try {
    await visionChecks(
      {
        src,
        dur: 0,
        still: true,
        width,
        height,
        fps: 0,
        platform: name,
        samples: 1,
        edgeMargin: opts.edgeMargin,
        readText: false,
        hasRecipeText: false,
        save: opts.save,
      },
      flags,
      detail,
    );
  } catch {
    // frame-edge / safe-area checks are best effort
  }
  const stats = `${detail.length ? `${detail.join(" ")}\n` : ""}Still image ${width}x${height}. Luma mean ${mean.toFixed(0)}, 10-90% spread ${spread.toFixed(0)}, min ${base.YMIN} max ${base.YMAX}; clipped ${clipped.toFixed(1)}%, crushed ${crushed.toFixed(1)}%; mean saturation ${(base.SATAVG ?? 0).toFixed(0)}.`;
  return { stats, flags };
}

async function reviewVideo(
  src: string,
  info: Probe,
  platform: Platform | undefined,
  name: string | undefined,
  opts: ReviewOpts,
  expected?: number,
) {
  const flags: Flag[] = [];
  const lines: string[] = [];
  const dur = info.duration;
  const v = info.video;
  lines.push(
    `Duration ${fmt(dur)}${v ? `, video ${v.width}x${v.height} @ ${v.avgFps.toFixed(3)} fps ${v.codec}/${v.pixFmt}` : ", no video stream"}${info.audio ? `, audio ${info.audio.codec} ${info.audio.sampleRate} Hz ${info.audio.channels}ch` : ", no audio stream"}.`,
  );

  if (expected !== undefined && Math.abs(dur - expected) > Math.max(0.5, expected * opts.tolerance))
    flags.push({
      severity: "error",
      what: `Duration ${fmt(dur)} differs from expected ${fmt(expected)}.`,
      fix: "Check frame range / trim points / concat list.",
    });
  if (platform?.maxSeconds && dur > platform.maxSeconds)
    flags.push({
      severity: "error",
      what: `Longer than the ${name} limit of ${platform.maxSeconds}s.`,
      fix: "Cut it down.",
    });

  if (v) {
    checkGeometry(v.width, v.height, platform, name, flags);
    if (v.avgFps && v.avgFps < 23.5)
      flags.push({
        severity: "warn",
        what: `Low frame rate ${v.avgFps.toFixed(2)} fps; motion will stutter.`,
        fix: "Render at 24/25/30 fps (60 for fast UI/game footage).",
      });
    if (v.fps && v.avgFps && Math.abs(v.fps - v.avgFps) / v.fps > 0.01)
      flags.push({
        severity: "warn",
        what: `Variable frame rate (nominal ${v.fps.toFixed(2)}, average ${v.avgFps.toFixed(2)}).`,
        fix: "Re-encode with a constant rate, e.g. -fps_mode cfr -r 30.",
      });
    if (/^(h264|hevc)$/.test(v.codec) && v.pixFmt !== "yuv420p")
      flags.push({
        severity: "warn",
        what: `${v.codec} with ${v.pixFmt}: many players and social platforms only handle yuv420p.`,
        fix: "Add -pix_fmt yuv420p for delivery files.",
      });
  }

  // Audio: loudness, true peak, silence.
  if (!info.audio) {
    flags.push({
      severity: platform ? "warn" : "info",
      what: "No audio track.",
      fix: "Add music/voice/ambience, or a silent track if the platform requires one.",
    });
  } else {
    const adir = mkdtempSync(join(tmpdir(), "oh-qa-"));
    const ameta = join(adir, "r128.txt");
    let stderr = "";
    try {
      ({ stderr } = await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostats",
          "-i",
          src,
          "-vn",
          "-af",
          `ebur128=peak=true:framelog=quiet:metadata=1,ametadata=mode=print:file=${ameta},silencedetect=n=${T.silenceDb}dB:d=${T.silenceMinSec}`,
          "-f",
          "null",
          "-",
        ],
        BIG,
      ));
    } catch (error) {
      rmSync(adir, { recursive: true, force: true });
      throw error;
    }
    const momentary = parseMomentary(ameta);
    rmSync(adir, { recursive: true, force: true });
    const lufs = Number(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(stderr)?.[1]);
    const tp = Number(
      /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(stderr.slice(stderr.lastIndexOf("True peak")))?.[1],
    );
    const lra = Number(/LRA:\s+([\d.]+) LU/.exec(stderr)?.[1]);
    lines.push(
      `Loudness ${Number.isFinite(lufs) ? lufs.toFixed(1) : "-inf"} LUFS integrated, true peak ${Number.isFinite(tp) ? tp.toFixed(1) : "-inf"} dBTP, range ${Number.isFinite(lra) ? lra.toFixed(1) : "?"} LU.`,
    );
    const silences: [number, number][] = [];
    let open: number | undefined;
    for (const m of stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
      if (m[1] === "start") open = Math.max(0, Number(m[2]));
      else if (open !== undefined) {
        silences.push([open, Number(m[2])]);
        open = undefined;
      }
    }
    if (open !== undefined) silences.push([open, dur]);
    const whole = silences.length === 1 && silences[0]![1] - silences[0]![0] >= dur - 0.2;
    if (!Number.isFinite(lufs) || lufs <= -69 || whole)
      flags.push({
        severity: "error",
        what: "Audio track is completely silent.",
        fix: "Check the mix/mapping, or drop the track if silence is intended.",
      });
    else {
      const target = platform?.lufs;
      if (target !== undefined && lufs < target - 2)
        flags.push({
          severity: "warn",
          what: `Quiet: ${lufs.toFixed(1)} LUFS vs ${name} target ${target} LUFS; it will play quieter than other videos.`,
          fix: `Normalize: -af loudnorm=I=${target}:TP=-1.5:LRA=11 (two-pass for best results).`,
        });
      if (target !== undefined && lufs > target + 2)
        flags.push({
          severity: "warn",
          what: `Loud: ${lufs.toFixed(1)} LUFS vs ${name} target ${target} LUFS; the platform will turn it down and it may sound squashed.`,
          fix: `Normalize: -af loudnorm=I=${target}:TP=-1.5:LRA=11.`,
        });
      if (target === undefined && (lufs > -9 || lufs < -24))
        flags.push({
          severity: "warn",
          what: `Loudness ${lufs.toFixed(1)} LUFS is outside the usual -24..-9 range.`,
          fix: "Normalize with loudnorm (-14 for web/social, -16 for podcasts/voice, -23 for broadcast).",
        });
      if (tp > T.truePeakMax)
        flags.push({
          severity: tp > -0.1 ? "error" : "warn",
          what: `True peak ${tp.toFixed(1)} dBTP above ${T.truePeakMax} dBTP${tp > -0.1 ? " (clipping/distortion)" : ""}.`,
          fix: "Lower the gain at the source, or normalize with -af loudnorm=I=-14:TP=-1.5:LRA=11 (true-peak aware; a sample-peak limiter can still overshoot after AAC encoding).",
        });
      const stats: AudioStats = { I: lufs, TP: tp, LRA: lra, M: momentary };
      audioExtras(stats, dur, flags, lines);
      try {
        if (opts.audioSource) await audioSourceCheck(stats, opts.audioSource, flags, lines);
      } catch (error) {
        flags.push({
          severity: "info",
          what: `audio_source comparison failed: ${String((error as { stderr?: string }).stderr ?? error).slice(-200)}`,
        });
      }
      for (const [s, e] of silences) {
        const edge = s < 0.05 || e > dur - 0.05;
        flags.push({
          severity: edge ? "info" : "warn",
          what: `${edge ? (s < 0.05 ? "Leading" : "Trailing") + " silence" : "Silent gap"} ${fmt(e - s)} (below ${T.silenceDb} dB).`,
          start: s,
          end: e,
          fix: edge
            ? "Trim it, or start sound with the picture."
            : "Fill with music/room tone or tighten the edit.",
        });
      }
    }
  }

  // Picture: black, freeze, cuts, flashes, letterboxing — one decoding pass on a 480 px proxy.
  if (v) {
    const dir = mkdtempSync(join(tmpdir(), "oh-qa-"));
    try {
      const meta = join(dir, "meta.txt");
      const chain = `scale=480:-2,blackdetect=d=${T.blackMinSec}:pix_th=${T.blackPixel},freezedetect=n=${T.freezeNoiseDb}dB:d=${T.freezeMinSec},scdet=threshold=${T.sceneScore},cropdetect=limit=24:round=2,signalstats,metadata=mode=print:file=${meta}`;
      const { stderr } = await run(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostats",
          "-loglevel",
          "info",
          "-i",
          src,
          "-an",
          "-vf",
          chain,
          "-fps_mode",
          "passthrough",
          "-f",
          "null",
          "-",
        ],
        BIG,
      );
      const blacks = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(
        (m) => [Number(m[1]), Number(m[2])] as [number, number],
      );
      const freezes: [number, number][] = [];
      let fs: number | undefined;
      for (const m of stderr.matchAll(/freezedetect\.freeze_(start|end): ([\d.]+)/g)) {
        if (m[1] === "start") fs = Number(m[2]);
        else if (fs !== undefined) {
          freezes.push([fs, Number(m[2])]);
          fs = undefined;
        }
      }
      if (fs !== undefined) freezes.push([fs, dur]);
      const frames = parseFrameMeta(meta);
      if (v.avgFps) frameCountCheck(frames.length, dur, v.avgFps, flags, lines);

      const firstPictureFlag = flags.length;
      for (const [s, e] of blacks) {
        const edge = s < 0.05 || e > dur - 0.1;
        const long = e - s >= 0.5;
        flags.push({
          severity: edge ? "info" : long ? "error" : "warn",
          what: `${edge ? "Black at head/tail" : "Black frames"} ${fmt(e - s)}.`,
          start: s,
          end: e,
          fix: edge
            ? "Fine for a fade; otherwise trim."
            : "Missing clip/render gap or a too-long dip: fill or cut it.",
        });
      }
      const overlap = (a: [number, number], b: [number, number]) =>
        Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
      for (const f of freezes) {
        if (blacks.some((b) => overlap(f, b) >= 0.8 * (f[1] - f[0]))) continue;
        flags.push({
          severity: "warn",
          what: `Frozen picture ${fmt(f[1] - f[0])} (no change).`,
          start: f[0],
          end: f[1],
          fix: "Fine for an intended hold/title card; otherwise a stalled render, missing frames or a too-long still: add motion (slow push-in) or shorten.",
        });
      }

      const cuts: number[] = [];
      let prevY: number | undefined;
      const transitions: number[] = [];
      for (const fr of frames) {
        const y = Number(fr.m["lavfi.signalstats.YAVG"]);
        if (fr.m["lavfi.scd.time"] !== undefined) {
          cuts.push(fr.t);
          if (prevY !== undefined && Math.abs(y - prevY) >= T.cutJump)
            flags.push({
              severity: "info",
              what: `Hard brightness jump at cut (mean luma ${prevY.toFixed(0)} -> ${y.toFixed(0)}).`,
              start: fr.t,
              fix: "Intentional flash? Otherwise match exposure or add a short dissolve.",
            });
        }
        if (prevY !== undefined && Math.abs(y - prevY) >= T.flashDelta) transitions.push(fr.t);
        if (Number.isFinite(y)) prevY = y;
      }
      // Photosensitivity: more than 3 flashes (6 opposing transitions) inside any 1 s window.
      let spanStart: number | undefined;
      let spanEnd = 0;
      const spans: [number, number][] = [];
      for (let i = 0; i < transitions.length; i++) {
        let j = i;
        while (j + 1 < transitions.length && transitions[j + 1]! - transitions[i]! <= 1) j++;
        if (j - i + 1 > T.flashPerSec) {
          if (spanStart !== undefined && transitions[i]! <= spanEnd)
            spanEnd = Math.max(spanEnd, transitions[j]!);
          else {
            if (spanStart !== undefined) spans.push([spanStart, spanEnd]);
            spanStart = transitions[i]!;
            spanEnd = transitions[j]!;
          }
        }
      }
      if (spanStart !== undefined) spans.push([spanStart, spanEnd]);
      // Black frames and cut jumps inside a strobe are part of the flash flag, not separate issues.
      const inFlash = (f: Flag) =>
        f.start !== undefined &&
        /^(Black frames|Hard brightness)/.test(f.what) &&
        spans.some(([s, e]) => f.start! >= s - 0.05 && (f.end ?? f.start!) <= e + 0.05);
      const absorbed = flags.slice(firstPictureFlag).filter(inFlash).length;
      flags.splice(
        firstPictureFlag,
        flags.length - firstPictureFlag,
        ...flags.slice(firstPictureFlag).filter((f) => !inFlash(f)),
      );
      for (const [s, e] of spans)
        flags.push({
          severity: "error",
          what: `Rapid flashing: more than 3 flashes per second (photosensitive seizure risk)${absorbed ? `; includes ${absorbed} black-frame/jump flags` : ""}.`,
          start: s,
          end: e,
          fix: "Slow the strobing to <= 3 per second, reduce the brightness difference, or shrink the flashing area.",
        });

      const last = [...frames].reverse().find((f) => f.m["lavfi.cropdetect.w"] !== undefined);
      if (last) {
        const cw = Number(last.m["lavfi.cropdetect.w"]);
        const ch = Number(last.m["lavfi.cropdetect.h"]);
        const pw = 480;
        const ph = Math.round((480 * v.height) / v.width / 2) * 2;
        if (cw < pw * T.letterbox || ch < ph * T.letterbox) {
          const sx = v.width / pw;
          const sy = v.height / ph;
          flags.push({
            severity: "warn",
            what: `Letterbox/pillarbox bars: active picture ~${Math.round(cw * sx)}x${Math.round(ch * sy)} of ${v.width}x${v.height} (offset ${Math.round(Number(last.m["lavfi.cropdetect.x"]) * sx)},${Math.round(Number(last.m["lavfi.cropdetect.y"]) * sy)}).`,
            fix: "Intended (cinematic bars)? Otherwise reframe/scale to fill, or crop. Verify visually: dark edges in the picture can trigger this.",
          });
        }
      }
      lines.push(
        cuts.length
          ? `Cuts (${cuts.length}): ${cuts
              .slice(0, 60)
              .map((c) => c.toFixed(2))
              .join(
                ", ",
              )}${cuts.length > 60 ? ", …" : ""} — average shot ${(dur / (cuts.length + 1)).toFixed(2)}s.`
          : "Cuts: none (single shot).",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (v) {
    // Join stalls at continuing cuts, source upscale from the recipe, subject cut-off, UI zones and reading time.
    const recipe = opts.recipe;
    const cutTimes = [...opts.cuts, ...(recipe ? recipeCuts(recipe) : [])];
    try {
      await joinChecks(src, cutTimes, dur, flags, lines);
    } catch (error) {
      flags.push({
        severity: "info",
        what: `Join motion not measured: ${String((error as { stderr?: string }).stderr ?? error).slice(-200)}`,
      });
    }
    const specs = opts.sources.length
      ? opts.sources
      : recipe
        ? recipeSources(recipe, { w: v.width, h: v.height })
        : [];
    try {
      await sourceScaleCheck(specs, flags, lines);
    } catch {
      // best effort
    }
    try {
      await visionChecks(
        {
          src,
          dur,
          still: false,
          width: v.width,
          height: v.height,
          fps: v.avgFps || v.fps,
          platform: name,
          samples: opts.samples,
          edgeMargin: opts.edgeMargin,
          readText: opts.readText,
          hasRecipeText: !!recipe?.text.length,
          save: opts.save,
        },
        flags,
        lines,
      );
    } catch (error) {
      flags.push({
        severity: "info",
        what: `Frame-edge / safe-area / reading-time checks not measured: ${String((error as { stderr?: string }).stderr ?? error).slice(-200)}`,
      });
    }
  }
  if (v) {
    // Cheap pixel checks: a first frame at another scale, and upscaled (soft) sources.
    try {
      await firstFrameCheck(src, { w: v.width, h: v.height }, flags);
      await upscaleCheck(src, { w: v.width, h: v.height }, dur * 0.4, flags, lines);
    } catch {
      // best effort
    }
  }
  return { stats: lines.join("\n"), flags };
}

/** Grabs frames at given times and tiles them into a sheet (base64 jpg). */
async function frameSheet(
  src: string,
  times: number[],
  cellW = 360,
  columns = 4,
  aspect = 16 / 9,
): Promise<string | undefined> {
  if (!times.length) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "oh-qa-sheet-"));
  try {
    const cellH = Math.min(cellW * 2, Math.round(cellW / aspect / 2) * 2);
    let n = 0;
    for (const t of times) {
      try {
        // No -ss for t=0: seeking a single JPEG (even to 0) outputs nothing.
        await run("ffmpeg", [
          "-v",
          "error",
          ...(t > 0 ? ["-ss", t.toFixed(3)] : []),
          "-i",
          src,
          "-frames:v",
          "1",
          "-vf",
          `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x303030`,
          join(dir, `c${String(n).padStart(3, "0")}.png`),
        ]);
        n++;
      } catch {
        // frame not decodable at that time; skip
      }
    }
    if (!n) return undefined;
    const cols = Math.min(columns, n);
    const sheet = join(dir, "sheet.jpg");
    await run("ffmpeg", [
      "-v",
      "error",
      "-framerate",
      "1",
      "-i",
      join(dir, "c%03d.png"),
      "-vf",
      `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=0xff00ff`,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      sheet,
    ]);
    return readFileSync(sheet).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Measured checks on decoded pixels (flicker, loop seam, first frame, upscale).
// ---------------------------------------------------------------------------------------------
const RED: RGB = [255, 40, 40];

/** Per-cell mean absolute luma difference of two frames (grid cols x rows). */
function cellDiff(
  a: Uint8Array,
  b: Uint8Array,
  w: number,
  h: number,
  cols: number,
  rows: number,
): Float32Array {
  const sums = new Float32Array(cols * rows);
  const counts = new Float32Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / h)) * cols;
    for (let x = 0; x < w; x++) {
      const c = r + Math.min(cols - 1, Math.floor((x * cols) / w));
      sums[c]! += Math.abs(a[y * w + x]! - b[y * w + x]!);
      counts[c]! += 1;
    }
  }
  for (let i = 0; i < sums.length; i++) sums[i] = sums[i]! / (counts[i] || 1);
  return sums;
}

const SENSITIVITY = {
  low: { thr: 32, ratio: 0.3 },
  medium: { thr: 18, ratio: 0.4 },
  high: { thr: 10, ratio: 0.5 },
};

interface Glitch {
  frame: number; // first glitched frame
  length: 1 | 2;
  cells: number[];
  score: number; // luma units: how much the glitch stands out above the before/after difference
  strip?: Uint8Array[]; // RGB before, glitch, after
}

function regionText(cells: number[], cols: number, rows: number) {
  const xs = cells.map((c) => c % cols);
  const ys = cells.map((c) => Math.floor(c / cols));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs) + 1;
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys) + 1;
  if (cells.length >= cols * rows * 0.8) return "whole frame";
  const v = (y0 + y1) / 2 / rows;
  const hz = (x0 + x1) / 2 / cols;
  const name =
    `${v < 0.34 ? "top" : v > 0.66 ? "bottom" : "middle"}-${hz < 0.34 ? "left" : hz > 0.66 ? "right" : "centre"}`.replace(
      "middle-centre",
      "centre",
    );
  return `${name} (x ${Math.round((100 * x0) / cols)}-${Math.round((100 * x1) / cols)}%, y ${Math.round((100 * y0) / rows)}-${Math.round((100 * y1) / rows)}%, ${cells.length}/${cols * rows} cells)`;
}

/** Finds 1-2 frame transient glitches: frame(s) unlike both neighbours while the neighbours match. */
async function findGlitches(
  src: string,
  size: { w: number; h: number },
  sens: keyof typeof SENSITIVITY,
) {
  const { w, h } = fitWidth(size, 320);
  const cols = 8;
  const rows = Math.max(4, Math.min(16, Math.round((cols * h) / w)));
  const { thr, ratio } = SENSITIVITY[sens];
  const ring: { rgb: Uint8Array; y: Uint8Array }[] = [];
  const d1: Float32Array[] = []; // d1[k] = diff(frame k-1, frame k), last 3 kept
  const glitches: Glitch[] = [];
  const keep = 6;
  const check = (
    frame: number,
    length: 1 | 2,
    a: Float32Array,
    b: Float32Array,
    c: Float32Array,
    strip: () => Uint8Array[],
  ) => {
    const cells: number[] = [];
    let score = 0;
    for (let i = 0; i < a.length; i++) {
      const m = Math.min(a[i]!, b[i]!);
      if (m >= thr && c[i]! <= ratio * m) {
        cells.push(i);
        score = Math.max(score, m - c[i]!);
      }
    }
    if (!cells.length) return;
    const g: Glitch = { frame, length, cells, score };
    glitches.push(g);
    // Keep pixels only for the strongest few (memory stays flat on long videos).
    const ranked = glitches.filter((x) => x.strip).sort((p, q) => q.score - p.score);
    if (ranked.length < keep || score > ranked[keep - 1]!.score) {
      g.strip = strip();
      if (ranked.length >= keep) delete ranked[keep - 1]!.strip;
    }
  };
  const frames = await streamFrames(src, w, h, (rgb, i) => {
    const y = luma({ w, h, data: rgb });
    ring.push({ rgb, y });
    if (ring.length > 4) ring.shift();
    if (i === 0) return;
    const n = ring.length;
    d1.push(cellDiff(ring[n - 2]!.y, y, w, h, cols, rows));
    if (d1.length > 3) d1.shift();
    const k = d1.length;
    if (n >= 3 && k >= 2) {
      const r = ring.slice(-3);
      check(i - 1, 1, d1[k - 2]!, d1[k - 1]!, cellDiff(r[0]!.y, r[2]!.y, w, h, cols, rows), () =>
        r.map((f) => f.rgb),
      );
    }
    if (n >= 4 && k >= 3) {
      const r = ring.slice(-4);
      const already = glitches
        .slice(-3)
        .some((g) => g.frame >= i - 2 && g.frame <= i - 1 && g.length === 1);
      if (!already)
        check(
          i - 2,
          2,
          d1[k - 3]!,
          d1[k - 1]!,
          cellDiff(r[0]!.y, r[3]!.y, w, h, cols, rows),
          () => [r[0]!.rgb, r[1]!.rgb, r[3]!.rgb],
        );
    }
  });
  return { glitches, frames, w, h, cols, rows };
}

/** before / flagged / after rows for the given glitches, flagged cells boxed in red. */
function glitchStrip(
  items: { g: Glitch; t: number }[],
  w: number,
  h: number,
  cols: number,
  rows: number,
): Img {
  const cells: Img[] = [];
  for (const { g, t } of items) {
    const labels = [
      `${fmt(t)} BEFORE f${g.frame - 1}`,
      `${g.length === 2 ? "2-FRAME " : ""}GLITCH f${g.frame}`,
      `AFTER f${g.frame + g.length}`,
    ];
    g.strip!.forEach((data, k) => {
      const img: Img = { w, h, data: new Uint8Array(data) };
      for (const c of g.cells) {
        const cx = c % cols;
        const cy = Math.floor(c / cols);
        drawRect(
          img,
          (cx * w) / cols,
          (cy * h) / rows,
          ((cx + 1) * w) / cols,
          ((cy + 1) * h) / rows,
          RED,
          k === 1 ? 2 : 1,
        );
      }
      drawText(img, 2, 2, labels[k]!, k === 1 ? [255, 120, 120] : [255, 255, 255], 1);
      cells.push(img);
    });
  }
  return grid(cells, 3, w, h, 4, [255, 255, 255]);
}

/** First frame vs the rest: a different picture, or the same picture at another scale/aspect. */
async function firstFrameCheck(src: string, size: { w: number; h: number }, flags: Flag[]) {
  const { w, h } = fitWidth(size, 192);
  const f: Uint8Array[] = [];
  await streamFrames(src, w, h, (y) => void f.push(y), { gray: true, maxFrames: 4 });
  if (f.length < 4) return;
  const d01 = mad(f[0]!, f[1]!);
  const rest = Math.max(mad(f[1]!, f[2]!), mad(f[2]!, f[3]!));
  if (d01 < Math.max(6, 3 * rest)) return;
  // Try resampling frame 0 around the centre: does a scale make it match frame 1?
  const sample = (img: Uint8Array, x: number, y: number) => {
    const xi = Math.min(w - 2, Math.max(0, Math.floor(x)));
    const yi = Math.min(h - 2, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - xi));
    const fy = Math.min(1, Math.max(0, y - yi));
    const p = img[yi * w + xi]! * (1 - fx) + img[yi * w + xi + 1]! * fx;
    const q = img[(yi + 1) * w + xi]! * (1 - fx) + img[(yi + 1) * w + xi + 1]! * fx;
    return p * (1 - fy) + q * fy;
  };
  const err = (sx: number, sy: number) => {
    let s = 0;
    let n = 0;
    for (let y = Math.round(h * 0.15); y < h * 0.85; y++)
      for (let x = Math.round(w * 0.15); x < w * 0.85; x++) {
        s += Math.abs(
          f[1]![y * w + x]! - sample(f[0]!, w / 2 + (x - w / 2) / sx, h / 2 + (y - h / 2) / sy),
        );
        n++;
      }
    return s / n;
  };
  const base = err(1, 1);
  let best = { sx: 1, sy: 1, e: base };
  const steps = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.18, 1.25, 1.33, 1.42];
  for (const sx of steps)
    for (const sy of steps) {
      const e = err(sx, sy);
      if (e < best.e) best = { sx, sy, e };
    }
  const coarse = best;
  for (let dx = -0.04; dx <= 0.041; dx += 0.01)
    for (let dy = -0.04; dy <= 0.041; dy += 0.01) {
      const e = err(coarse.sx + dx, coarse.sy + dy);
      if (e < best.e) best = { sx: coarse.sx + dx, sy: coarse.sy + dy, e };
    }
  // err() samples frame 0 at 1/s, so frame 0's content is magnified by 1/s.
  const zx = Math.round(100 / best.sx);
  const zy = Math.round(100 / best.sy);
  if ((Math.abs(zx - 100) > 2 || Math.abs(zy - 100) > 2) && best.e < 0.6 * base) {
    const what =
      Math.abs(zx - zy) > 3
        ? `stretched (content ${zx}% wide, ${zy}% tall vs the next frames)`
        : `scaled (content ${zx}% vs the next frames)`;
    flags.push({
      severity: "warn",
      what: `First frame is ${what}: a one-frame size jump at the start.`,
      start: 0,
      fix: "Drop the first frame (-vf trim=start_frame=1,setpts=PTS-STARTPTS) or re-export it at the clip's scale; common with AI-video first-frame conditioning and image-to-video starts.",
    });
  } else
    flags.push({
      severity: "warn",
      what: `First frame differs from the rest (mean change ${d01.toFixed(0)}/255 vs ${rest.toFixed(1)} between the next frames): leftover/flash frame.`,
      start: 0,
      fix: "Trim it (-vf trim=start_frame=1,setpts=PTS-STARTPTS) unless it is an intended flash.",
    });
}

/** Effective detail: how much fine detail survives a 2x and 4x down/up round trip. */
async function upscaleCheck(
  src: string,
  size: { w: number; h: number },
  at: number | undefined,
  flags: Flag[],
  lines: string[],
) {
  if (size.w < 640) return;
  const w = Math.min(size.w, 3840);
  const { h } = fitWidth(size, w);
  const seek = at !== undefined ? ["-ss", at.toFixed(3)] : [];
  const grab = async (k: number) => {
    let out: Uint8Array | undefined;
    const filter =
      k > 1
        ? `scale=${w}:${h}:flags=area,scale=trunc(iw/${k}/2)*2:trunc(ih/${k}/2)*2:flags=area,scale=${w}:${h}:flags=lanczos`
        : `scale=${w}:${h}:flags=area`;
    await streamFrames(src, w, h, (y) => ((out = y), false), {
      gray: true,
      maxFrames: 1,
      inputArgs: seek,
      filter,
    });
    if (!out) throw new Error("no frame");
    return out;
  };
  const [g, g2, g4] = await Promise.all([grab(1), grab(2), grab(4)]);
  const e2 = mad(g, g2);
  const e4 = mad(g, g4);
  if (e4 < 1.2) return; // too flat to judge
  const r = e2 / e4;
  lines.push(
    `Detail: ${r.toFixed(2)} of the fine detail lives above half resolution (2x/4x round-trip error ${e2.toFixed(2)}/${e4.toFixed(2)}; native photos/renders ~0.4+, 2x upscales below ~0.3).`,
  );
  if (r < 0.3)
    flags.push({
      severity: "warn",
      what: `Looks upscaled: almost no detail above ~${Math.round(size.w / 2)}x${Math.round(size.h / 2)} (detail ratio ${r.toFixed(2)}). Soft on large screens.`,
      fix: "Render/generate at the delivery resolution, or use a detail-adding upscaler (AI upscale) instead of a plain resize; check that nothing in the chain scaled down and back up.",
    });
  else if (r < 0.36)
    flags.push({
      severity: "info",
      what: `Soft picture: little detail at full resolution (detail ratio ${r.toFixed(2)}); possibly upscaled or heavily denoised/compressed.`,
      fix: "Fine for soft looks; otherwise raise render resolution/bitrate or reduce denoise/blur.",
    });
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** SSIM (All) between two image files via ffmpeg's ssim filter. */
async function ssim(a: string, b: string): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    a,
    "-i",
    b,
    "-lavfi",
    "[0:v]format=yuv420p[x];[1:v]format=yuv420p[y];[x][y]ssim",
    "-f",
    "null",
    "-",
  ]);
  return Number(/All:([\d.]+)/.exec(stderr)?.[1] ?? Number.NaN);
}

interface LoopResult {
  verdict: "seamless" | "near-seamless" | "duplicate-frame" | "hitch" | "jump";
  lines: string[];
  advice: string[];
  strip: Img;
}

async function loopCheck(src: string, info: Probe): Promise<LoopResult> {
  const { w, h } = fitWidth({ w: info.video!.width, h: info.video!.height }, 320);
  const head: { rgb: Uint8Array; y: Uint8Array }[] = [];
  const tail: { rgb: Uint8Array; y: Uint8Array }[] = [];
  const step1: number[] = [];
  const step2: number[] = [];
  const total = await streamFrames(src, w, h, (rgb) => {
    const fr = { rgb, y: luma({ w, h, data: rgb }) };
    if (head.length < 3) head.push(fr);
    if (tail.length) step1.push(mad(tail[tail.length - 1]!.y, fr.y));
    if (tail.length >= 2) step2.push(mad(tail[tail.length - 2]!.y, fr.y));
    tail.push(fr);
    if (tail.length > 3) tail.shift();
  });
  if (total < 6) throw new Error(`Only ${total} frames; need at least 6 for a loop check.`);
  const [F0, F1] = head;
  const L1 = tail[tail.length - 1]!;
  const L2 = tail[tail.length - 2]!;
  const typ1 = median(step1);
  const typ2 = median(step2);
  const seam = mad(L1.y, F0!.y);
  const seam2 = (mad(L2.y, F0!.y) + mad(L1.y, F1!.y)) / 2;
  const speedEnd = (step1.at(-1)! + step1.at(-2)!) / 2;
  const speedStart = (step1[0]! + step1[1]!) / 2;

  // SSIM on full-resolution first/second/last frames.
  const dir = mkdtempSync(join(tmpdir(), "oh-loop-"));
  let ssimSeam = Number.NaN;
  let ssimStep = Number.NaN;
  try {
    const first = join(dir, "first.png");
    const second = join(dir, "second.png");
    const last = join(dir, "last.png");
    await run("ffmpeg", ["-v", "error", "-i", src, "-frames:v", "1", first]);
    await run("ffmpeg", [
      "-v",
      "error",
      "-i",
      src,
      "-vf",
      "select=eq(n\\,1)",
      "-frames:v",
      "1",
      second,
    ]);
    await run("ffmpeg", ["-v", "error", "-sseof", "-2", "-i", src, "-update", "1", last]);
    ssimSeam = await ssim(last, first);
    ssimStep = await ssim(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const moving = typ1 > 0.6;
  const jumpRatio = moving ? seam / typ1 : seam;
  const flowRatio = typ2 > 0.6 ? seam2 / typ2 : 1;
  let verdict: LoopResult["verdict"];
  const advice: string[] = [];
  if (moving && seam < Math.max(0.35, 0.15 * typ1)) {
    verdict = "duplicate-frame";
    advice.push(
      "The last frame repeats the first, so the loop holds one frame (a visible hiccup). Drop the last frame: -vf trim=end_frame=<frames-1>, or in Blender set frame_end to cycle_end - 1.",
    );
  } else if (!moving ? seam <= 1.5 : jumpRatio <= 1.8 && flowRatio >= 0.55 && flowRatio <= 1.8) {
    verdict = jumpRatio <= 1.3 ? "seamless" : "near-seamless";
  } else if (moving && jumpRatio <= 2.5 && (flowRatio < 0.55 || flowRatio > 1.8)) {
    verdict = "hitch";
    advice.push(
      flowRatio < 0.55
        ? "Motion stalls or reverses across the seam (the frames on either side are closer than normal): ping-pong or eased loop ends. Use linear/cyclic interpolation (Blender: Cycles F-curve modifier, Extrapolation=Cyclic) and keep velocity constant through the loop point."
        : "Motion speeds up across the seam: the cycle is cut slightly too long/short. Trim the clip to an exact period (find the frame most similar to frame 0 and end one frame before it).",
    );
  } else {
    verdict = "jump";
    advice.push(
      "Visible jump at the loop point. Fixes, cheapest first: (1) end on the frame most similar to the first (try trimming a few frames off the end and re-run loop_check); (2) cross-fade the tail into the head: take the last 0.5-1 s, xfade it over the first 0.5-1 s and cut the head off (ffmpeg: split, trim, xfade=transition=fade); (3) rebuild the animation as a true cycle (Blender: same pose/camera on first and last+1 frame, cyclic F-curves; noise/turbulence driven by a looping phase such as sin/cos of time; AI video: first and last frame conditioning with the same image).",
    );
  }
  if (moving && speedEnd < 0.4 * typ1 && speedStart < 0.4 * typ1 && verdict !== "jump")
    advice.push(
      "Motion eases to a stop at both ends; the loop will pulse (slow-fast-slow) every cycle. Use linear interpolation at the loop ends.",
    );

  const lines = [
    `Frames ${total}, typical frame-to-frame change ${typ1.toFixed(2)}/255 (${moving ? "moving" : "near static"}).`,
    `Seam (last -> first): change ${seam.toFixed(2)} = ${moving ? `${jumpRatio.toFixed(2)}x a normal step` : "static clip"}; 2-step continuity ${flowRatio.toFixed(2)}x normal (1.0 = motion carries through).`,
    `SSIM last vs first ${ssimSeam.toFixed(4)} (first vs second frame ${ssimStep.toFixed(4)} for comparison; a seamless loop scores about the same, 1.0000 means a duplicated frame).`,
    `Speed at the ends: start ${speedStart.toFixed(2)}, end ${speedEnd.toFixed(2)} (typical ${typ1.toFixed(2)}).`,
  ];
  const cells = [L2, L1, F0!, F1!].map((f, i) => {
    const img: Img = { w, h, data: new Uint8Array(f.rgb) };
    drawText(
      img,
      2,
      2,
      ["LAST-1", "LAST", "FIRST (LOOP)", "FIRST+1"][i]!,
      i === 2 ? [120, 255, 120] : [255, 255, 255],
      1,
    );
    return img;
  });
  return { verdict, lines, advice, strip: grid(cells, 4, w, h, 4, [255, 255, 255]) };
}

// ---------------------------------------------------------------------------------------------
// Take ledger
// ---------------------------------------------------------------------------------------------
interface Take {
  id: string;
  file: string;
  note?: string;
  score?: number;
  added: string;
}
interface Ledger {
  picked?: string;
  takes: Take[];
}
const ledgerPath = () => join(project(), "takes", "ledger.json");
function readLedger(): Ledger {
  try {
    return JSON.parse(readFileSync(ledgerPath(), "utf8")) as Ledger;
  } catch {
    return { takes: [] };
  }
}
function writeLedger(l: Ledger) {
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  writeFileSync(ledgerPath(), `${JSON.stringify(l, null, 2)}\n`);
}
const rel = (p: string) => {
  const r = relative(project(), abs(p));
  return r.startsWith("..") ? abs(p) : r;
};
const findTake = (l: Ledger, ref: string) =>
  l.takes.find((t) => t.id === ref) ?? l.takes.find((t) => t.file === rel(ref));
const describeTake = (t: Take, l: Ledger) =>
  `${t.id}${l.picked === t.id ? " [PICKED]" : ""} | ${t.score !== undefined ? `score ${t.score}` : "unscored"} | ${t.file} | ${t.note ?? ""}`;

// ---------------------------------------------------------------------------------------------
// House style + preferences
// ---------------------------------------------------------------------------------------------
const globalHome = () => join(homedir(), ".open-herness");
const stylePath = (scope: "project" | "global") =>
  scope === "global"
    ? join(globalHome(), "house-style.md")
    : join(project(), ".open-herness", "house-style.md");
const readRules = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim().startsWith("- "))
    : [];
const ruleText = (line: string) =>
  line
    .replace(/^\s*-\s+/, "")
    .replace(/\s+\(why:.*\)\s*$/, "")
    .replace(/\s+\(added [\d-]+\)\s*$/, "")
    .trim();
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function writeRules(file: string, rules: string[]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rules.length ? `${rules.join("\n")}\n` : "");
}

/** Boundary / flash section of media_flicker: cuts, reversing flashes, stills and recipe timing. */
async function boundarySection(
  src: string,
  info: Probe,
  fps: number,
  givenCuts: number[],
  outputDir: string | undefined,
  fullRes: boolean,
): Promise<string[]> {
  const lines: string[] = [""];
  try {
    const v = info.video!;
    const explicit = outputDir ? abs(outputDir) : undefined;
    if (explicit && existsSync(explicit))
      return [
        `\nBoundary stills skipped: output_dir already exists (${explicit}); evidence is never overwritten.`,
      ];
    const res = await analyzeBoundaries(src, { w: v.width, h: v.height }, fps, fullRes);
    const recipe = readRecipe(src);
    const recipeCutTimes = recipe ? recipeCuts(recipe) : [];
    const cutsDetected = res.detected.filter((b) => b.kind === "cut" || b.kind === "change");
    lines.push(
      `Boundary pass (${res.fullRes ? "native luma" : "320 px RGB"}, ${res.w}x${res.h}): ${cutsDetected.filter((b) => b.kind === "cut").length} cut(s), ${cutsDetected.filter((b) => b.kind === "change").length} overlay/picture change(s), ${res.flashes.length} reversing flash(es).`,
    );
    for (const f of res.flashes.slice(0, 20))
      lines.push(
        `- flash @${fmt(f.time)} frame ${f.frame}${f.length === 2 ? `-${f.frame + 1} (2 frames)` : ""}: picture jumps away and back in ${f.cells} cell(s), score ${f.score.toFixed(2)}. fix: remove or replace the stray frame(s) (duplicate the previous frame, or trim around it); if the flash is intentional, ignore it.`,
      );
    if (res.flashes.length > 20) lines.push(`… ${res.flashes.length - 20} more`);
    const extra: Boundary[] = [...givenCuts, ...recipeCutTimes].map((t) => ({
      frame: Math.round(t * fps),
      time: Math.round(t * fps) / fps,
      kind: "input" as const,
    }));
    for (const o of [...(recipe?.text ?? []), ...(recipe?.logos ?? [])])
      for (const t of [o.start, o.end])
        if (t !== undefined)
          extra.push({
            frame: Math.round(t * fps),
            time: Math.round(t * fps) / fps,
            kind: "overlay",
          });
    const all = [...res.detected, ...extra].sort(
      (a, b) => a.frame - b.frame || a.kind.localeCompare(b.kind),
    );
    const uniq = all.filter((b, i) => i === 0 || b.frame !== all[i - 1]!.frame);
    const want = explicit !== undefined || givenCuts.length > 0 || !!recipe;
    if (want) {
      let dir = explicit;
      if (!dir) {
        const base = join(
          project(),
          "takes",
          "qa",
          `${basename(src, extname(src))
            .replace(/[^\w-]+/g, "-")
            .slice(0, 40)}-boundaries`,
        );
        dir = base;
        for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
      }
      const made = await writeBoundaryStills(src, uniq, dir, fps, Math.max(0, res.frames - 1));
      lines.push(
        `Boundary stills: ${uniq.length} boundar${uniq.length === 1 ? "y" : "ies"}, ${made.files} JPEG(s) at frames -2..+2${made.capped ? " (capped at 2000)" : ""} in ${rel(dir)} (boundaries.json lists them). Review them for pops, doubled frames and misaligned overlays.`,
      );
    } else
      lines.push(
        "Boundary stills: pass cuts[] or output_dir (or keep a <file>.edit.json recipe next to the file) to save frames -2..+2 around every boundary.",
      );
    if (recipe)
      for (const f of recipeTiming(recipe, fps, [
        ...recipeCutTimes,
        ...cutsDetected.map((b) => b.time),
      ]))
        lines.push(`- timing @${fmt(f.time)}: ${f.what} fix: ${f.fix}`);
  } catch (error) {
    lines.push(
      `Boundary pass failed: ${String((error as { stderr?: string }).stderr ?? error).slice(-300)}`,
    );
  }
  return lines;
}

export function registerQualityTools(server: McpServer) {
  server.registerTool(
    "media_review",
    {
      description: `Deterministic QA of a finished video, audio or still image. Run it on every final render/export before presenting, and fix errors/warnings first. Returns flags with timestamps, severity and a suggested fix, plus a contact sheet of the flagged moments.
Video/audio checks: duration (vs expected_duration, ±max(0.5s,5%)), resolution/aspect/fps/VFR/pixel format vs platform, audio present, integrated loudness + true peak (EBU R128; platform target -14 LUFS ±2, true peak ≤ -1 dBTP, > 0 = clipping), silent spans ≥ ${T.silenceMinSec}s below ${T.silenceDb} dB, black spans ≥ ${T.blackMinSec}s (pixels < ${T.blackPixel * 100}% luma; ≥0.5s mid-video = error), frozen picture ≥ ${T.freezeMinSec}s, scene cuts (scdet ≥ ${T.sceneScore}), brightness jumps ≥ ${T.cutJump}/255 at cuts, rapid flashing (> 3 flashes in 1s = photosensitivity error), letterbox/pillarbox bars (active picture < ${T.letterbox * 100}%), first frame at a different scale/aspect or a different picture than the rest, upscaled/soft source (fine-detail ratio < 0.3 = warn, < 0.36 = info). Measured extras (every flag has a fix): audio noise floor (10th percentile of momentary loudness after 0.4 s, needs >= 10 samples), quiet tail (last momentary sample within 20 LU of integrated; tail >= 2 s and >= 1/5 of the piece), and with audio_source (the raw take) noise floor raised > ${X.noiseRiseDb} dB / crushed dynamics; joinMotion at hard cuts (cuts[] or the <file>.edit.json recipe sidecar: motion across the join < 0.4 of the slower neighbouring clip = stall; jump > 4 = a real cut, never flagged); decoded frame count (< 50% of duration x fps = error; < 5 fps = sparse note); source upscale (sources[] or recipe: shown > 1.5x native, x1.08 with zoom); subject cut off by the frame edge (8 samples, border-colour background, neck/base split, edge_margin px); text inside the shorts/tiktok/reels UI zones and on-screen text reading time max(1.5, cjk/4.5 + latin/15 + 1.5) s (OCR via Apple Vision or tesseract; without OCR the zones are reported geometrically and OCR is marked not measured). Evidence stills go to output_dir (default takes/qa/<name>-review). Result says passed (no error/warn). For 1-2 frame glitches and boundary flashes/stills run media_flicker; for loops run loop_check.
Still checks: frame-edge cut-off and safe-area zones (platform given), resolution/aspect vs platform, upscaled/soft source, mean luma (< 50 dark, > 205 bright), low contrast (10-90% luma spread < 60 and min-max range < 160), clipped highlights > 5%, crushed shadows > 10%.
Platforms: youtube 1920x1080 16:9; shorts/reels 1080x1920 9:16 ≤ 180s; tiktok 1080x1920 9:16 ≤ 600s; square 1080x1080.`,
      inputSchema: {
        path: z.string(),
        platform: z.enum(["youtube", "shorts", "tiktok", "reels", "square"]).optional(),
        expected_duration: z
          .number()
          .positive()
          .optional()
          .describe("Seconds the piece should last"),
        tolerance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Duration tolerance as a fraction of expected_duration (default 0.05; never below 0.5 s)",
          ),
        audio_source: z
          .string()
          .optional()
          .describe(
            "The raw, unprocessed take of the same audio: flags a raised noise floor or crushed dynamics",
          ),
        cuts: z
          .array(z.number().min(0))
          .max(200)
          .optional()
          .describe(
            "Times (s) of hard cuts between clips that should read as ONE continuing shot, to check for motion stalls; read from <file>.edit.json when present",
          ),
        sources: z
          .array(
            z.object({
              path: z.string(),
              shown_width: z.number().positive(),
              shown_height: z.number().positive(),
              fit: z.enum(["cover", "contain"]).optional(),
              zoom: z.boolean().optional(),
            }),
          )
          .max(96)
          .optional()
          .describe(
            "Source clips/images and the size they are shown at, to check upscaling (for renders without a recipe sidecar)",
          ),
        output_dir: z
          .string()
          .optional()
          .describe(
            "Directory for evidence stills (must not exist yet; default takes/qa/<name>-review)",
          ),
        samples: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe("Frames sampled for the frame-edge and safe-area checks (default 8)"),
        edge_margin: z
          .number()
          .min(0)
          .max(64)
          .optional()
          .describe(
            "Pixels from the frame edge that count as cut off, at output resolution (default 4)",
          ),
        read_text: z
          .boolean()
          .optional()
          .describe(
            "Force (true) or skip (false) the on-screen text reading-time check; default: only when text is detected",
          ),
      },
    },
    async ({
      path,
      platform,
      expected_duration,
      tolerance,
      audio_source,
      cuts,
      sources,
      output_dir,
      samples,
      edge_margin,
      read_text,
    }) => {
      const src = abs(path);
      if (!existsSync(src)) return fail(`File not found: ${src}`);
      const explicit = output_dir ? abs(output_dir) : undefined;
      if (explicit && existsSync(explicit))
        return fail(
          `output_dir already exists: ${explicit}. Pick a new directory; evidence is never overwritten.`,
        );
      let stillDir: string | undefined;
      const save = async (img: Img, name: string) => {
        if (!stillDir) {
          stillDir = explicit;
          if (!stillDir) {
            const base = join(
              project(),
              "takes",
              "qa",
              `${basename(src, extname(src))
                .replace(/[^\w-]+/g, "-")
                .slice(0, 40)}-review`,
            );
            stillDir = base;
            for (let n = 2; existsSync(stillDir); n++) stillDir = `${base}-${n}`;
          }
          mkdirSync(stillDir, { recursive: true });
        }
        const file = join(stillDir, `${name.replace(/[^\w.-]+/g, "-")}.jpg`);
        await writeJpeg(img, file);
        return rel(file);
      };
      try {
        const info = await probe(src);
        const preset = platform ? PLATFORMS[platform] : undefined;
        const still = isStill(info);
        const opts: ReviewOpts = {
          audioSource: audio_source ? abs(audio_source) : undefined,
          cuts: cuts ?? [],
          sources: (sources ?? []).map((s) => ({ ...s, path: abs(s.path) })),
          samples: samples ?? 8,
          edgeMargin: edge_margin ?? 4,
          tolerance: tolerance ?? T.durationTolerance,
          readText: read_text,
          recipe: readRecipe(src),
          save,
        };
        const { stats, flags } = still
          ? await reviewStill(src, info, preset, platform, opts)
          : await reviewVideo(src, info, preset, platform, opts, expected_duration);
        const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
        flags.sort(
          (a, b) => order[a.severity] - order[b.severity] || (a.start ?? -1) - (b.start ?? -1),
        );
        const counts = (["error", "warn", "info"] as Severity[])
          .map((s) => `${flags.filter((f) => f.severity === s).length} ${s}`)
          .join(", ");
        const shown = flags.slice(0, 40);
        const flagLines = shown.map(
          (f, i) =>
            `${i + 1}. [${f.severity.toUpperCase()}]${f.start !== undefined ? ` @${fmt(f.start)}${f.end !== undefined ? `-${fmt(f.end)}` : ""}` : ""} ${f.what}${f.fix ? `\n   fix: ${f.fix}` : ""}`,
        );
        if (flags.length > shown.length) flagLines.push(`… ${flags.length - shown.length} more`);
        const passed = !flags.some((f) => f.severity === "error" || f.severity === "warn");
        const lines = [
          `media_review ${rel(src)}${platform ? ` for ${platform}` : ""}: ${passed ? "PASSED" : "NOT PASSED"} (passed: ${passed}); ${counts}.`,
          stats,
          "",
          flags.length ? "Flags:" : "No issues found.",
          ...flagLines,
        ];
        if (stillDir) lines.push("", `Evidence stills saved in ${rel(stillDir)}.`);
        if (
          platform &&
          SAFE_ZONES[platform] &&
          !flags.some((f) => /safe-area|UI zone/i.test(f.what)) &&
          !stats.includes("Safe area")
        )
          lines.push(
            "",
            `Safe-area zones (${platform}, px of 1080x1920): top ${SAFE_ZONES[platform]!.top}, bottom ${SAFE_ZONES[platform]!.bottom}, left ${SAFE_ZONES[platform]!.left}, right ${SAFE_ZONES[platform]!.right}; text inside them is not measured here.`,
          );

        const content: Content[] = [];
        if (still) {
          const preview = await frameSheet(
            src,
            [0],
            480,
            1,
            info.video!.width / info.video!.height,
          );
          content.push({ type: "text", text: lines.join("\n") });
          if (preview) content.push({ type: "image", data: preview, mimeType: "image/jpeg" });
          return { content };
        }
        // Contact sheet: one frame per flagged moment (span midpoint), else an overview.
        const times: { t: number; label: string }[] = [];
        flags.forEach((f, i) => {
          if (f.start === undefined || !info.video) return;
          const t = Math.min(
            Math.max(0, f.end !== undefined ? (f.start + f.end) / 2 : f.start + 0.02),
            Math.max(0, info.duration - 0.05),
          );
          if (times.length < 12 && !times.some((x) => Math.abs(x.t - t) < 0.2))
            times.push({ t, label: `flag ${i + 1}` });
        });
        if (!times.length && info.video)
          for (let k = 0; k < 8; k++)
            times.push({ t: ((k + 0.5) * info.duration) / 8, label: "overview" });
        const sheet = info.video
          ? await frameSheet(
              src,
              times.map((x) => x.t),
              360,
              4,
              info.video.width / info.video.height,
            )
          : undefined;
        if (sheet)
          lines.push(
            "",
            `Contact sheet (left to right, top to bottom): ${times.map((x, i) => `${i + 1}=${fmt(x.t)} ${x.label}`).join("; ")}`,
          );
        content.push({ type: "text", text: lines.join("\n") });
        if (sheet) content.push({ type: "image", data: sheet, mimeType: "image/jpeg" });
        return { content };
      } catch (error) {
        return fail(
          `media_review failed: ${(error as { stderr?: string }).stderr?.slice(-1500) ?? String(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "media_flicker",
    {
      description: `Find 1-2 frame transient glitches in a video: frames that differ strongly from both neighbours while the neighbours match each other (A-B-A pops, single bad frames from AI video or broken renders, texture/light popping, flash frames). Measured per grid cell on a 320 px proxy, so local pops are found too; steady motion, pans and cuts are ignored. Returns times, frame numbers, regions, scores (luma units the glitch stands out) and a strip image (before / glitch / after, flagged cells boxed in red) of the worst ones. Consecutive glitches are grouped into flicker spans. sensitivity: low (only gross pops, cell change >= 32/255), medium (default, >= 18), high (>= 10; may flag noise/grain on compressed footage).
Also runs a boundary pass over every frame (8x8 px cells, a pixel counts when a channel moves > 32): lists cuts and overlay/picture changes, and 1-2 frame flashes that REVERSE (the picture leaves the before/after band by 32 in the middle frames and returns, >= 10% of the cells that jumped; faint ones are rejected when the 5x5 ring around them is moving; under 0.15 s). With cuts[] or a <file>.edit.json recipe sidecar (or output_dir) it saves stills at frames -2..+2 around every boundary (<= 2000 JPEGs) plus boundaries.json, and, with a recipe, reports overlay timing problems (off the frame grid, 1-2 frames from a cut, 1-2 frame gap/overlap between overlays at one position). full_res: native-resolution luma (cap 2560 px) with the stricter jump share 0.03 / score >= 0.1.`,
      inputSchema: {
        path: z.string(),
        sensitivity: z.enum(["low", "medium", "high"]).optional(),
        cuts: z
          .array(z.number().min(0))
          .max(500)
          .optional()
          .describe("Extra hard-cut times (s) to include in the boundary stills"),
        output_dir: z
          .string()
          .optional()
          .describe(
            "Directory for boundary stills + boundaries.json (must not exist yet; default takes/qa/<name>-boundaries when cuts/sidecar are available)",
          ),
        full_res: z
          .boolean()
          .optional()
          .describe("Boundary/flash analysis on native-resolution luma"),
      },
    },
    async ({ path, sensitivity = "medium", cuts, output_dir, full_res }) => {
      const src = abs(path);
      if (!existsSync(src)) return fail(`File not found: ${src}`);
      try {
        const info = await probe(src);
        if (!info.video || isStill(info)) return fail("media_flicker needs a video.");
        const fps = info.video.avgFps || info.video.fps || 25;
        const res = await findGlitches(
          src,
          { w: info.video.width, h: info.video.height },
          sensitivity,
        );
        const t = (f: number) => f / fps;
        // Group glitches closer than 3 frames into spans.
        const groups: Glitch[][] = [];
        for (const g of [...res.glitches].sort((a, b) => a.frame - b.frame)) {
          const last = groups.at(-1);
          if (last && g.frame - (last.at(-1)!.frame + last.at(-1)!.length) <= 2) last.push(g);
          else groups.push([g]);
        }
        const lines = [
          `media_flicker ${rel(src)} (${sensitivity}): ${res.frames} frames @ ${fps.toFixed(2)} fps, grid ${res.cols}x${res.rows}.`,
        ];
        const boundaryLines = await boundarySection(
          src,
          info,
          fps,
          cuts ?? [],
          output_dir,
          full_res === true,
        );
        if (!groups.length) {
          lines.push("No transient glitches found.", ...boundaryLines);
          return text(lines.join("\n"));
        }
        const singles = groups.filter((g) => g.length === 1).map((g) => g[0]!);
        const spans = groups.filter((g) => g.length > 1);
        lines.push(
          `${singles.length} isolated glitch${singles.length === 1 ? "" : "es"}${spans.length ? `, ${spans.length} flicker span${spans.length === 1 ? "" : "s"}` : ""}.`,
          "",
        );
        for (const g of [...singles].sort((a, b) => b.score - a.score).slice(0, 20))
          lines.push(
            `- @${fmt(t(g.frame))} frame ${g.frame}${g.length === 2 ? `-${g.frame + 1} (2 frames)` : ""}: score ${g.score.toFixed(0)}, ${regionText(g.cells, res.cols, res.rows)}`,
          );
        if (singles.length > 20) lines.push(`… ${singles.length - 20} more`);
        for (const s of spans.slice(0, 10)) {
          const cells = [...new Set(s.flatMap((g) => g.cells))];
          lines.push(
            `- flicker span @${fmt(t(s[0]!.frame))}-${fmt(t(s.at(-1)!.frame + 1))}: ${s.length} glitch frames, max score ${Math.max(...s.map((g) => g.score)).toFixed(0)}, ${regionText(cells, res.cols, res.rows)}`,
          );
        }
        lines.push(
          "",
          "Fixes: a single bad frame -> replace it with its neighbour or a blend (ffmpeg: select it out and duplicate the previous frame, or minterpolate across it); AI video pops -> regenerate the shot or cut around it; render pops (textures, shadows, GI, denoiser) -> re-render that frame range with persistent data off / higher samples / fixed seed; flicker spans -> temporal denoise (Cycles 'Denoising Data' + temporal, or ffmpeg tmix=frames=3 on that range) or a deflicker pass (ffmpeg deflicker=size=5). Intended flash frames are fine: say so.",
        );
        const top = res.glitches
          .filter((g) => g.strip)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4);
        const content: Content[] = [];
        if (top.length) {
          const dir = join(project(), "takes", "qa");
          mkdirSync(dir, { recursive: true });
          const out = join(
            dir,
            `${basename(src, extname(src))
              .replace(/[^\w-]+/g, "-")
              .slice(0, 40)}-flicker.jpg`,
          );
          const data = await writeJpeg(
            glitchStrip(
              top.map((g) => ({ g, t: t(g.frame) })),
              res.w,
              res.h,
              res.cols,
              res.rows,
            ),
            out,
          );
          lines.push(
            "",
            `Strip (rows = worst glitches, columns = before / glitch / after): ${top.map((g) => fmt(t(g.frame))).join(", ")}. Saved ${rel(out)}.`,
            ...boundaryLines,
          );
          content.push(
            { type: "text", text: lines.join("\n") },
            { type: "image", data, mimeType: "image/jpeg" },
          );
        } else content.push({ type: "text", text: [...lines, ...boundaryLines].join("\n") });
        return { content };
      } catch (error) {
        return fail(
          `media_flicker failed: ${(error as { stderr?: string }).stderr?.slice(-1500) ?? String(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "loop_check",
    {
      description:
        "Check whether a video loops seamlessly (GIF/social loops, backgrounds, Blender cycles, AI first=last-frame loops). Measures the seam last frame -> first frame against a normal frame step: SSIM of last vs first (ffmpeg ssim) next to first vs second, pixel change at the seam vs the median frame step, 2-step motion continuity across the seam (catches stalls/reversals) and eased ends. Verdict: seamless / near-seamless / duplicate-frame (last = first, one-frame hold) / hitch / jump, with fix advice and a strip LAST-1 | LAST | FIRST | FIRST+1.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const src = abs(path);
      if (!existsSync(src)) return fail(`File not found: ${src}`);
      try {
        const info = await probe(src);
        if (!info.video || isStill(info)) return fail("loop_check needs a video.");
        const r = await loopCheck(src, info);
        const dir = join(project(), "takes", "qa");
        mkdirSync(dir, { recursive: true });
        const out = join(
          dir,
          `${basename(src, extname(src))
            .replace(/[^\w-]+/g, "-")
            .slice(0, 40)}-loop.jpg`,
        );
        const data = await writeJpeg(r.strip, out);
        const ok = r.verdict === "seamless" || r.verdict === "near-seamless";
        const lines = [
          `loop_check ${rel(src)}: ${r.verdict.toUpperCase()}${ok ? "" : " (not a clean loop)"}.`,
          ...r.lines,
          ...(r.advice.length ? ["", "Fix:", ...r.advice.map((a) => `- ${a}`)] : []),
          "",
          `Strip LAST-1 | LAST | FIRST | FIRST+1 saved ${rel(out)}; the middle pair should look like any other neighbouring frames.`,
        ];
        return {
          content: [
            { type: "text" as const, text: lines.join("\n") },
            { type: "image" as const, data, mimeType: "image/jpeg" },
          ],
        };
      } catch (error) {
        return fail(
          `loop_check failed: ${(error as { stderr?: string }).stderr?.slice(-1500) ?? String(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "takes_log",
    {
      description:
        "Take ledger in ./takes/ledger.json. add: record a new take (file) with note = what changed vs the previous take and why, and score (0-10, from your rubric); adding an already logged file updates its note/score. list: all takes in order with scores and the picked one. pick: mark the chosen take (file path or take id like t3). Never overwrite take files; every iteration is a new file.",
      inputSchema: {
        action: z.enum(["add", "list", "pick"]),
        file: z.string().optional().describe("Take file path (add/pick) or take id (pick)"),
        note: z.string().optional(),
        score: z.number().min(0).max(10).optional(),
      },
    },
    async ({ action, file, note, score }) => {
      const ledger = readLedger();
      if (action === "list") {
        if (!ledger.takes.length) return text("No takes logged yet (./takes/ledger.json).");
        return text(
          [
            `${ledger.takes.length} takes${ledger.picked ? `, picked ${ledger.picked}` : ""}:`,
            ...ledger.takes.map((t) => describeTake(t, ledger)),
          ].join("\n"),
        );
      }
      if (!file) return fail(`'file' is required for ${action}.`);
      if (action === "pick") {
        const take = findTake(ledger, file);
        if (!take) return fail(`No logged take matches '${file}'. Log it with action=add first.`);
        ledger.picked = take.id;
        writeLedger(ledger);
        return text(`Picked ${describeTake(take, ledger)}. Earlier takes are kept.`);
      }
      if (!existsSync(abs(file))) return fail(`Take file not found: ${abs(file)}`);
      const existing = findTake(ledger, file);
      if (existing) {
        if (note) existing.note = existing.note ? `${existing.note}; ${note}` : note;
        if (score !== undefined) existing.score = score;
        writeLedger(ledger);
        return text(`Updated ${describeTake(existing, ledger)}`);
      }
      const prev = ledger.takes.at(-1);
      const take: Take = {
        id: `t${ledger.takes.length + 1}`,
        file: rel(file),
        note,
        score,
        added: new Date().toISOString(),
      };
      ledger.takes.push(take);
      writeLedger(ledger);
      const trend =
        prev?.score !== undefined && score !== undefined
          ? ` (${score > prev.score ? "+" : ""}${(score - prev.score).toFixed(1)} vs ${prev.id})`
          : "";
      return text(
        `Logged ${describeTake(take, ledger)}${trend}${note ? "" : "\nTip: add a note saying what changed vs the previous take."}`,
      );
    },
  );

  server.registerTool(
    "takes_compare",
    {
      description:
        "Side-by-side comparison of two takes (images or videos) as one image, saved to ./takes/compare/. Videos: 'frames' frames at the same relative times, A on the top row, B below. Images: A left, B right (layout=stack puts A on top).",
      inputSchema: {
        a: z.string(),
        b: z.string(),
        frames: z.number().int().min(1).max(8).optional().describe("Frames per video (default 4)"),
        layout: z.enum(["side", "stack"]).optional(),
      },
    },
    async ({ a, b, frames = 4, layout }) => {
      const srcs = [abs(a), abs(b)];
      const missing = srcs.find((s) => !existsSync(s));
      if (missing) return fail(`File not found: ${missing}`);
      const dir = mkdtempSync(join(tmpdir(), "oh-cmp-"));
      try {
        const infos = await Promise.all(srcs.map(probe));
        if (infos.some((i) => !i.video)) return fail("Both takes need a picture (image or video).");
        const anyVideo = infos.some((i) => !isStill(i));
        const n = anyVideo ? frames : 1;
        const first = infos[0]!.video!;
        const cellW = 480;
        const cellH = Math.min(720, Math.round((cellW * first.height) / first.width / 2) * 2);
        const timesUsed: string[] = [];
        let k = 0;
        for (const [idx, src] of srcs.entries()) {
          const info = infos[idx]!;
          const times = isStill(info)
            ? Array.from({ length: n }, () => 0)
            : Array.from({ length: n }, (_, i) => ((i + 0.5) * info.duration) / n);
          timesUsed.push(
            `${idx ? "B" : "A"}: ${isStill(info) ? "still" : times.map(fmt).join(", ")}`,
          );
          for (const t of times) {
            await run("ffmpeg", [
              "-v",
              "error",
              ...(isStill(info) ? [] : ["-ss", t.toFixed(3)]),
              "-i",
              src,
              "-frames:v",
              "1",
              "-vf",
              `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x202020`,
              join(dir, `c${String(k++).padStart(3, "0")}.png`),
            ]);
          }
        }
        const stack = layout ? layout === "stack" : anyVideo;
        const grid = stack ? `${n}x2` : n === 1 ? "2x1" : `${n}x2`;
        const outDir = join(project(), "takes", "compare");
        mkdirSync(outDir, { recursive: true });
        const name = (p: string) =>
          basename(p, extname(p))
            .replace(/[^\w-]+/g, "-")
            .slice(0, 40);
        const out = join(outDir, `${name(srcs[0]!)}-vs-${name(srcs[1]!)}.jpg`);
        await run("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-framerate",
          "1",
          "-i",
          join(dir, "c%03d.png"),
          "-vf",
          `tile=${grid}:padding=6:color=0xffffff`,
          "-frames:v",
          "1",
          "-q:v",
          "3",
          out,
        ]);
        const where = grid === "2x1" ? "A left, B right" : "A top row, B bottom row";
        return {
          content: [
            {
              type: "text" as const,
              text: `Compared ${rel(srcs[0]!)} (A) vs ${rel(srcs[1]!)} (B): ${where}. Times — ${timesUsed.join("; ")}. Saved ${rel(out)}.`,
            },
            {
              type: "image" as const,
              data: readFileSync(out).toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        };
      } catch (error) {
        return fail(
          `takes_compare failed: ${(error as { stderr?: string }).stderr?.slice(-1500) ?? String(error)}`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  server.registerTool(
    "house_style",
    {
      description:
        "House-style memory: rules learned from the user's corrections and stated preferences, injected into every future session. add: save one concise, testable rule (e.g. 'Subtitles: white Inter Bold with a 2px black outline, never yellow') with why; scope=project (./.open-herness/house-style.md, default) or global (~/.open-herness/house-style.md, for preferences that apply to all their work). list: show rules of both scopes. remove: delete a rule by its number from list or a unique part of its text. Do not save one-off instructions for the current piece.",
      inputSchema: {
        action: z.enum(["add", "list", "remove"]),
        rule: z
          .string()
          .optional()
          .describe("add: the rule; remove: its number or a unique part of its text"),
        why: z.string().optional(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async ({ action, rule, why, scope }) => {
      if (action === "list") {
        const out: string[] = [];
        for (const s of ["global", "project"] as const) {
          const rules = readRules(stylePath(s));
          out.push(
            `${s} (${stylePath(s)}): ${rules.length ? "" : "no rules"}`,
            ...rules.map((r, i) => `  ${i + 1}. ${r.replace(/^\s*-\s+/, "")}`),
          );
        }
        return text(out.join("\n"));
      }
      const sc = scope ?? "project";
      const file = stylePath(sc);
      const rules = readRules(file);
      if (!rule?.trim()) return fail("'rule' is required.");
      if (action === "remove") {
        const idx = /^\d+$/.test(rule.trim()) ? Number(rule.trim()) - 1 : -1;
        const matches =
          idx >= 0
            ? rules[idx]
              ? [idx]
              : []
            : rules.flatMap((r, i) => (norm(r).includes(norm(rule)) ? [i] : []));
        if (matches.length !== 1)
          return fail(
            matches.length
              ? `'${rule}' matches ${matches.length} ${sc} rules; be more specific or use the number.`
              : `No ${sc} rule matches '${rule}'. Use action=list.`,
          );
        const [removed] = rules.splice(matches[0]!, 1);
        writeRules(file, rules);
        return text(`Removed ${sc} rule: ${ruleText(removed!)}`);
      }
      const clean = rule.replace(/\s+/g, " ").trim().replace(/^-\s+/, "");
      const line = `- ${clean}${why?.trim() ? ` (why: ${why.replace(/\s+/g, " ").trim()})` : ""} (added ${new Date().toISOString().slice(0, 10)})`;
      const same = rules.findIndex((r) => norm(ruleText(r)) === norm(clean));
      if (same >= 0) rules[same] = line;
      else rules.push(line);
      writeRules(file, rules);
      return text(
        `${same >= 0 ? "Updated" : "Saved"} ${sc} house-style rule #${same >= 0 ? same + 1 : rules.length}: ${clean}`,
      );
    },
  );

  server.registerTool(
    "preferences",
    {
      description:
        "The user's general preferences (~/.open-herness/preferences.md: language, tone, how much to ask vs. decide, favourite tools/styles, budget for paid generation), injected into every session. get: read it. set: replace it with text (get first and merge, keep it short markdown bullets).",
      inputSchema: { action: z.enum(["get", "set"]), text: z.string().optional() },
    },
    async ({ action, text: body }) => {
      const file = join(globalHome(), "preferences.md");
      if (action === "get")
        return text(
          existsSync(file) && readFileSync(file, "utf8").trim()
            ? readFileSync(file, "utf8")
            : "No preferences saved yet.",
        );
      if (body === undefined) return fail("'text' is required for set.");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body.trim() ? `${body.trim()}\n` : "");
      return text(`Saved preferences (${body.trim().split("\n").length} lines) to ${file}.`);
    },
  );
}

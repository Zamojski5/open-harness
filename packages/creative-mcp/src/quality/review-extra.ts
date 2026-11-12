// media_review extras: audio noise floor / quiet tail / raw-take comparison, joinMotion stalls at
// continuous cuts, decoded frame count, source upscale from the edit recipe, and the recipe sidecar reader.
// Every flag carries a fix hint.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIG = { maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 };
const fmt = (t: number) => `${t.toFixed(2)}s`;
const round1 = (x: number) => Math.round(x * 10) / 10;

export type Severity = "error" | "warn" | "info";
export interface Flag {
  severity: Severity;
  what: string;
  start?: number;
  end?: number;
  fix?: string;
}

export const X = {
  floorMinT: 0.39, // momentary loudness is only valid after the first 400 ms window
  floorMinSamples: 10,
  floorPercentile: 0.1,
  quietTailBelowLU: 20, // tail = after the last momentary sample within this many LU of integrated
  quietTailMinSec: 2,
  quietTailShare: 0.2, // ... and at least this share of the duration
  noiseRiseDb: 15,
  rangeLossLU: 4,
  peakToLoudnessLossDb: 6,
  joinWindow: 3, // seconds decoded on each side of a cut
  joinPausedBelow: 0.4, // dip vs the slower neighbour
  joinRealCutAbove: 4, // jump factor: a real cut, not a continuing join
  frameCountMinShare: 0.5,
  sparseFps: 5,
  upscaleWarn: 1.5,
  zoomFactor: 1.08,
};

// ---------------------------------------------------------------------------------------------
// Recipe sidecar (<out>.edit.json, falling back to <out>.assemble.json). Every field is optional.
// ---------------------------------------------------------------------------------------------
export interface RecipeClip {
  path?: string;
  duration?: number;
  fit?: "cover" | "contain";
  motion?: string;
  transition?: string;
  transitionDuration?: number;
}
export interface RecipeOverlay {
  start?: number;
  end?: number;
  position?: string;
  text?: string;
  path?: string;
}
export interface Recipe {
  file: string;
  dir: string;
  width?: number;
  height?: number;
  fps?: number;
  clips: RecipeClip[];
  text: RecipeOverlay[];
  logos: RecipeOverlay[];
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

export function readRecipe(src: string): Recipe | undefined {
  const noExt = join(dirname(src), basename(src, extname(src)));
  for (const f of [
    `${src}.edit.json`,
    `${noExt}.edit.json`,
    `${src}.assemble.json`,
    `${noExt}.assemble.json`,
  ]) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      const arr = (k: string) => (Array.isArray(j[k]) ? (j[k] as Record<string, unknown>[]) : []);
      return {
        file: f,
        dir: typeof j.directory === "string" ? resolve(dirname(f), j.directory) : dirname(f),
        width: num(j.width),
        height: num(j.height),
        fps: num(j.fps),
        clips: arr("clips").map((c) => ({
          path: typeof c.path === "string" ? c.path : undefined,
          duration: num(c.duration),
          fit: c.fit === "contain" ? "contain" : "cover",
          motion: typeof c.motion === "string" ? c.motion : undefined,
          transition: typeof c.transition === "string" ? c.transition : "cut",
          transitionDuration: num(c.transitionDuration),
        })),
        text: arr("text").map((o) => ({
          start: num(o.start),
          end: num(o.end),
          position: typeof o.position === "string" ? o.position : undefined,
          text: typeof o.text === "string" ? o.text : undefined,
        })),
        logos: arr("logos").map((o) => ({
          start: num(o.start),
          end: num(o.end),
          position: typeof o.position === "string" ? o.position : undefined,
          path: typeof o.path === "string" ? o.path : undefined,
        })),
      };
    } catch {
      // unreadable sidecar: behave as if there were none
    }
  }
  return undefined;
}

/** Hard-cut times between consecutive clips (transitions overlap; only "cut" boundaries count). */
export function recipeCuts(r: Recipe): number[] {
  const cuts: number[] = [];
  let t = 0;
  r.clips.forEach((c, i) => {
    const d = c.duration ?? 0;
    const end = t + d;
    if (i < r.clips.length - 1) {
      if (c.transition === "cut" || c.transition === undefined) cuts.push(end);
      t =
        end -
        (c.transition === "cut" || c.transition === undefined ? 0 : (c.transitionDuration ?? 0.5));
    } else t = end;
  });
  return cuts;
}

// ---------------------------------------------------------------------------------------------
// Audio: momentary loudness, noise floor, quiet tail, raw-take comparison.
// ---------------------------------------------------------------------------------------------
export interface Momentary {
  t: number;
  m: number;
}
export interface AudioStats {
  I: number;
  TP: number;
  LRA: number;
  M: Momentary[];
}

/** Parses the ametadata=print file written after ebur128 (keys lavfi.r128.M). */
export function parseMomentary(file: string): Momentary[] {
  const out: Momentary[] = [];
  if (!existsSync(file)) return out;
  let t: number | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const f = /pts_time:([\d.eE+-]+)/.exec(line);
    if (line.startsWith("frame:") && f) t = Number(f[1]);
    else if (line.startsWith("lavfi.r128.M=") && t !== undefined) {
      const v = Number(line.slice(13));
      out.push({ t, m: Number.isFinite(v) ? v : -120 });
    }
  }
  return out;
}

/** Last number following `key:` in ffmpeg's ebur128 summary. */
export function ebuSummary(stderr: string) {
  const last = (re: RegExp) => {
    const all = [...stderr.matchAll(re)];
    return all.length ? Number(all.at(-1)![1]) : NaN;
  };
  const tpAt = stderr.lastIndexOf("True peak");
  return {
    I: last(/I:\s+(-?[\d.]+|-inf) LUFS/g),
    LRA: last(/LRA:\s+([\d.]+) LU/g),
    TP: Number(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(tpAt >= 0 ? stderr.slice(tpAt) : "")?.[1]),
  };
}

export async function measureAudio(src: string): Promise<AudioStats> {
  const dir = mkdtempSync(join(tmpdir(), "oh-qa-"));
  try {
    const meta = join(dir, "r128.txt");
    const { stderr } = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        src,
        "-vn",
        "-af",
        `ebur128=peak=true:framelog=quiet:metadata=1,ametadata=mode=print:file=${meta}`,
        "-f",
        "null",
        "-",
      ],
      BIG,
    );
    return { ...ebuSummary(stderr), M: parseMomentary(meta) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 10th percentile of momentary loudness after 0.39 s; needs >= 10 samples. */
export function noiseFloor(M: Momentary[]): number | undefined {
  const xs = M.filter((s) => s.t >= X.floorMinT)
    .map((s) => Math.max(-120, s.m))
    .sort((a, b) => a - b);
  if (xs.length < X.floorMinSamples) return undefined;
  return round1(xs[Math.floor(xs.length * X.floorPercentile)]!);
}

/** Start of a trailing stretch that stays 20 LU under the programme; flagged when >= 2 s and >= 1/5 of the piece. */
export function quietTail(
  M: Momentary[],
  I: number,
  dur: number,
): { start: number; length: number } | undefined {
  if (!Number.isFinite(I) || M.length < 2) return undefined;
  let k = -1;
  for (let i = M.length - 1; i >= 0; i--)
    if (M[i]!.m >= I - X.quietTailBelowLU) {
      k = i;
      break;
    }
  const next = M[k + 1];
  if (k < 0 || !next) return undefined;
  const start = Math.max(0, next.t - 0.4);
  const length = dur - start;
  return length >= X.quietTailMinSec && length >= dur * X.quietTailShare
    ? { start, length }
    : undefined;
}

export function audioExtras(out: AudioStats, dur: number, flags: Flag[], lines: string[]) {
  const floor = noiseFloor(out.M);
  if (floor !== undefined)
    lines.push(`Noise floor (10th percentile of momentary loudness) ${floor.toFixed(1)} LUFS.`);
  const tail = quietTail(out.M, out.I, dur);
  if (tail)
    flags.push({
      severity: "warn",
      what: `Quiet tail: the last ${fmt(tail.length)} sit more than ${X.quietTailBelowLU} LU under the programme loudness (${out.I.toFixed(1)} LUFS).`,
      start: tail.start,
      end: dur,
      fix: "Trim the dead tail, or extend/loop the music or ambience under the ending; if the ending is meant to fade out, shorten the fade.",
    });
}

export interface SourceComparison {
  gainLU: number;
  noiseFloorRiseDB: number;
  sourceRangeLU: number;
  outputRangeLU: number;
  peakToLoudnessLossDB: number;
  noiseRaised: boolean;
  rangeCrushed: boolean;
}

export function compareSource(out: AudioStats, src: AudioStats): SourceComparison | undefined {
  const fo = noiseFloor(out.M);
  const fs = noiseFloor(src.M);
  const all = [out.I, src.I, out.LRA, src.LRA, out.TP, src.TP];
  if (fo === undefined || fs === undefined || all.some((x) => !Number.isFinite(x)))
    return undefined;
  const gain = out.I - src.I;
  const rise = fo - fs;
  const loss = src.TP - src.I - (out.TP - out.I);
  return {
    gainLU: round1(gain),
    noiseFloorRiseDB: round1(rise),
    sourceRangeLU: round1(src.LRA),
    outputRangeLU: round1(out.LRA),
    peakToLoudnessLossDB: round1(loss),
    noiseRaised:
      rise > X.noiseRiseDb && fo > (gain >= 20 ? -70 : -60) && (gain > 15 || gain >= rise / 2),
    rangeCrushed:
      (out.LRA < src.LRA / 2 && src.LRA - out.LRA >= X.rangeLossLU) ||
      loss >= X.peakToLoudnessLossDb,
  };
}

export async function audioSourceCheck(
  out: AudioStats,
  sourcePath: string,
  flags: Flag[],
  lines: string[],
) {
  if (!existsSync(sourcePath)) {
    flags.push({
      severity: "info",
      what: `audio_source not found (${sourcePath}); noise-floor comparison not measured.`,
      fix: "Pass the raw, unprocessed take of the same recording.",
    });
    return;
  }
  const src = await measureAudio(sourcePath);
  const c = compareSource(out, src);
  if (!c) {
    flags.push({
      severity: "info",
      what: "Audio source comparison not measured: too little audio (needs >= 10 momentary samples after 0.4 s) or silent.",
      fix: "Compare a recording of at least ~1.5 s with the same speech content.",
    });
    return;
  }
  lines.push(
    `Versus source: gain ${c.gainLU} LU, noise floor ${c.noiseFloorRiseDB >= 0 ? "+" : ""}${c.noiseFloorRiseDB} dB, range ${c.sourceRangeLU} -> ${c.outputRangeLU} LU, peak-to-loudness loss ${c.peakToLoudnessLossDB} dB.`,
  );
  if (c.noiseRaised)
    flags.push({
      severity: "warn",
      what: `Noise floor raised ${c.noiseFloorRiseDB} dB over the raw take (now ${noiseFloor(out.M)} LUFS) after ${c.gainLU} LU of gain: hiss/room noise now competes with the voice.`,
      fix: "Denoise/gate the raw take BEFORE applying gain, limit how much gain you add, and level mostly with plain gain instead of squeezing with compression.",
    });
  if (c.rangeCrushed)
    flags.push({
      severity: "warn",
      what: `Dynamics crushed against the raw take (range ${c.sourceRangeLU} -> ${c.outputRangeLU} LU, peak-to-loudness loss ${c.peakToLoudnessLossDB} dB): it will sound flat and pumping.`,
      fix: "Use gentler compression (lower ratio, higher threshold, slower release) and a limiter only for peaks; level with gain first.",
    });
}

// ---------------------------------------------------------------------------------------------
// joinMotion: does motion stall across a continuing (CONTINUE) hard cut?
// ---------------------------------------------------------------------------------------------
const medianOf = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Inter-frame difference series (mean abs luma diff) of [from, to) at 160 px, times in source time. */
async function diffSeries(
  src: string,
  from: number,
  to: number,
): Promise<{ t: number; d: number }[]> {
  const dir = mkdtempSync(join(tmpdir(), "oh-qa-"));
  try {
    const meta = join(dir, "d.txt");
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        from.toFixed(3),
        "-t",
        (to - from).toFixed(3),
        "-i",
        src,
        "-an",
        "-vf",
        `scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${meta}`,
        "-f",
        "null",
        "-",
      ],
      { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const out: { t: number; d: number }[] = [];
    let t: number | undefined;
    if (existsSync(meta))
      for (const line of readFileSync(meta, "utf8").split("\n")) {
        const f = /pts_time:([\d.eE+-]+)/.exec(line);
        if (line.startsWith("frame:") && f) t = Number(f[1]) + from;
        else if (line.startsWith("lavfi.signalstats.YAVG=") && t !== undefined)
          out.push({ t, d: Number(line.slice(23)) });
      }
    return out.slice(1); // the first frame has nothing to differ from
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface JoinResult {
  t: number;
  measured: boolean;
  reason?: string;
  realCut?: boolean;
  jump?: number;
  dip?: number;
  paused?: boolean;
}

export async function joinMotion(src: string, T: number, dur: number): Promise<JoinResult> {
  const lo = Math.max(0, T - X.joinWindow);
  const hi = Math.min(dur, T + X.joinWindow);
  let s: { t: number; d: number }[];
  try {
    s = await diffSeries(src, lo, hi);
  } catch {
    return { t: T, measured: false, reason: "could not decode the window around the cut" };
  }
  const within = (a: number, b: number) => s.filter((x) => x.t >= a && x.t <= b).map((x) => x.d);
  const beforeT = within(T - 0.6, T - 0.1);
  const afterT = within(T + 0.1, T + 0.6);
  if (beforeT.length < 2 || afterT.length < 2)
    return {
      t: T,
      measured: false,
      reason: "clips on either side are too short (< 0.6 s of frames) or frames are missing",
    };
  const typical = medianOf([...beforeT, ...afterT]);
  const near = within(T - 0.05, T + 0.05);
  if (!near.length) return { t: T, measured: false, reason: "no frames at the cut" };
  const jump = Math.max(...near) / Math.max(typical, 0.01);
  if (jump > X.joinRealCutAbove) return { t: T, measured: true, realCut: true, jump };
  const peak = (a: number, b: number) => {
    const xs = s.filter((x) => x.t >= a && x.t <= b);
    if (xs.length < 2) return NaN;
    let best = 0;
    for (const x of xs)
      best = Math.max(
        best,
        meanOf(xs.filter((y) => y.t >= x.t && y.t < x.t + 0.25).map((y) => y.d)),
      );
    return best;
  };
  const left = peak(Math.max(0.1, T - 2.5), T - 0.5);
  const right = peak(T + 0.5, Math.min(dur - 0.1, T + 2.5));
  if (!Number.isFinite(left) || !Number.isFinite(right))
    return {
      t: T,
      measured: false,
      reason: "neighbouring clips are shorter than 0.5 s of motion window",
    };
  const slower = Math.min(left, right);
  if (slower < 0.05)
    return {
      t: T,
      measured: false,
      reason: "neighbouring clips are static, so a stall cannot be told from stillness",
    };
  const dip = meanOf(within(T - 0.25, T + 0.25)) / slower;
  return { t: T, measured: true, jump, dip, paused: dip < X.joinPausedBelow };
}

export async function joinChecks(
  src: string,
  cuts: number[],
  dur: number,
  flags: Flag[],
  lines: string[],
) {
  const times = [...new Set(cuts.map((c) => Math.round(c * 1000) / 1000))]
    .filter((c) => c > 0 && c < dur)
    .sort((a, b) => a - b)
    .slice(0, 40);
  if (!times.length) return;
  const results: JoinResult[] = [];
  for (const T of times) results.push(await joinMotion(src, T, dur));
  const ok = results.filter((r) => r.measured && !r.realCut).length;
  const real = results.filter((r) => r.realCut).length;
  lines.push(
    `Join motion: ${ok} continuing cut${ok === 1 ? "" : "s"} measured, ${real} real cut${real === 1 ? "" : "s"} (not judged), ${results.length - ok - real} not measured.`,
  );
  for (const r of results) {
    if (r.paused)
      flags.push({
        severity: "warn",
        what: `Motion stalls across the cut at ${fmt(r.t)}: movement at the join is ${(r.dip! * 100).toFixed(0)}% of the slower neighbouring clip (paused below ${X.joinPausedBelow * 100}%), so a continuing shot looks like a hitch.`,
        start: r.t,
        fix: "Trim the outgoing clip earlier, to where it is still in motion, and regenerate/extend the follow-on shot from that new last frame.",
      });
    else if (!r.measured)
      flags.push({
        severity: "info",
        what: `Join motion at ${fmt(r.t)} not measured: ${r.reason}.`,
        start: r.t,
      });
  }
}

// ---------------------------------------------------------------------------------------------
// Decoded frame count.
// ---------------------------------------------------------------------------------------------
export function frameCountCheck(
  decoded: number,
  dur: number,
  avgFps: number,
  flags: Flag[],
  lines: string[],
) {
  const expected = Math.round(dur * avgFps);
  if (expected < 2) return;
  lines.push(
    `Decoded frames ${decoded} of ${expected} expected (${((100 * decoded) / expected).toFixed(0)}%).`,
  );
  if (decoded < expected * X.frameCountMinShare)
    flags.push({
      severity: "error",
      what: `Most of the take has no picture: only ${decoded} of ~${expected} frames decode (${fmt(dur)} at ${avgFps.toFixed(2)} fps).`,
      fix: "The file is truncated or its container lies about its length: re-render/re-export it, and check the disk did not fill up mid-write.",
    });
  else if (dur >= 2 && decoded / dur < X.sparseFps)
    flags.push({
      severity: "info",
      what: `Sparse picture: ${(decoded / dur).toFixed(1)} decoded frames per second (below ${X.sparseFps}); it will play as a slideshow.`,
      fix: "Fine for intentional stills; otherwise re-render with every frame, or interpolate.",
    });
}

// ---------------------------------------------------------------------------------------------
// Source scale: how far above native size is each source shown?
// ---------------------------------------------------------------------------------------------
export interface SourceSpec {
  path: string;
  shown_width: number;
  shown_height: number;
  fit?: "cover" | "contain";
  zoom?: boolean;
}

async function sourceSize(path: string): Promise<{ w: number; h: number } | undefined> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,sample_aspect_ratio:stream_side_data=rotation",
      "-of",
      "json",
      path,
    ]);
    const s = (
      JSON.parse(stdout) as {
        streams?: {
          width?: number;
          height?: number;
          sample_aspect_ratio?: string;
          side_data_list?: { rotation?: number }[];
        }[];
      }
    ).streams?.[0];
    if (!s?.width || !s.height) return undefined;
    const [n, d] = (s.sample_aspect_ratio ?? "1:1").split(":").map(Number);
    const sar = n && d ? n / d : 1;
    let w = s.width * sar;
    let h = s.height;
    if (Math.abs(s.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0) === 90)
      [w, h] = [h, w];
    return { w, h };
  } catch {
    return undefined;
  }
}

export async function sourceScaleCheck(
  specs: (SourceSpec & { label?: string })[],
  flags: Flag[],
  lines: string[],
) {
  const seen = new Set<string>();
  let worst = 0;
  let n = 0;
  for (const s of specs) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    const size = existsSync(s.path) ? await sourceSize(s.path) : undefined;
    if (!size) {
      flags.push({
        severity: "info",
        what: `Source scale of ${basename(s.path)} not measured: file missing or unreadable.`,
        fix: "Pass the real source path in sources[] (or keep the clips next to the recipe).",
      });
      continue;
    }
    n++;
    const rx = s.shown_width / size.w;
    const ry = s.shown_height / size.h;
    const up =
      (s.fit === "contain" ? Math.min(rx, ry) : Math.max(rx, ry)) * (s.zoom ? X.zoomFactor : 1);
    worst = Math.max(worst, up);
    if (up > X.upscaleWarn)
      flags.push({
        severity: "warn",
        what: `${basename(s.path)} (${Math.round(size.w)}x${Math.round(size.h)}) is shown ${up.toFixed(2)}x above native size in a ${s.shown_width}x${s.shown_height} frame (limit ${X.upscaleWarn}x): it will look soft.`,
        fix: "Use a higher-resolution source (regenerate/re-render at the delivery size), an AI detail upscaler, or show it smaller (contain, or a picture-in-frame).",
      });
  }
  if (n)
    lines.push(
      `Source scale: ${n} source${n === 1 ? "" : "s"} checked, worst ${worst.toFixed(2)}x native.`,
    );
}

/** Resolves the sources to check from explicit input or the recipe. */
export function recipeSources(
  r: Recipe,
  out: { w: number; h: number },
): (SourceSpec & { label?: string })[] {
  const specs: SourceSpec[] = [];
  for (const c of r.clips) {
    if (!c.path) continue;
    const candidates = [resolve(r.dir, c.path), resolve(process.cwd(), c.path)];
    const path = candidates.find(existsSync) ?? candidates[0]!;
    specs.push({
      path,
      shown_width: r.width ?? out.w,
      shown_height: r.height ?? out.h,
      fit: c.fit,
      zoom: !!c.motion && /^zoom/.test(c.motion),
    });
  }
  return specs;
}

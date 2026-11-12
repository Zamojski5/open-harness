// media_review picture checks that need sampled frames: subject cut off by the frame edge, text inside
// platform UI zones (OCR) and on-screen text reading time.
// OCR host: a tiny Swift helper around Apple Vision (compiled once into ~/.cache), else `tesseract`; if neither
// exists the checks report "not measured" and the safe-area zones are still reported geometrically.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Flag } from "./review-extra.ts";
import { drawRect, drawText, type Img, readImage, type RGB } from "./raster.ts";

const run = promisify(execFile);
const fmt = (t: number) => `${t.toFixed(2)}s`;
const RED: RGB = [255, 40, 40];
const YELLOW: RGB = [255, 215, 0];

export const V = {
  analysisWidth: 320,
  borderPx: 2,
  bgTolerance: 40,
  borderShare: 0.5,
  smoothStep: 8,
  backdropBorderShare: 0.25,
  minComponent: 4,
  minComponentArea: 0.002,
  maxSubjectShare: 0.6,
  maxBoxShare: 0.9,
  necksWidest: 0.2,
  ocrMinConfidence: 0.5,
  zoneHitShare: 0.1,
  ocrMaxWidth: 1080,
  readStep: 0.25,
  readMaxSamples: 240,
  readMinSec: 1.5,
  cjkPerSec: 4.5,
  latinPerSec: 15,
  readPad: 1.5,
};

type Box = [number, number, number, number]; // inclusive x0, y0, x1, y1

// ---------------------------------------------------------------------------------------------
// Frame sampling.
// ---------------------------------------------------------------------------------------------
export function sampleTimes(dur: number, fps: number, n: number): number[] {
  const f = fps > 0 ? fps : 25;
  return Array.from({ length: n }, (_, i) =>
    Math.max(0, Math.min(Math.floor(((dur * (i + 0.5)) / n) * f) / f, Math.max(0, dur - 1 / f))),
  );
}

async function grabFrame(
  src: string,
  t: number | undefined,
  out: string,
  maxW: number,
  ext = "png",
) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...(t !== undefined ? ["-ss", t.toFixed(3)] : []),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${maxW},iw)':-2`,
    ...(ext === "jpg" ? ["-q:v", "4"] : []),
    out,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Subject cut off by the frame edge.
// ---------------------------------------------------------------------------------------------
export interface EdgeResult {
  measured: boolean;
  reason?: string;
  subject?: Box;
  base?: Box;
  sides: string[];
}

export function edgeAnalysis(img: Img, margin: number): EdgeResult {
  const { w, h, data } = img;
  const n = w * h;
  const ch = (i: number, c: number) => data[i * 3 + c]!;
  const border = (x: number, y: number) =>
    x < V.borderPx || y < V.borderPx || x >= w - V.borderPx || y >= h - V.borderPx;
  // Background: modal 4-bit colour of the border ring (average of that bin).
  const bins = new Map<number, [number, number, number, number]>();
  let borderN = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!border(x, y)) continue;
      const i = y * w + x;
      const key = ((ch(i, 0) >> 4) << 8) | ((ch(i, 1) >> 4) << 4) | (ch(i, 2) >> 4);
      const b = bins.get(key) ?? [0, 0, 0, 0];
      b[0]++;
      b[1] += ch(i, 0);
      b[2] += ch(i, 1);
      b[3] += ch(i, 2);
      bins.set(key, b);
      borderN++;
    }
  const mode = [...bins.values()].sort((a, b) => b[0] - a[0])[0]!;
  const bg = [mode[1] / mode[0], mode[2] / mode[0], mode[3] / mode[0]];
  const near = (i: number) =>
    Math.max(
      Math.abs(ch(i, 0) - bg[0]!),
      Math.abs(ch(i, 1) - bg[1]!),
      Math.abs(ch(i, 2) - bg[2]!),
    ) <= V.bgTolerance;
  const edgeColour = new Uint8Array(n);
  let borderNear = 0;
  for (let i = 0; i < n; i++)
    if (near(i)) {
      edgeColour[i] = 1;
      if (border(i % w, Math.floor(i / w))) borderNear++;
    }
  if (borderNear < borderN * V.borderShare)
    return {
      measured: false,
      reason: "no dominant background colour at the frame border",
      sides: [],
    };

  // Smooth regions (neighbour step <= 8): a region is backdrop when it touches the border and is edge-coloured or wide on the border.
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const backdrop: boolean[] = [];
  for (let s = 0; s < n; s++) {
    if (label[s]! >= 0) continue;
    const id = backdrop.length;
    let sp = 0;
    let borderPx = 0;
    let size = 0;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    stack[sp++] = s;
    label[s] = id;
    while (sp) {
      const i = stack[--sp]!;
      const x = i % w;
      const y = (i - x) / w;
      size++;
      cr += ch(i, 0);
      cg += ch(i, 1);
      cb += ch(i, 2);
      if (border(x, y)) borderPx++;
      const visit = (j: number) => {
        if (label[j]! >= 0) return;
        if (
          Math.max(
            Math.abs(ch(i, 0) - ch(j, 0)),
            Math.abs(ch(i, 1) - ch(j, 1)),
            Math.abs(ch(i, 2) - ch(j, 2)),
          ) > V.smoothStep
        )
          return;
        label[j] = id;
        stack[sp++] = j;
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    const mean = [cr / size, cg / size, cb / size];
    const coloured =
      Math.max(
        Math.abs(mean[0]! - bg[0]!),
        Math.abs(mean[1]! - bg[1]!),
        Math.abs(mean[2]! - bg[2]!),
      ) <= V.bgTolerance;
    backdrop.push(borderPx > 0 && (coloured || borderPx >= borderN * V.backdropBorderShare));
  }
  const subject = new Uint8Array(n);
  for (let i = 0; i < n; i++) subject[i] = !edgeColour[i] && !backdrop[label[i]!] ? 1 : 0;

  // 4-connected components >= max(4, 0.2% of the area) form the subject.
  const keep = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const minSize = Math.max(V.minComponent, Math.round(n * V.minComponentArea));
  const members: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!subject[s] || seen[s]) continue;
    members.length = 0;
    let sp = 0;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp) {
      const i = stack[--sp]!;
      members.push(i);
      const x = i % w;
      const y = (i - x) / w;
      const visit = (j: number) => {
        if (subject[j] && !seen[j]) {
          seen[j] = 1;
          stack[sp++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    if (members.length >= minSize) for (const i of members) keep[i] = 1;
  }
  let count = 0;
  const rowW = new Int32Array(h);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    count++;
    rowW[y]!++;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (!count)
    return { measured: false, reason: "no subject found against the background", sides: [] };
  if (count > n * V.maxSubjectShare)
    return {
      measured: false,
      reason: "the subject fills most of the frame (not a product/hero shot)",
      sides: [],
    };
  if (x1 - x0 + 1 > w * V.maxBoxShare && y1 - y0 + 1 > h * V.maxBoxShare)
    return { measured: false, reason: "the subject box spans the frame (wide shot)", sides: [] };

  // Neck / base split: last row narrower than half the widest row so far, only for shapes touching the bottom.
  let neck = -1;
  let widest = 0;
  for (let y = y0; y <= y1; y++) {
    if (rowW[y]! < widest / 2) neck = y;
    widest = Math.max(widest, rowW[y]!);
  }
  const touchesBottom = y1 >= h - 1 - margin;
  const boxOf = (ya: number, yb: number): Box | undefined => {
    let a = w;
    let b = -1;
    let c = h;
    let d = -1;
    for (let y = ya; y <= yb; y++)
      for (let x = 0; x < w; x++)
        if (keep[y * w + x]) {
          a = Math.min(a, x);
          b = Math.max(b, x);
          c = Math.min(c, y);
          d = Math.max(d, y);
        }
    return b < 0 ? undefined : [a, c, b, d];
  };
  let sub: Box | undefined = [x0, y0, x1, y1];
  let base: Box | undefined;
  let subjectLastRow = y1;
  if (neck >= 0 && touchesBottom && widest >= w * V.necksWidest) {
    sub = boxOf(y0, neck);
    base = boxOf(neck + 1, y1);
    subjectLastRow = neck;
  }
  if (!sub) return { measured: false, reason: "no subject above the base", sides: [] };

  // >= 3 consecutive rows/columns of subject pixels inside the margin band of a side.
  const run3 = (get: (k: number) => boolean, len: number) => {
    let r = 0;
    for (let k = 0; k < len; k++) {
      r = get(k) ? r + 1 : 0;
      if (r >= 3) return true;
    }
    return false;
  };
  const has = (x: number, y: number) => y <= subjectLastRow && !!keep[y * w + x];
  const sides: string[] = [];
  if (
    run3((y) => {
      for (let x = 0; x <= margin; x++) if (has(x, y)) return true;
      return false;
    }, h)
  )
    sides.push("left");
  if (
    run3((y) => {
      for (let x = w - 1 - margin; x < w; x++) if (has(x, y)) return true;
      return false;
    }, h)
  )
    sides.push("right");
  if (
    run3((x) => {
      for (let y = 0; y <= margin; y++) if (has(x, y)) return true;
      return false;
    }, w)
  )
    sides.push("top");
  if (
    run3((x) => {
      for (let y = h - 1 - margin; y < h; y++) if (has(x, y)) return true;
      return false;
    }, w)
  )
    sides.push("bottom");
  return { measured: true, subject: sub, base, sides };
}

// ---------------------------------------------------------------------------------------------
// OCR hosts.
// ---------------------------------------------------------------------------------------------
export interface OcrBox {
  text: string;
  confidence: number;
  x: number; // normalised, top-left origin
  y: number;
  width: number;
  height: number;
}
interface Ocr {
  name: "apple-vision" | "tesseract";
  read: (files: string[]) => Promise<Map<string, OcrBox[]>>;
}

let ocrCache: Promise<Ocr | undefined> | undefined;

async function visionHelper(): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const source = join(dirname(fileURLToPath(import.meta.url)), "ocr.swift");
  if (!existsSync(source)) return undefined;
  const hash = createHash("sha1").update(readFileSync(source)).digest("hex").slice(0, 12);
  const dir = join(homedir(), ".cache", "open-herness");
  const bin = join(dir, `ocr-${hash}`);
  if (existsSync(bin)) return bin;
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${bin}.${process.pid}.tmp`;
    await run("swiftc", ["-O", source, "-o", tmp], { timeout: 240_000 });
    renameSync(tmp, bin);
    return bin;
  } catch {
    return undefined;
  }
}

async function onPath(cmd: string) {
  try {
    await run("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

export function getOcr(): Promise<Ocr | undefined> {
  ocrCache ??= (async () => {
    const bin = await visionHelper();
    if (bin)
      return {
        name: "apple-vision" as const,
        read: async (files: string[]) => {
          const out = new Map<string, OcrBox[]>();
          for (let i = 0; i < files.length; i += 24) {
            const batch = files.slice(i, i + 24);
            const { stdout } = await run(bin, batch, {
              maxBuffer: 64 * 1024 * 1024,
              timeout: 300_000,
            });
            for (const r of JSON.parse(stdout) as { file: string; items: OcrBox[] }[])
              out.set(r.file, r.items);
          }
          return out;
        },
      };
    if (await onPath("tesseract"))
      return {
        name: "tesseract" as const,
        read: async (files: string[]) => {
          const out = new Map<string, OcrBox[]>();
          for (const f of files) {
            const [{ stdout: tsv }, { stdout: dims }] = await Promise.all([
              run("tesseract", [f, "stdout", "tsv"], {
                maxBuffer: 64 * 1024 * 1024,
                timeout: 120_000,
              }),
              run("ffprobe", [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
                f,
              ]),
            ]);
            const [W, H] = dims.trim().split(",").map(Number) as [number, number];
            const lines = new Map<
              string,
              { words: string[]; conf: number[]; x0: number; y0: number; x1: number; y1: number }
            >();
            for (const row of tsv.split("\n").slice(1)) {
              const c = row.split("\t");
              if (c.length < 12 || c[0] !== "5" || !c[11]!.trim() || Number(c[10]) < 0) continue;
              const [l, t, ww, hh] = [Number(c[6]), Number(c[7]), Number(c[8]), Number(c[9])] as [
                number,
                number,
                number,
                number,
              ];
              const key = `${c[2]}-${c[3]}-${c[4]}`;
              const e = lines.get(key) ?? {
                words: [],
                conf: [],
                x0: l,
                y0: t,
                x1: l + ww,
                y1: t + hh,
              };
              e.words.push(c[11]!.trim());
              e.conf.push(Number(c[10]) / 100);
              e.x0 = Math.min(e.x0, l);
              e.y0 = Math.min(e.y0, t);
              e.x1 = Math.max(e.x1, l + ww);
              e.y1 = Math.max(e.y1, t + hh);
              lines.set(key, e);
            }
            out.set(
              f,
              [...lines.values()].map((e) => ({
                text: e.words.join(" "),
                confidence: e.conf.reduce((a, b) => a + b, 0) / e.conf.length,
                x: e.x0 / W,
                y: e.y0 / H,
                width: (e.x1 - e.x0) / W,
                height: (e.y1 - e.y0) / H,
              })),
            );
          }
          return out;
        },
      };
    return undefined;
  })();
  return ocrCache;
}

// ---------------------------------------------------------------------------------------------
// Platform UI safe-area zones, in px of a 1080x1920 canvas (top / bottom / left / right).
// ---------------------------------------------------------------------------------------------
export const SAFE_ZONES: Record<
  string,
  { top: number; bottom: number; left: number; right: number }
> = {
  shorts: { top: 288, bottom: 672, left: 48, right: 192 },
  tiktok: { top: 130, bottom: 484, left: 44, right: 140 },
  reels: { top: 269, bottom: 672, left: 65, right: 65 },
};

interface Zone {
  name: string;
  rect: Box; // x0, y0, x1, y1 exclusive, in the given frame's px
}
export function zonesFor(platform: string, w: number, h: number): Zone[] {
  const z = SAFE_ZONES[platform];
  if (!z) return [];
  const sx = w / 1080;
  const sy = h / 1920;
  return [
    { name: "top", rect: [0, 0, w, z.top * sy] },
    { name: "bottom", rect: [0, h - z.bottom * sy, w, h] },
    { name: "left", rect: [0, 0, z.left * sx, h] },
    { name: "right", rect: [w - z.right * sx, 0, w, h] },
  ];
}
const inside = (x: number, y: number, r: Box) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];

function tint(img: Img, r: Box, c: RGB, a = 0.25) {
  for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(img.h, Math.ceil(r[3])); y++)
    for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(img.w, Math.ceil(r[2])); x++)
      for (let k = 0; k < 3; k++)
        img.data[(y * img.w + x) * 3 + k] = Math.round(
          img.data[(y * img.w + x) * 3 + k]! * (1 - a) + c[k]! * a,
        );
}

/** Share of a box (normalised) lying inside any zone, plus which zones it touches. */
export function zoneOverlap(
  b: OcrBox,
  zones: Zone[],
  w: number,
  h: number,
): { share: number; names: string[] } {
  const N = 16;
  let hit = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = (b.x + ((i + 0.5) / N) * b.width) * w;
      const y = (b.y + ((j + 0.5) / N) * b.height) * h;
      if (zones.some((z) => inside(x, y, z.rect))) hit++;
    }
  const names = zones
    .filter((z) => {
      const r = z.rect;
      return (
        b.x * w < r[2] &&
        (b.x + b.width) * w > r[0] &&
        b.y * h < r[3] &&
        (b.y + b.height) * h > r[1]
      );
    })
    .map((z) => z.name);
  return { share: hit / (N * N), names };
}

// ---------------------------------------------------------------------------------------------
// Reading time of burned-in text.
// ---------------------------------------------------------------------------------------------
const CJK = /[⺀-鿿가-힯豈-﫿぀-ヿ]/u;
export function readingNeed(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const c of text.replace(/\s+/gu, "")) CJK.test(c) ? cjk++ : latin++;
  return Math.max(V.readMinSec, cjk / V.cjkPerSec + latin / V.latinPerSec + V.readPad);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++)
      m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let common = 0;
  for (const [g, c] of ga) common += Math.min(c, gb.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + b.length - 1);
}

interface Track {
  text: string;
  key: string;
  y: number;
  first: number;
  last: number;
}

export interface ReadingResult {
  tracks: {
    text: string;
    start: number;
    end: number;
    shown: number;
    needs: number;
    brief: boolean;
  }[];
}

export async function readingTime(
  src: string,
  dur: number,
  ocr: Ocr,
  dir: string,
): Promise<ReadingResult> {
  const step = Math.max(V.readStep, dur / V.readMaxSamples);
  const count = Math.max(1, Math.floor(dur / step));
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-i",
      src,
      "-an",
      "-vf",
      `fps=1/${step},scale='min(${V.ocrMaxWidth},iw)':-2`,
      "-frames:v",
      String(count),
      "-q:v",
      "4",
      join(dir, "r%05d.jpg"),
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
  );
  const files = Array.from({ length: count }, (_, i) =>
    join(dir, `r${String(i + 1).padStart(5, "0")}.jpg`),
  ).filter(existsSync);
  const read = await ocr.read(files);
  const open: Track[] = [];
  const done: Track[] = [];
  files.forEach((f, k) => {
    const found = (read.get(f) ?? []).filter(
      (b) => b.confidence >= V.ocrMinConfidence && norm(b.text).length >= 3,
    );
    const used = new Set<Track>();
    for (const b of found) {
      const key = norm(b.text);
      const t = open.find(
        (o) =>
          !used.has(o) && k - o.last <= 2 && Math.abs(o.y - b.y) < 0.1 && dice(o.key, key) >= 0.8,
      );
      if (t) {
        t.last = k;
        if (b.text.length > t.text.length) t.text = b.text;
        used.add(t);
      } else {
        const n: Track = { text: b.text, key, y: b.y, first: k, last: k };
        open.push(n);
        used.add(n);
      }
    }
    for (let i = open.length - 1; i >= 0; i--)
      if (k - open[i]!.last > 2) done.push(...open.splice(i, 1));
  });
  done.push(...open);
  const tracks = done
    .map((t) => {
      const shown = (t.last - t.first + 1) * step;
      const needs = readingNeed(t.text);
      return {
        text: t.text,
        start: t.first * step,
        end: (t.last + 1) * step,
        shown,
        needs,
        brief: shown < needs - step / 2,
      };
    })
    .sort((a, b) => a.start - b.start);
  return { tracks };
}

// ---------------------------------------------------------------------------------------------
// Orchestration for media_review.
// ---------------------------------------------------------------------------------------------
export interface VisionCtx {
  src: string;
  dur: number;
  still: boolean;
  width: number;
  height: number;
  fps: number;
  platform?: string;
  samples: number;
  edgeMargin: number;
  readText?: boolean;
  hasRecipeText: boolean;
  /** Saves an evidence still and returns the path to show the user. */
  save: (img: Img, name: string) => Promise<string>;
}

export async function visionChecks(c: VisionCtx, flags: Flag[], lines: string[]) {
  const times = c.still ? [undefined] : sampleTimes(c.dur, c.fps, c.samples);
  const dir = mkdtempSync(join(tmpdir(), "oh-vis-"));
  try {
    const frames: { t: number | undefined; file: string }[] = [];
    for (const [i, t] of times.entries()) {
      const file = join(dir, `s${i}.png`);
      try {
        await grabFrame(c.src, t, file, V.ocrMaxWidth);
        if (existsSync(file)) frames.push({ t, file });
      } catch {
        // frame not decodable: skip it
      }
    }
    if (!frames.length) return;

    // 1. Subject cut off by the frame edge.
    const margin = Math.max(1, Math.round((c.edgeMargin * V.analysisWidth) / c.width));
    const edgeFlags: { t: number | undefined; res: EdgeResult; file: string }[] = [];
    let measuredEdge = 0;
    let reason = "";
    for (const f of frames) {
      const img = await readImage(f.file, V.analysisWidth);
      const res = edgeAnalysis(img, margin);
      if (res.measured) measuredEdge++;
      else reason = res.reason ?? reason;
      if (res.measured && res.sides.length) edgeFlags.push({ t: f.t, res, file: f.file });
    }
    if (!measuredEdge) lines.push(`Frame edge: not measured (${reason || "no frames"}).`);
    else
      lines.push(
        `Frame edge: subject measured in ${measuredEdge} of ${frames.length} sample${frames.length === 1 ? "" : "s"}; ${edgeFlags.length} touch the edge.`,
      );
    for (const e of edgeFlags.slice(0, 4)) {
      const big = await readImage(e.file, Math.min(V.ocrMaxWidth, 960));
      const k = big.w / V.analysisWidth;
      const box = (b: Box, col: RGB) =>
        drawRect(big, b[0] * k, b[1] * k, (b[2] + 1) * k, (b[3] + 1) * k, col, 3);
      if (e.res.base) box(e.res.base, YELLOW);
      box(e.res.subject!, RED);
      drawText(
        big,
        4,
        4,
        `subject touches ${e.res.sides.join("+")}${e.t !== undefined ? ` @${fmt(e.t)}` : ""}`,
        [255, 120, 120],
        2,
      );
      const still = await c.save(big, `edge-${e.t !== undefined ? e.t.toFixed(2) : "still"}`);
      flags.push({
        severity: "warn",
        what: `Subject cut off: its box reaches the ${e.res.sides.join(" and ")} edge${e.res.sides.length > 1 ? "s" : ""} (within ${c.edgeMargin}px)${e.res.base ? "; base/pedestal below the neck is ignored" : ""}. Still: ${still}`,
        start: e.t,
        fix: "Reframe with breathing room around the whole subject: zoom out, move the camera/subject, or extend the canvas; if the crop is deliberate (macro, bleed) say so.",
      });
    }

    // 2. Platform UI zones + reading time need OCR.
    const wantSafe = !!c.platform && !!SAFE_ZONES[c.platform];
    const needOcr = wantSafe || c.readText !== false;
    if (!needOcr) return;
    const ocr = await getOcr();
    const z = wantSafe ? SAFE_ZONES[c.platform!]! : undefined;
    const zoneText = z
      ? `top ${z.top}, bottom ${z.bottom}, left ${z.left}, right ${z.right} px of 1080x1920${c.width / c.height > 0.6 ? " (frame is not 9:16: zones scaled proportionally)" : ""}`
      : "";
    if (!ocr) {
      if (wantSafe) {
        const mid = frames[Math.floor(frames.length / 2)]!;
        const img = await readImage(mid.file, Math.min(V.ocrMaxWidth, 720));
        for (const zn of zonesFor(c.platform!, img.w, img.h)) tint(img, zn.rect, YELLOW);
        const still = await c.save(img, "safe-area-zones");
        flags.push({
          severity: "info",
          what: `Platform safe-area text check not measured: no OCR available (install tesseract, or run on macOS with swiftc for Apple Vision). ${c.platform} UI zones: ${zoneText}. Zones drawn on ${still}.`,
          fix: "Open that still and keep text, faces and logos out of the yellow zones, or install an OCR host and re-run.",
        });
      }
      if (c.readText === true || c.hasRecipeText)
        flags.push({
          severity: "info",
          what: "On-screen text reading time not measured: no OCR available.",
          fix: "Install tesseract (or use macOS with swiftc) and re-run.",
        });
      return;
    }
    const read = await ocr.read(frames.map((f) => f.file));
    let anyText = false;
    if (wantSafe) {
      const groups = new Map<
        string,
        { text: string; names: string[]; times: number[]; share: number; sample: number }
      >();
      for (const [i, f] of frames.entries()) {
        const img = await readImage(f.file, Math.min(V.ocrMaxWidth, 1080));
        const zs = zonesFor(c.platform!, img.w, img.h);
        for (const b of read.get(f.file) ?? []) {
          if (b.confidence < V.ocrMinConfidence || !norm(b.text)) continue;
          anyText = true;
          const o = zoneOverlap(b, zs, img.w, img.h);
          if (o.share < V.zoneHitShare) continue;
          const key = `${norm(b.text)}|${o.names.join("+")}`;
          const g = groups.get(key) ?? {
            text: b.text,
            names: o.names,
            times: [],
            share: 0,
            sample: i,
          };
          if (f.t !== undefined) g.times.push(f.t);
          g.share = Math.max(g.share, o.share);
          groups.set(key, g);
        }
      }
      lines.push(
        `Safe area (${c.platform}, OCR ${ocr.name}): ${groups.size} text item${groups.size === 1 ? "" : "s"} inside UI zones. Zones: ${zoneText}.`,
      );
      let n = 0;
      for (const g of groups.values()) {
        let still = "";
        if (n++ < 4) {
          const f = frames[g.sample]!;
          const img = await readImage(f.file, Math.min(V.ocrMaxWidth, 720));
          const zs = zonesFor(c.platform!, img.w, img.h);
          for (const zn of zs) tint(img, zn.rect, YELLOW);
          for (const b of read.get(f.file) ?? []) {
            const o = zoneOverlap(b, zs, img.w, img.h);
            if (b.confidence >= V.ocrMinConfidence && o.share >= V.zoneHitShare)
              drawRect(
                img,
                b.x * img.w,
                b.y * img.h,
                (b.x + b.width) * img.w,
                (b.y + b.height) * img.h,
                RED,
                2,
              );
          }
          still = ` Still: ${await c.save(img, `safe-area-${g.sample}`)}`;
        }
        flags.push({
          severity: "warn",
          what: `Text "${g.text.slice(0, 60)}" sits in the ${c.platform} UI zone (${g.names.join(", ")}; ${(g.share * 100).toFixed(0)}% of the box)${g.times.length ? ` at ${g.times.map(fmt).join(", ")}` : ""}; the app's buttons/caption will cover it.${still}`,
          start: g.times[0],
          fix: `Move it inside the safe area (${zoneText}) or scale the layout down; keep captions clear of the right-hand button column and the bottom caption band.`,
        });
      }
    } else
      anyText = [...read.values()].some((v) =>
        v.some((b) => b.confidence >= V.ocrMinConfidence && norm(b.text)),
      );

    // 3. Reading time: only for pieces with burned-in text and a real duration.
    if (
      !c.still &&
      c.dur >= 1 &&
      (c.readText === true || (c.readText !== false && (anyText || c.hasRecipeText)))
    ) {
      const rdir = mkdtempSync(join(tmpdir(), "oh-read-"));
      try {
        const { tracks } = await readingTime(c.src, c.dur, ocr, rdir);
        if (!tracks.length) lines.push("Reading time: no on-screen text found.");
        else {
          const brief = tracks.filter((t) => t.brief);
          lines.push(
            `Reading time (OCR ${ocr.name}): ${tracks.length} text piece${tracks.length === 1 ? "" : "s"}, ${brief.length} on screen too briefly.`,
          );
          // 3+ consecutive too-brief pieces that follow each other are one animated/changing text.
          const used = new Set<number>();
          for (let i = 0; i < brief.length; i++) {
            if (used.has(i)) continue;
            const chain = [i];
            while (
              brief[chain.at(-1)! + 1] &&
              brief[chain.at(-1)! + 1]!.start <= brief[chain.at(-1)!]!.end + 2 * V.readStep
            )
              chain.push(chain.at(-1)! + 1);
            if (chain.length >= 3) {
              chain.forEach((k) => used.add(k));
              flags.push({
                severity: "warn",
                what: `On-screen text changes ${chain.length} times too briefly (${fmt(brief[i]!.start)}-${fmt(brief[chain.at(-1)!]!.end)}, e.g. "${brief[i]!.text.slice(0, 40)}"): none of the steps can be read.`,
                start: brief[i]!.start,
                end: brief[chain.at(-1)!]!.end,
                fix: "Give the viewer the finished text and hold it long enough, instead of animating word by word or swapping fragments.",
              });
            }
          }
          let listed = 0;
          brief.forEach((t, i) => {
            if (used.has(i)) return;
            if (++listed > 12) {
              if (listed === 13)
                flags.push({
                  severity: "info",
                  what: `${brief.filter((_, k) => !used.has(k)).length - 12} more text pieces are on screen too briefly (first 12 listed); likely a terminal/UI screen recording or animated text.`,
                  fix: "Slow the screen recording down or hold key lines; use a callout with the finished text for what the viewer must read.",
                });
              return;
            }
            flags.push({
              severity: "warn",
              what: `Text "${t.text.slice(0, 60)}" is shown ${t.shown.toFixed(1)}s but needs ${t.needs.toFixed(1)}s to read.`,
              start: t.start,
              end: t.end,
              fix: `Hold it for at least ${t.needs.toFixed(1)}s (max(1.5, cjk/4.5 + latin/15 + 1.5) s), shorten the copy, or split it across scenes.`,
            });
          });
        }
      } finally {
        rmSync(rdir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

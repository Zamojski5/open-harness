// Tiny raster toolkit for measured QA: decode frames to raw RGB through ffmpeg, measure them in Node,
// draw boxes and labels (built-in 5x7 font, no fontconfig needed) and encode contact sheets back to JPEG.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Img {
  w: number;
  h: number;
  data: Uint8Array; // RGB24, row-major
}
export type RGB = [number, number, number];

export const newImg = (w: number, h: number, fill: RGB = [32, 32, 32]): Img => {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 3);
  return { w, h, data };
};

/** Display size of the first video stream (rotation-aware). */
export async function mediaSize(src: string): Promise<{ w: number; h: number }> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation", "-of", "json", src]);
  const s = (JSON.parse(stdout) as { streams?: { width?: number; height?: number; side_data_list?: { rotation?: number }[] }[] }).streams?.[0];
  if (!s?.width || !s.height) throw new Error(`No picture in ${src}`);
  const rot = Math.abs(s.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) === 90;
  return rot ? { w: s.height, h: s.width } : { w: s.width, h: s.height };
}

/** Even analysis size with the given width (height follows the aspect). */
export const fitWidth = (size: { w: number; h: number }, width: number) => ({ w: width, h: Math.max(2, Math.round((width * size.h) / size.w / 2) * 2) });

/**
 * Streams decoded frames (scaled to w x h) to onFrame; resolves with the frame count.
 * gray=true gives 1 byte per pixel (luma), else RGB24. onFrame may return false to stop early.
 */
export function streamFrames(src: string, w: number, h: number, onFrame: (frame: Uint8Array, index: number) => boolean | void, opts: { gray?: boolean; maxFrames?: number; inputArgs?: string[]; filter?: string } = {}): Promise<number> {
  const bpp = opts.gray ? 1 : 3;
  const size = w * h * bpp;
  const vf = `${opts.filter ? `${opts.filter},` : ""}scale=${w}:${h}:flags=area`;
  const args = ["-v", "error", ...(opts.inputArgs ?? []), "-i", src, "-an", "-sn", "-vf", vf, "-fps_mode", "passthrough", ...(opts.maxFrames ? ["-frames:v", String(opts.maxFrames)] : []), "-f", "rawvideo", "-pix_fmt", opts.gray ? "gray" : "rgb24", "-"];
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let pending: Buffer[] = [];
    let have = 0;
    let n = 0;
    let stopped = false;
    let err = "";
    ff.stderr.on("data", (c: Buffer) => {
      err = (err + c.toString()).slice(-4000);
    });
    ff.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      pending.push(chunk);
      have += chunk.length;
      if (have < size) return;
      let buf = Buffer.concat(pending, have);
      let off = 0;
      while (buf.length - off >= size && !stopped) {
        // Copy so callers may keep the frame.
        const frame = new Uint8Array(buf.subarray(off, off + size));
        off += size;
        if (onFrame(frame, n++) === false) {
          stopped = true;
          ff.kill("SIGKILL");
        }
      }
      buf = buf.subarray(off);
      pending = buf.length ? [buf] : [];
      have = buf.length;
    });
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 || stopped ? resolve(n) : reject(new Error(`ffmpeg failed (${code}): ${err}`))));
  });
}

/** First frame of an image/video as RGB at the given width (height from aspect unless given). */
export async function readImage(src: string, width: number, height?: number, inputArgs: string[] = []): Promise<Img> {
  const size = height ? { w: width, h: height } : fitWidth(await mediaSize(src), width);
  let img: Img | undefined;
  await streamFrames(
    src,
    size.w,
    size.h,
    (f) => {
      img = { w: size.w, h: size.h, data: f };
      return false;
    },
    { maxFrames: 1, inputArgs },
  );
  if (!img) throw new Error(`Could not decode ${src}`);
  return img;
}

/** RGB → luma (Rec.709 weights on the encoded values, 0-255). */
export function luma(img: Img): Uint8Array {
  const out = new Uint8Array(img.w * img.h);
  const d = img.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 3) out[i] = (d[j]! * 54 + d[j + 1]! * 183 + d[j + 2]! * 19) >> 8;
  return out;
}

/** Mean absolute difference of two equally sized luma planes. */
export function mad(a: Uint8Array, b: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

export function crop(img: Img, x0: number, y0: number, x1: number, y1: number): Img {
  const ax = Math.max(0, Math.floor(x0));
  const ay = Math.max(0, Math.floor(y0));
  const w = Math.max(1, Math.min(img.w, Math.ceil(x1)) - ax);
  const h = Math.max(1, Math.min(img.h, Math.ceil(y1)) - ay);
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((ay + y) * img.w + ax) * 3, ((ay + y) * img.w + ax + w) * 3), y * w * 3);
  return { w, h, data: out };
}

/** Area-average downscale so the long side is at most maxSide. */
export function shrink(img: Img, maxSide: number): Img {
  const k = Math.max(img.w, img.h) / maxSide;
  if (k <= 1) return img;
  const w = Math.max(1, Math.round(img.w / k));
  const h = Math.max(1, Math.round(img.h / k));
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * img.h) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.h) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.w) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.w) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = sy0; yy < sy1; yy++)
        for (let xx = sx0; xx < sx1; xx++) {
          const j = (yy * img.w + xx) * 3;
          r += img.data[j]!;
          g += img.data[j + 1]!;
          b += img.data[j + 2]!;
        }
      const n = (sy1 - sy0) * (sx1 - sx0);
      out.set([r / n, g / n, b / n], (y * w + x) * 3);
    }
  }
  return { w, h, data: out };
}

/** Nearest-neighbour resize (for laying out cells). */
export function resize(img: Img, w: number, h: number): Img {
  if (img.w === w && img.h === h) return img;
  const src = img.w > w * 2 || img.h > h * 2 ? shrink(img, Math.max(w, h) * 1.5) : img;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor(((y + 0.5) * src.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.floor(((x + 0.5) * src.w) / w));
      const j = (sy * src.w + sx) * 3;
      out[(y * w + x) * 3] = src.data[j]!;
      out[(y * w + x) * 3 + 1] = src.data[j + 1]!;
      out[(y * w + x) * 3 + 2] = src.data[j + 2]!;
    }
  }
  return { w, h, data: out };
}

export function fillRect(img: Img, x0: number, y0: number, x1: number, y1: number, c: RGB) {
  const ax = Math.max(0, Math.round(x0));
  const ay = Math.max(0, Math.round(y0));
  const bx = Math.min(img.w, Math.round(x1));
  const by = Math.min(img.h, Math.round(y1));
  for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) img.data.set(c, (y * img.w + x) * 3);
}

export function drawRect(img: Img, x0: number, y0: number, x1: number, y1: number, c: RGB, t = 2) {
  fillRect(img, x0, y0, x1, y0 + t, c);
  fillRect(img, x0, y1 - t, x1, y1, c);
  fillRect(img, x0, y0, x0 + t, y1, c);
  fillRect(img, x1 - t, y0, x1, y1, c);
}

// 5x7 font: 7 rows of 5 columns, '#' = ink. Lowercase is drawn as uppercase.
const GLYPHS: Record<string, string> = {
  A: ".###.|#...#|#...#|#####|#...#|#...#|#...#",
  B: "####.|#...#|#...#|####.|#...#|#...#|####.",
  C: ".###.|#...#|#....|#....|#....|#...#|.###.",
  D: "####.|#...#|#...#|#...#|#...#|#...#|####.",
  E: "#####|#....|#....|####.|#....|#....|#####",
  F: "#####|#....|#....|####.|#....|#....|#....",
  G: ".###.|#...#|#....|#.###|#...#|#...#|.####",
  H: "#...#|#...#|#...#|#####|#...#|#...#|#...#",
  I: ".###.|..#..|..#..|..#..|..#..|..#..|.###.",
  J: "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
  K: "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
  L: "#....|#....|#....|#....|#....|#....|#####",
  M: "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
  N: "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
  O: ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
  P: "####.|#...#|#...#|####.|#....|#....|#....",
  Q: ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
  R: "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
  S: ".####|#....|#....|.###.|....#|....#|####.",
  T: "#####|..#..|..#..|..#..|..#..|..#..|..#..",
  U: "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
  V: "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
  W: "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.",
  X: "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
  Y: "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
  Z: "#####|....#|...#.|..#..|.#...|#....|#####",
  "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
  "1": "..#..|.##..|..#..|..#..|..#..|..#..|.###.",
  "2": ".###.|#...#|....#|...#.|..#..|.#...|#####",
  "3": "####.|....#|....#|.###.|....#|....#|####.",
  "4": "...#.|..##.|.#.#.|#..#.|#####|...#.|...#.",
  "5": "#####|#....|####.|....#|....#|#...#|.###.",
  "6": ".###.|#....|#....|####.|#...#|#...#|.###.",
  "7": "#####|....#|...#.|..#..|.#...|.#...|.#...",
  "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.",
  "9": ".###.|#...#|#...#|.####|....#|....#|.###.",
  " ": ".....|.....|.....|.....|.....|.....|.....",
  ".": ".....|.....|.....|.....|.....|.##..|.##..",
  ",": ".....|.....|.....|.....|.##..|..#..|.#...",
  ":": ".....|.##..|.##..|.....|.##..|.##..|.....",
  "-": ".....|.....|.....|#####|.....|.....|.....",
  "+": ".....|..#..|..#..|#####|..#..|..#..|.....",
  "_": ".....|.....|.....|.....|.....|.....|#####",
  "/": "....#|....#|...#.|..#..|.#...|#....|#....",
  "%": "##...|##..#|...#.|..#..|.#...|#..##|...##",
  "(": "...#.|..#..|.#...|.#...|.#...|..#..|...#.",
  ")": ".#...|..#..|...#.|...#.|...#.|..#..|.#...",
  "#": ".#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.",
  "=": ".....|.....|#####|.....|#####|.....|.....",
  "?": ".###.|#...#|....#|...#.|..#..|.....|..#..",
  "!": "..#..|..#..|..#..|..#..|..#..|.....|..#..",
  "'": "..#..|..#..|.#...|.....|.....|.....|.....",
  ">": ".#...|..#..|...#.|....#|...#.|..#..|.#...",
  "<": "...#.|..#..|.#...|#....|.#...|..#..|...#.",
  "*": ".....|#.#.#|.###.|#####|.###.|#.#.#|.....",
};

export const textWidth = (s: string, scale = 2) => s.length * 6 * scale;

/** Draws a label with a dark backing box so it reads on any picture. */
export function drawText(img: Img, x: number, y: number, s: string, c: RGB = [255, 255, 255], scale = 2, bg: RGB | null = [0, 0, 0]) {
  const maxChars = Math.max(0, Math.floor((img.w - x - 2 * scale) / (6 * scale)));
  const str = s.length > maxChars ? s.slice(0, Math.max(0, maxChars - 1)) + "~" : s;
  if (bg) fillRect(img, x, y, x + textWidth(str, scale) + 2 * scale, y + 9 * scale, bg);
  let cx = x + scale;
  for (const ch of str) {
    const g = GLYPHS[ch.toUpperCase()] ?? GLYPHS["?"]!;
    g.split("|").forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) if (row[rx] === "#") fillRect(img, cx + rx * scale, y + scale + ry * scale, cx + (rx + 1) * scale, y + scale + (ry + 1) * scale, c);
    });
    cx += 6 * scale;
  }
}

export function paste(dst: Img, src: Img, x: number, y: number) {
  for (let r = 0; r < src.h; r++) {
    const dy = y + r;
    if (dy < 0 || dy >= dst.h) continue;
    const w = Math.min(src.w, dst.w - x);
    if (w <= 0) continue;
    dst.data.set(src.data.subarray(r * src.w * 3, (r * src.w + w) * 3), (dy * dst.w + x) * 3);
  }
}

/** Grid of equally sized cells (row-major), cells resized to cw x ch. */
export function grid(cells: (Img | undefined)[], cols: number, cw: number, ch: number, pad = 4, bg: RGB = [255, 255, 255]): Img {
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  const out = newImg(cols * cw + (cols + 1) * pad, rows * ch + (rows + 1) * pad, bg);
  cells.forEach((c, i) => {
    if (c) paste(out, resize(c, cw, ch), pad + (i % cols) * (cw + pad), pad + Math.floor(i / cols) * (ch + pad));
  });
  return out;
}

/** Encodes an RGB image to a JPEG file; returns base64. */
export function writeJpeg(img: Img, out: string, quality = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${img.w}x${img.h}`, "-i", "-", "-frames:v", "1", "-q:v", String(quality), out], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (c: Buffer) => (err += c.toString()));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg encode failed: ${err}`));
      resolve(readFileSync(out).toString("base64"));
    });
    ff.stdin.end(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
  });
}

// ---------------------------------------------------------------------------------------------
// Colour + texture measures (sRGB in, CIE Lab D65 out).
// ---------------------------------------------------------------------------------------------
const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const LIN = Float32Array.from({ length: 256 }, (_, i) => lin(i));
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export interface Look {
  L: number; // mean lightness 0-100
  a: number; // mean a* (+ magenta / - green)
  b: number; // mean b* (+ yellow / - blue)
  chroma: number; // mean per-pixel chroma (saturation)
  contrast: number; // std of L*
  highlights: number; // specular peak: L* of the brightest 0.5% minus the 90th percentile
  texture: number; // mean |L* - 3x3 mean| at 128 px long side, lowest 90% (fine surface detail)
  px: number;
}

export function measureLook(img: Img): Look {
  const s = shrink(img, 128);
  const n = s.w * s.h;
  const L = new Float32Array(n);
  let sl = 0;
  let sa = 0;
  let sb = 0;
  let sc = 0;
  for (let i = 0; i < n; i++) {
    const r = LIN[s.data[i * 3]!]!;
    const g = LIN[s.data[i * 3 + 1]!]!;
    const b = LIN[s.data[i * 3 + 2]!]!;
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fy = fLab(Y);
    const l = 116 * fy - 16;
    const aa = 500 * (fLab(X) - fy);
    const bb = 200 * (fy - fLab(Z));
    L[i] = l;
    sl += l;
    sa += aa;
    sb += bb;
    sc += Math.hypot(aa, bb);
  }
  const mean = sl / n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (L[i]! - mean) ** 2;
  const std = Math.sqrt(v / n);
  const sorted = Float32Array.from(L).sort();
  const pct = (q: number) => sorted[Math.min(n - 1, Math.floor(n * q))]!;
  // Fine detail: |L - 3x3 mean|, averaged over the lowest 90% so silhouette edges don't dominate.
  const hf: number[] = [];
  for (let y = 1; y < s.h - 1; y++)
    for (let x = 1; x < s.w - 1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += L[(y + dy) * s.w + x + dx]!;
      hf.push(Math.abs(L[y * s.w + x]! - m / 9));
    }
  hf.sort((p, q) => p - q);
  const keep = Math.max(1, Math.floor(hf.length * 0.9));
  let tex = 0;
  for (let i = 0; i < keep && i < hf.length; i++) tex += hf[i]!;
  return { L: mean, a: sa / n, b: sb / n, chroma: sc / n, contrast: std, highlights: pct(0.995) - pct(0.9), texture: hf.length ? tex / keep : 0, px: n };
}

/** Hue name for a mean (a*, b*) offset. */
export function hueName(a: number, b: number): string {
  const ang = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const names: [number, string][] = [[25, "magenta-red"], [80, "orange/warm"], [105, "yellow"], [135, "yellow-green"], [190, "green"], [250, "cyan/teal"], [300, "blue/cool"], [345, "purple"], [361, "magenta-red"]];
  return names.find(([lim]) => ang < lim)![1];
}

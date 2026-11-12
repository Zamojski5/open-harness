// Boundary and flash analysis for media_flicker: every decoded frame is compared with its predecessor in 8x8 px cells
// (share of pixels whose channel moved by more than 32). From that: cuts, overlay/picture changes, and 1-2 frame
// flashes that REVERSE (the picture leaves the before/after band and comes back). Boundaries get stills at frames
// -2..+2 plus boundaries.json; with a recipe sidecar we also report overlay timing problems.

import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fitWidth, streamFrames } from "./raster.ts";
import type { Recipe } from "./review-extra.ts";

const run = promisify(execFile);

export const B = {
  cell: 8,
  delta: 32, // channel change that counts as "moved"
  match: 10, // before/after pictures match within this
  jumpShare: 0.1, // a cell must change on this share of its pixels
  jumpShareFull: 0.03,
  jumpRatio: 4, // ... and by this factor over the same cell's neighbouring steps
  cutRatio: 3, // whole-frame change factor over neighbouring steps
  cutTotal: 0.15, // total share separating a cut from an overlay/picture change
  reverseShare: 0.1,
  ringMoving: 0.1,
  ringTotal: 0.3,
  maxSeconds: 0.15,
  minScore: 0.1,
  maxStills: 2000,
  eps: 0.002,
};

export interface Flash {
  frame: number;
  length: 1 | 2;
  time: number;
  score: number;
  cells: number;
}
export interface Boundary {
  frame: number;
  time: number;
  kind: "start" | "end" | "cut" | "change" | "input" | "overlay";
}
export interface BoundaryResult {
  flashes: Flash[];
  detected: Boundary[];
  frames: number;
  w: number;
  h: number;
  fullRes: boolean;
}

interface Step {
  cells: Float32Array;
  total: number;
}

export async function analyzeBoundaries(
  src: string,
  size: { w: number; h: number },
  fps: number,
  fullRes: boolean,
): Promise<BoundaryResult> {
  const width = fullRes ? Math.min(size.w - (size.w % 2), 2560) : 320;
  const { w, h } = fitWidth(size, width);
  const gray = fullRes;
  const bpp = gray ? 1 : 3;
  const cols = Math.ceil(w / B.cell);
  const rows = Math.ceil(h / B.cell);
  const jumpShare = fullRes ? B.jumpShareFull : B.jumpShare;
  const frames: Uint8Array[] = []; // last 6 frames
  const steps: Step[] = []; // last 6 steps (step k = frame k-1 -> k)
  const flashes: Flash[] = [];
  const detected: Boundary[] = [];
  const cellPixels = (c: number) => {
    const cx = c % cols;
    const cy = Math.floor(c / cols);
    return {
      x0: cx * B.cell,
      x1: Math.min(w, (cx + 1) * B.cell),
      y0: cy * B.cell,
      y1: Math.min(h, (cy + 1) * B.cell),
    };
  };

  const moved = (a: Uint8Array, b: Uint8Array, p: number, d: number) => {
    for (let k = 0; k < bpp; k++) if (Math.abs(a[p * bpp + k]! - b[p * bpp + k]!) > d) return true;
    return false;
  };
  const stepOf = (a: Uint8Array, b: Uint8Array): Step => {
    const cells = new Float32Array(cols * rows);
    let total = 0;
    for (let y = 0; y < h; y++) {
      const row = Math.floor(y / B.cell) * cols;
      for (let x = 0; x < w; x++)
        if (moved(a, b, y * w + x, B.delta)) {
          cells[row + Math.floor(x / B.cell)]!++;
          total++;
        }
    }
    for (let c = 0; c < cells.length; c++) {
      const p = cellPixels(c);
      cells[c] = cells[c]! / ((p.x1 - p.x0) * (p.y1 - p.y0));
    }
    return { cells, total: total / (w * h) };
  };

  // Frame n lives at frames[n - base]; step k at steps[k - sbase].
  let base = 0;
  let sbase = 1;
  const F = (n: number) => frames[n - base];
  const S = (k: number) => steps[k - sbase];

  // Cells that jump at step k, compared with the same cell one step OUTSIDE the flash (before the entry, after the exit).
  const jumpedCells = (k: number, outside: number): Set<number> => {
    const e = S(k)!;
    const o = S(outside);
    const out = new Set<number>();
    for (let c = 0; c < e.cells.length; c++) {
      const v = e.cells[c]!;
      if (v >= jumpShare && v > B.jumpRatio * Math.max(o?.cells[c] ?? 0, B.eps)) out.add(c);
    }
    return out;
  };

  const evalFlash = (f: number, length: 1 | 2) => {
    const entry = S(f);
    const exit = S(f + length);
    const first = F(f - 1);
    const last = F(f + length);
    if (!entry || !exit || !first || !last) return;
    if (length / fps >= B.maxSeconds) return;
    if (length === 2) {
      const mid = S(f + 1);
      if (!mid || mid.total >= Math.min(entry.total, exit.total) / 2) return;
    }
    const a = jumpedCells(f, f - 1);
    const b = jumpedCells(f + length, f + length + 1);
    const cells = [...a].filter((c) => b.has(c));
    if (cells.length < 2) return; // our own guard: one lone 8 px cell is a moving thin line or digit, not a flash
    let score = 0;
    for (const c of cells) score = Math.max(score, Math.min(entry.cells[c]!, exit.cells[c]!));
    if (score < (fullRes ? B.minScore : B.jumpShare)) return;
    // The picture must leave the first/last band in the middle frames and come back.
    let px = 0;
    let out = 0;
    let same = 0;
    for (const c of cells) {
      const p = cellPixels(c);
      for (let y = p.y0; y < p.y1; y++)
        for (let x = p.x0; x < p.x1; x++) {
          const i = y * w + x;
          px++;
          let leaves = false;
          let matches = true;
          for (let k = 0; k < bpp; k++) {
            const lo = Math.min(first[i * bpp + k]!, last[i * bpp + k]!) - B.delta;
            const hi = Math.max(first[i * bpp + k]!, last[i * bpp + k]!) + B.delta;
            for (let m = f; m < f + length; m++) {
              const v = F(m)![i * bpp + k]!;
              if (v < lo || v > hi) leaves = true;
            }
            if (Math.abs(first[i * bpp + k]! - last[i * bpp + k]!) > B.match) matches = false;
          }
          if (leaves) out++;
          if (matches) same++;
        }
    }
    if (out / px < B.reverseShare || same / px < 0.5) return;
    // Faint flashes: reject when the ring around them is itself moving (real motion, not a pop).
    if (entry.total < B.ringTotal && exit.total < B.ringTotal) {
      const jumped = new Set(cells);
      const ring = new Set<number>();
      for (const c of cells) {
        const cx = c % cols;
        const cy = Math.floor(c / cols);
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            const n = ny * cols + nx;
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !jumped.has(n)) ring.add(n);
          }
      }
      if (ring.size) {
        let moving = 0;
        for (const c of ring) {
          const p = cellPixels(c);
          let n = 0;
          for (let y = p.y0; y < p.y1; y++)
            for (let x = p.x0; x < p.x1; x++) if (moved(first, last, y * w + x, B.delta)) n++;
          if (n / ((p.x1 - p.x0) * (p.y1 - p.y0)) >= B.jumpShare) moving++;
        }
        if (moving / ring.size > B.ringMoving) return;
      }
    }
    flashes.push({ frame: f, length, time: f / fps, score, cells: cells.length });
  };

  const n = await streamFrames(
    src,
    w,
    h,
    (frame, i) => {
      frames.push(frame);
      if (frames.length > 6) {
        frames.shift();
        base++;
      }
      if (i === 0) return;
      steps.push(stepOf(F(i - 1)!, frame));
      if (steps.length > 6) {
        steps.shift();
        sbase++;
      }
      // Cut / overlay change at step i-1 now that both neighbours are known.
      const k = i - 1;
      const cur = S(k);
      const prev = S(k - 1);
      if (
        cur &&
        prev &&
        cur.total > B.cutRatio * Math.max(prev.total, B.eps) &&
        cur.total > B.cutRatio * Math.max(S(i)!.total, B.eps)
      ) {
        let hot = false;
        for (let c = 0; c < cur.cells.length && !hot; c++)
          hot =
            cur.cells[c]! >= jumpShare &&
            cur.cells[c]! > B.jumpRatio * Math.max(prev.cells[c]!, B.eps) &&
            cur.cells[c]! > B.jumpRatio * Math.max(S(i)!.cells[c]!, B.eps);
        if (hot)
          detected.push({
            frame: k,
            time: k / fps,
            kind: cur.total >= B.cutTotal ? "cut" : "change",
          });
      }
      // Flashes of 1 and 2 frames are judged once the step after the exit exists.
      if (i - 3 >= 1) evalFlash(i - 2, 1);
      if (i - 4 >= 1 && !flashes.some((g) => g.frame >= i - 5 && g.frame <= i - 2))
        evalFlash(i - 3, 2);
    },
    { gray, filter: "" },
  );
  // Flash entry/exit steps are not cuts.
  for (let i = detected.length - 1; i >= 0; i--)
    if (
      flashes.some((f) => detected[i]!.frame >= f.frame && detected[i]!.frame <= f.frame + f.length)
    )
      detected.splice(i, 1);
  detected.unshift({ frame: 0, time: 0, kind: "start" });
  detected.push({ frame: Math.max(0, n - 1), time: Math.max(0, n - 1) / fps, kind: "end" });
  return { flashes, detected, frames: n, w, h, fullRes };
}

// ---------------------------------------------------------------------------------------------
// Boundary stills + boundaries.json.
// ---------------------------------------------------------------------------------------------
export async function writeBoundaryStills(
  src: string,
  boundaries: Boundary[],
  outDir: string,
  fps: number,
  maxFrame: number,
): Promise<{ files: number; capped: boolean }> {
  const cap = Math.floor(B.maxStills / 5);
  const list = boundaries.slice(0, cap);
  const capped = boundaries.length > list.length;
  mkdirSync(outDir, { recursive: true });
  const wanted = new Map<number, string[]>(); // frame -> file names
  const entries = list.map((b, idx) => {
    const stills: string[] = [];
    for (let o = -2; o <= 2; o++) {
      const fr = b.frame + o;
      if (fr < 0 || fr > maxFrame) continue;
      const name = `b${String(idx + 1).padStart(3, "0")}-${b.kind}-t${b.time.toFixed(2)}-f${o >= 0 ? "+" : ""}${o}.jpg`;
      stills.push(name);
      wanted.set(fr, [...(wanted.get(fr) ?? []), name]);
    }
    return {
      index: idx + 1,
      kind: b.kind,
      time: Number(b.time.toFixed(3)),
      frame: b.frame,
      fps,
      stills,
    };
  });
  const order = [...wanted.keys()].sort((a, b) => a - b);
  if (order.length) {
    const tmp = mkdtempSync(join(tmpdir(), "oh-bnd-"));
    try {
      const expr = order.map((f) => `eq(n\\,${f})`).join("+");
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          src,
          "-an",
          "-vf",
          `select='${expr}',scale='min(960,iw)':-2`,
          "-fps_mode",
          "passthrough",
          "-q:v",
          "3",
          join(tmp, "%05d.jpg"),
        ],
        { maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 },
      );
      const made = readdirSync(tmp).sort();
      made.forEach((f, i) => {
        for (const name of wanted.get(order[i]!) ?? [])
          copyFileSync(join(tmp, f), join(outDir, name));
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  writeFileSync(
    join(outDir, "boundaries.json"),
    JSON.stringify({ source: src, fps, boundaries: entries }, null, 2),
  );
  return { files: new Set([...wanted.values()].flat()).size, capped };
}

// ---------------------------------------------------------------------------------------------
// Recipe timing findings.
// ---------------------------------------------------------------------------------------------
export function recipeTiming(
  r: Recipe,
  fps: number,
  cutTimes: number[],
): { what: string; time: number; fix: string }[] {
  const out: { what: string; time: number; fix: string }[] = [];
  const grid = (t: number) => Math.abs(t * fps - Math.round(t * fps)) > 0.02;
  const overlays = [
    ...r.text.map((o) => ({ ...o, kind: "text" })),
    ...r.logos.map((o) => ({ ...o, kind: "logo" })),
  ].filter((o) => o.start !== undefined && o.end !== undefined);
  for (const o of overlays) {
    for (const [label, t] of [
      ["in", o.start!],
      ["out", o.end!],
    ] as const) {
      if (grid(t))
        out.push({
          what: `${o.kind} overlay ${label} time ${t.toFixed(3)}s is off the ${fps} fps frame grid (frame ${(t * fps).toFixed(2)}): it will land on a different frame than planned.`,
          time: t,
          fix: "Snap overlay times to round(t*fps)/fps in the recipe.",
        });
      for (const c of cutTimes) {
        const d = Math.abs(t - c) * fps;
        if (d > 0.5 && d <= 2.5)
          out.push({
            what: `${o.kind} overlay ${label} at ${t.toFixed(2)}s is ${d.toFixed(0)} frame${d < 1.5 ? "" : "s"} from the cut at ${c.toFixed(2)}s: it will read as a flash/pop instead of changing with the cut.`,
            time: t,
            fix: "Move the overlay edge exactly onto the cut frame, or at least 3 frames away.",
          });
      }
    }
  }
  const byPos = new Map<string, typeof overlays>();
  for (const o of overlays)
    byPos.set(`${o.kind}:${o.position ?? ""}`, [
      ...(byPos.get(`${o.kind}:${o.position ?? ""}`) ?? []),
      o,
    ]);
  for (const list of byPos.values()) {
    list.sort((a, b) => a.start! - b.start!);
    for (let i = 1; i < list.length; i++) {
      const gap = (list[i]!.start! - list[i - 1]!.end!) * fps;
      if (Math.abs(gap) > 0.5 && Math.abs(gap) <= 2.5)
        out.push({
          what: `${gap > 0 ? "Gap" : "Overlap"} of ${Math.abs(gap).toFixed(0)} frame${Math.abs(gap) < 1.5 ? "" : "s"} between two ${list[i]!.kind} overlays at the same position (${list[i - 1]!.end!.toFixed(2)}s).`,
          time: list[i]!.start!,
          fix: "Make consecutive overlays at one position butt exactly (end = next start), or separate them clearly.",
        });
    }
  }
  return out;
}

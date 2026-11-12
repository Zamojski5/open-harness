// Geometry readers: Figma's pre-flattened path blobs and editable vector networks, plus computed
// rounded rectangles and ellipses. All produce command lists in node-local coordinates.

import { apply, type Matrix } from "../decode/model.ts";

export type Cmd =
  | { op: "M" | "L"; p: number[] }
  | { op: "Q"; p: number[] }
  | { op: "C"; p: number[] }
  | { op: "Z"; p: [] };

export class BlobError extends Error {}

/**
 * Path blob: one-byte opcodes, each followed by little-endian float32 operands, no padding.
 * 0 = subpath break, 1 = move (2), 2 = line (2), 3 = quadratic curve (4), 4 = cubic (6).
 * If that reading fails, retry once with opcode 3 as an operand-less close-path (written that way
 * by some third-party encoders).
 */
export function parsePathBlob(bytes: Uint8Array): Cmd[] {
  try {
    return readPath(bytes, false);
  } catch {
    return readPath(bytes, true);
  }
}

function readPath(bytes: Uint8Array, legacyClose: boolean): Cmd[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Cmd[] = [];
  let i = 0;
  const floats = (n: number) => {
    if (i + n * 4 > bytes.length) throw new BlobError("path blob truncated");
    const v: number[] = [];
    for (let k = 0; k < n; k++, i += 4) {
      const f = view.getFloat32(i, true);
      if (!Number.isFinite(f)) throw new BlobError("path blob has a non-finite number");
      v.push(f);
    }
    return v;
  };
  let open = false;
  while (i < bytes.length) {
    const op = bytes[i++];
    if (op === 0 || (legacyClose && op === 3)) {
      if (open) out.push({ op: "Z", p: [] });
      open = false;
    } else if (op === 1) {
      if (open) out.push({ op: "Z", p: [] });
      out.push({ op: "M", p: floats(2) });
      open = true;
    } else if (op === 2) out.push({ op: "L", p: floats(2) });
    else if (op === 3) out.push({ op: "Q", p: floats(4) });
    else if (op === 4) out.push({ op: "C", p: floats(6) });
    else throw new BlobError(`unknown path opcode ${op}`);
  }
  if (open) out.push({ op: "Z", p: [] });
  if (out.length && out[0]!.op !== "M") throw new BlobError("path blob does not start with a move");
  return out;
}

export interface Network {
  vertices: { x: number; y: number; style: number }[];
  segments: {
    start: number;
    end: number;
    ts: [number, number];
    te: [number, number];
    style: number;
  }[];
  regions: { nonzero: boolean; loops: number[][] }[];
}

/** Vector network blob: counts, vertices, segments, regions; little-endian and unaligned. */
export function parseNetwork(bytes: Uint8Array): Network {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const u = () => {
    if (i + 4 > bytes.length) throw new BlobError("vector network truncated");
    const v = view.getUint32(i, true);
    i += 4;
    return v;
  };
  const f = () => {
    if (i + 4 > bytes.length) throw new BlobError("vector network truncated");
    const v = view.getFloat32(i, true);
    i += 4;
    return v;
  };
  const nv = u();
  const ns = u();
  const nr = u();
  if (nv > 1e6 || ns > 1e6 || nr > 1e6) throw new BlobError("vector network counts implausible");
  const vertices: Network["vertices"] = [];
  for (let k = 0; k < nv; k++) {
    const style = u();
    vertices.push({ style, x: f(), y: f() });
  }
  const segments: Network["segments"] = [];
  for (let k = 0; k < ns; k++) {
    const style = u();
    const start = u();
    const ts: [number, number] = [f(), f()];
    const end = u();
    const te: [number, number] = [f(), f()];
    if (start >= nv || end >= nv)
      throw new BlobError("vector network segment points past its vertices");
    segments.push({ style, start, ts, end, te });
  }
  const regions: Network["regions"] = [];
  for (let k = 0; k < nr; k++) {
    const flags = u();
    const nl = u();
    const loops: number[][] = [];
    for (let l = 0; l < nl; l++) {
      const len = u();
      const loop: number[] = [];
      for (let s = 0; s < len; s++) loop.push(u());
      loops.push(loop);
    }
    regions.push({ nonzero: (flags & 1) === 1, loops });
  }
  return { vertices, segments, regions };
}

/** Walks a chain of segment indices, flipping segments walked backwards. */
function walkChain(net: Network, segIdx: number[], sx: number, sy: number) {
  const segs = segIdx
    .map((s) => net.segments[s])
    .filter((s): s is Network["segments"][number] => !!s);
  if (!segs.length) return { cmds: [] as Cmd[], startV: -1, endV: -1 };
  const first = segs[0]!;
  const second = segs[1];
  const startV =
    second && (first.end === second.start || first.end === second.end)
      ? first.start
      : second
        ? first.end
        : first.start;
  let cur = startV;
  const pt = (v: number) => [net.vertices[v]!.x * sx, net.vertices[v]!.y * sy] as const;
  const cmds: Cmd[] = [{ op: "M", p: [...pt(cur)] }];
  for (const s of segs) {
    const forward = s.start === cur;
    const [a, b, ta, tb] = forward ? [s.start, s.end, s.ts, s.te] : [s.end, s.start, s.te, s.ts];
    const [bx, by] = pt(b);
    if (!ta[0] && !ta[1] && !tb[0] && !tb[1]) cmds.push({ op: "L", p: [bx, by] });
    else {
      const [ax, ay] = pt(a);
      cmds.push({
        op: "C",
        p: [ax + ta[0] * sx, ay + ta[1] * sy, bx + tb[0] * sx, by + tb[1] * sy, bx, by],
      });
    }
    cur = b;
  }
  return { cmds, startV, endV: cur };
}

function chainCmds(net: Network, segIdx: number[], sx: number, sy: number, close: boolean): Cmd[] {
  const { cmds } = walkChain(net, segIdx, sx, sy);
  if (close && cmds.length) cmds.push({ op: "Z", p: [] });
  return cmds;
}

export interface NetworkShapes {
  fills: { cmds: Cmd[]; nonzero: boolean }[];
  strokes: Cmd[];
}

/** Regions → filled subpaths; segments outside every region → open strokes; no regions → closed runs fill. */
export function networkShapes(net: Network, sx: number, sy: number): NetworkShapes {
  const fills: NetworkShapes["fills"] = [];
  const used = new Set<number>();
  for (const r of net.regions) {
    const cmds: Cmd[] = [];
    for (const loop of r.loops) {
      loop.forEach((s) => used.add(s));
      cmds.push(...chainCmds(net, loop, sx, sy, true));
    }
    if (cmds.length) fills.push({ cmds, nonzero: r.nonzero });
  }
  // Group the remaining segments into connected runs in stored order.
  const runs: number[][] = [];
  let run: number[] = [];
  let tail = -1;
  net.segments.forEach((s, k) => {
    if (net.regions.length && used.has(k)) return;
    if (run.length && (s.start === tail || s.end === tail)) {
      run.push(k);
      tail = s.start === tail ? s.end : s.start;
    } else {
      if (run.length) runs.push(run);
      run = [k];
      tail = s.end;
    }
  });
  if (run.length) runs.push(run);
  const strokes: Cmd[] = [];
  for (const r of runs) {
    const { cmds, startV, endV } = walkChain(net, r, sx, sy);
    const closed = r.length > 1 && startV === endV;
    if (closed) cmds.push({ op: "Z", p: [] });
    if (!net.regions.length && closed) fills.push({ cmds, nonzero: true });
    strokes.push(...cmds);
  }
  return { fills, strokes };
}

const K = 0.5522847498;

export function roundedRect(w: number, h: number, radii: [number, number, number, number]): Cmd[] {
  const lim = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r || 0, lim))) as [
    number,
    number,
    number,
    number,
  ];
  const c: Cmd[] = [
    { op: "M", p: [tl, 0] },
    { op: "L", p: [w - tr, 0] },
  ];
  if (tr) c.push({ op: "C", p: [w - tr + tr * K, 0, w, tr - tr * K, w, tr] });
  c.push({ op: "L", p: [w, h - br] });
  if (br) c.push({ op: "C", p: [w, h - br + br * K, w - br + br * K, h, w - br, h] });
  c.push({ op: "L", p: [bl, h] });
  if (bl) c.push({ op: "C", p: [bl - bl * K, h, 0, h - bl + bl * K, 0, h - bl] });
  c.push({ op: "L", p: [0, tl] });
  if (tl) c.push({ op: "C", p: [0, tl - tl * K, tl - tl * K, 0, tl, 0] });
  c.push({ op: "Z", p: [] });
  return c;
}

export function ellipse(w: number, h: number): Cmd[] {
  const rx = w / 2;
  const ry = h / 2;
  return [
    { op: "M", p: [w, ry] },
    { op: "C", p: [w, ry + ry * K, rx + rx * K, h, rx, h] },
    { op: "C", p: [rx - rx * K, h, 0, ry + ry * K, 0, ry] },
    { op: "C", p: [0, ry - ry * K, rx - rx * K, 0, rx, 0] },
    { op: "C", p: [rx + rx * K, 0, w, ry - ry * K, w, ry] },
    { op: "Z", p: [] },
  ];
}

const fmt = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

/** Command list → SVG path data, every point (control points included) mapped through `m`. */
export function toPathData(cmds: Cmd[], m: Matrix): string {
  const parts: string[] = [];
  for (const c of cmds) {
    if (c.op === "Z") {
      parts.push("Z");
      continue;
    }
    const pts: string[] = [];
    for (let k = 0; k < c.p.length; k += 2) {
      const [x, y] = apply(m, c.p[k]!, c.p[k + 1]!);
      pts.push(`${fmt(x)} ${fmt(y)}`);
    }
    parts.push(`${c.op}${pts.join(" ")}`);
  }
  return parts.join("");
}

export { fmt };

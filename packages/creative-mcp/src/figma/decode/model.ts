// The decoded document as a tree, plus helpers shared by summary, outline and SVG.
// Field names follow the community-known decoded dialect (guid, parentIndex, fillPaints, …):
// hypotheses about undocumented internals, to be confirmed against a real file's schema.txt.

export type Raw = Record<string, any>;

export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const NULL_GUID_PART = 4294967295;

export interface FNode {
  id: string;
  raw: Raw;
  type: string;
  name: string;
  parent: FNode | null;
  position: string;
  children: FNode[];
  /** Index of this node in the stored list (file order). */
  index: number;
}

export function guidId(g: Raw | undefined | null): string | null {
  if (!g || typeof g.sessionID !== "number" || typeof g.localID !== "number") return null;
  if (g.sessionID === NULL_GUID_PART && g.localID === NULL_GUID_PART) return null;
  return `${g.sessionID}:${g.localID}`;
}

/** Code-point comparison of fractional ordering keys (no locale collation). */
export function comparePositions(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

export interface Doc {
  nodes: FNode[];
  byId: Map<string, FNode>;
  roots: FNode[];
  pages: FNode[];
  blobs: Uint8Array[];
}

export function buildDoc(nodeChanges: Raw[], blobs: Uint8Array[]): Doc {
  const nodes: FNode[] = [];
  const byId = new Map<string, FNode>();
  nodeChanges.forEach((raw, index) => {
    if (raw.phase === "REMOVED") return;
    const id = guidId(raw.guid);
    if (!id) return;
    const n: FNode = {
      id,
      raw,
      type: String(raw.type ?? "UNKNOWN"),
      name: String(raw.name ?? ""),
      parent: null,
      position: String(raw.parentIndex?.position ?? ""),
      children: [],
      index,
    };
    nodes.push(n);
    byId.set(id, n);
  });
  const roots: FNode[] = [];
  for (const n of nodes) {
    const pid = guidId(n.raw.parentIndex?.guid);
    const p = pid ? byId.get(pid) : undefined;
    if (p && p !== n) n.parent = p;
  }
  // A malformed file can link parents in a loop (A → B → A); every ancestor walk would then never
  // end. Cut each loop where it is found: that node becomes a root.
  const state = new Map<FNode, 1 | 2>(); // 1 = on the current walk, 2 = settled
  for (const n of nodes) {
    const walk: FNode[] = [];
    let p: FNode | null = n;
    while (p && !state.has(p)) {
      state.set(p, 1);
      walk.push(p);
      p = p.parent;
    }
    if (p && state.get(p) === 1) p.parent = null; // the loop closes at p
    for (const w of walk) state.set(w, 2);
  }
  for (const n of nodes) {
    if (n.parent) n.parent.children.push(n);
    else roots.push(n);
  }
  for (const n of nodes)
    n.children.sort((a, b) => comparePositions(a.position, b.position) || a.index - b.index);
  const pages: FNode[] = [];
  const walkPages = (n: FNode) => {
    if (n.type === "CANVAS") pages.push(n);
    else for (const c of n.children) if (c.type === "CANVAS" || c.type === "DOCUMENT") walkPages(c);
  };
  for (const r of roots) walkPages(r);
  return { nodes, byId, roots, pages, blobs };
}

export const isShown = (n: FNode) => n.raw.visible !== false;

/** Node and all ancestors visible. */
export function isVisibleDeep(n: FNode): boolean {
  for (let p: FNode | null = n; p; p = p.parent) if (!isShown(p)) return false;
  return true;
}

export const isStyleNode = (n: FNode) => !!n.raw.styleType && n.raw.styleType !== "NONE";
export const isVariableNode = (n: FNode) => n.type.startsWith("VARIABLE");
export const isDesignNode = (n: FNode) => !isStyleNode(n) && !isVariableNode(n);

export function pageOf(n: FNode): FNode | null {
  for (let p: FNode | null = n; p; p = p.parent) if (p.type === "CANVAS") return p;
  return null;
}

export function matrixOf(raw: Raw): Matrix {
  const t = raw.transform;
  if (!t) return IDENTITY;
  return {
    m00: t.m00 ?? 1,
    m01: t.m01 ?? 0,
    m02: t.m02 ?? 0,
    m10: t.m10 ?? 0,
    m11: t.m11 ?? 1,
    m12: t.m12 ?? 0,
  };
}

export function mul(a: Matrix, b: Matrix): Matrix {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
    m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

export function invert(m: Matrix): Matrix | null {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!det || !Number.isFinite(det)) return null;
  const i00 = m.m11 / det;
  const i01 = -m.m01 / det;
  const i10 = -m.m10 / det;
  const i11 = m.m00 / det;
  return {
    m00: i00,
    m01: i01,
    m02: -(i00 * m.m02 + i01 * m.m12),
    m10: i10,
    m11: i11,
    m12: -(i10 * m.m02 + i11 * m.m12),
  };
}

export const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m.m00 * x + m.m01 * y + m.m02,
  m.m10 * x + m.m11 * y + m.m12,
];

/** Page-absolute matrix: parents composed first; the page (CANVAS) and document add nothing. */
export function canvasMatrix(n: FNode): Matrix {
  const chain: FNode[] = [];
  for (let p: FNode | null = n; p && p.type !== "CANVAS" && p.type !== "DOCUMENT"; p = p.parent)
    chain.push(p);
  let m = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) m = mul(m, matrixOf(chain[i]!.raw));
  return m;
}

export const sizeOf = (raw: Raw): { w: number; h: number } => ({
  w: Number(raw.size?.x ?? 0),
  h: Number(raw.size?.y ?? 0),
});

export const r1 = (v: number) => Math.round(v * 10) / 10;

/** Axis-aligned box of the node on its page (all four corners transformed). */
export function canvasBox(n: FNode) {
  const m = canvasMatrix(n);
  const { w, h } = sizeOf(n.raw);
  const pts = [apply(m, 0, 0), apply(m, w, 0), apply(m, 0, h), apply(m, w, h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: r1(x), y: r1(y), w: r1(Math.max(...xs) - x), h: r1(Math.max(...ys) - y) };
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

/** Image hash of a paint image ref: `{hash: bytes}` (decoded) or already a hex string. */
export function hashOf(img: Raw | undefined | null): string | null {
  const h = img?.hash;
  if (h instanceof Uint8Array) return h.length ? hex(h) : null;
  if (typeof h === "string" && /^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  return null;
}

const ch = (v: number) =>
  Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

export function colorHex(c: Raw | undefined): string {
  return `#${ch(c?.r ?? 0)}${ch(c?.g ?? 0)}${ch(c?.b ?? 0)}`;
}

/** `#RRGGBB` plus ` @ 0.xx` when the alpha is visibly below 1. */
export function colorLabel(c: Raw | undefined, extraAlpha = 1): string {
  const a = (c?.a ?? 1) * extraAlpha;
  return a < 0.995 ? `${colorHex(c)} @ ${Math.round(a * 100) / 100}` : colorHex(c);
}

export const paintType = (p: Raw) => String(p.type ?? "SOLID");
export const paintShown = (p: Raw) => p.visible !== false;
export const paintsOf = (raw: Raw, key: "fillPaints" | "strokePaints"): Raw[] =>
  Array.isArray(raw[key]) ? raw[key] : [];

/** Stops of a gradient paint: `stops`, or the variable-bound list when `stops` is blank. */
export function gradientStops(p: Raw): { color: Raw; position: number }[] {
  if (Array.isArray(p.stops) && p.stops.length) return p.stops;
  const v = p.stopsVar;
  if (Array.isArray(v) && v.length)
    return v.map((s: Raw) => ({
      color: s.color ?? s.colorVar?.value?.colorValue ?? {},
      position: s.position ?? 0,
    }));
  return [];
}

export function textOf(raw: Raw): string {
  return String(raw.textData?.characters ?? "");
}

export function fontLabel(f: Raw | undefined): string {
  return `${f?.family ?? "Inter"} / ${f?.style || "Regular"}`;
}

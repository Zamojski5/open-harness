// `svg`: draws one node of a decoded folder to SVG from Figma's saved geometry and glyph outlines.
// No layout engine and no fonts: auto layout, instance contents and line breaks are already baked
// into the stored data. Everything approximated or skipped is counted under `approximations`.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { loadDecodedDir, detectImageType } from "../decode/decode.ts";
import {
  colorHex,
  gradientStops,
  guidId,
  hashOf,
  invert,
  mul,
  matrixOf,
  paintShown,
  paintType,
  paintsOf,
  sizeOf,
  type Doc,
  type FNode,
  type Matrix,
  type Raw,
} from "../decode/model.ts";
import {
  ellipse,
  fmt,
  networkShapes,
  parseNetwork,
  parsePathBlob,
  roundedRect,
  toPathData,
  type Cmd,
} from "./geometry.ts";

export interface SvgOptions {
  out?: string | undefined;
  pad?: number | undefined;
  scale?: number | undefined;
  includeHidden?: boolean | undefined;
  linkImages?: boolean | undefined;
}

const CLIPPING_TYPES = new Set([
  "FRAME",
  "SYMBOL",
  "INSTANCE",
  "SECTION",
  "SLIDE",
  "SLIDE_ROW",
  "SLIDE_GRID",
  "INTERACTIVE_SLIDE_ELEMENT",
]);
const BOX_TYPES = new Set([
  ...CLIPPING_TYPES,
  "ROUNDED_RECTANGLE",
  "RECTANGLE",
  "STAMP",
  "STICKY",
  "SHAPE_WITH_TEXT",
]);
const BLEND: Record<string, string> = {
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mat = (m: Matrix) =>
  `matrix(${[m.m00, m.m10, m.m01, m.m11, m.m02, m.m12].map(fmt).join(" ")})`;
const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m.m00 * m.m11 - m.m01 * m.m10)) || 1;

interface Scope {
  /** Keys from this scope's instance down to the current node. */
  path: string[];
  overrides: Map<string, Raw>;
  derived: Map<string, Raw>;
}

interface Ctx {
  doc: Doc;
  dir: string;
  defs: string[];
  approx: Map<string, number>;
  n: number;
  includeHidden: boolean;
  linkImages: boolean;
  imageFiles: Map<string, string> | null;
  /** Components being expanded on the current path (guards against an instance inside itself). */
  expanding: Set<string>;
  /** Nodes drawn so far; nested instances can multiply a small file into a huge drawing. */
  drawn: number;
}

/** Upper bound on drawn nodes per SVG; beyond it the rest is skipped and reported. */
export const MAX_DRAWN_NODES = 250_000;

const note = (ctx: Ctx, reason: string) =>
  ctx.approx.set(reason, (ctx.approx.get(reason) ?? 0) + 1);
const nextId = (ctx: Ctx, p: string) => `${p}${++ctx.n}`;

function blob(ctx: Ctx, index: unknown): Uint8Array | null {
  return typeof index === "number" ? (ctx.doc.blobs[index] ?? null) : null;
}

const pathKey = (path: string[]) => path.join("/");

function scopeMaps(list: unknown): Map<string, Raw> {
  const m = new Map<string, Raw>();
  if (!Array.isArray(list)) return m;
  for (const o of list as Raw[]) {
    const guids = (o.guidPath?.guids ?? []) as Raw[];
    const keys = guids.map((g) => guidId(g)).filter((x): x is string => !!x);
    if (keys.length) m.set(pathKey(keys), o);
  }
  return m;
}

const OVERRIDE_SKIP = new Set(["guid", "guidPath", "parentIndex", "overrideKey", "phase"]);
function patch(base: Raw, over: Raw | undefined): Raw {
  if (!over) return base;
  const out: Raw = { ...base };
  for (const [k, v] of Object.entries(over))
    if (!OVERRIDE_SKIP.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** Effective data for a node inside instance scopes: inner overrides first, outer win; derived layout last. */
function effective(n: FNode, scopes: Scope[]): { raw: Raw; scopes: Scope[] } {
  if (!scopes.length) return { raw: n.raw, scopes };
  const key = guidId(n.raw.overrideKey) ?? n.id;
  const next = scopes.map((s) => ({ ...s, path: [...s.path, key] }));
  let raw = n.raw;
  for (let i = next.length - 1; i >= 0; i--)
    raw = patch(raw, next[i]!.overrides.get(pathKey(next[i]!.path)));
  for (const s of next) {
    const d = s.derived.get(pathKey(s.path));
    if (d) {
      raw = patch(raw, d);
      break;
    }
  }
  return { raw, scopes: next };
}

interface Shape {
  d: string;
  rule: "nonzero" | "evenodd";
}

function radiiOf(raw: Raw): [number, number, number, number] {
  if (raw.rectangleCornerRadiiIndependent)
    return [
      raw.rectangleTopLeftCornerRadius ?? 0,
      raw.rectangleTopRightCornerRadius ?? 0,
      raw.rectangleBottomRightCornerRadius ?? 0,
      raw.rectangleBottomLeftCornerRadius ?? 0,
    ];
  const r = raw.cornerRadius ?? 0;
  return [r, r, r, r];
}

function geometryShapes(ctx: Ctx, list: unknown, m: Matrix): Shape[] {
  const out: Shape[] = [];
  for (const g of Array.isArray(list) ? (list as Raw[]) : []) {
    const b = blob(ctx, g.commandsBlob);
    if (!b || !b.length) continue;
    try {
      const d = toPathData(parsePathBlob(b), m);
      if (d)
        out.push({
          d,
          rule: g.windingRule === "ODD" || g.windingRule === "EVENODD" ? "evenodd" : "nonzero",
        });
    } catch {
      note(ctx, "unreadable path blob (skipped)");
    }
  }
  return out;
}

interface NodeGeometry {
  fills: Shape[];
  strokes: Shape[] | null;
  outline: Shape[];
  openStrokes: string | null;
  box: Cmd[];
}

function nodeGeometry(ctx: Ctx, raw: Raw, type: string, m: Matrix): NodeGeometry {
  const { w, h } = sizeOf(raw);
  const box = BOX_TYPES.has(type)
    ? roundedRect(w, h, radiiOf(raw))
    : roundedRect(w, h, [0, 0, 0, 0]);
  let fills = geometryShapes(ctx, raw.fillGeometry, m);
  const baked = geometryShapes(ctx, raw.strokeGeometry, m);
  let openStrokes: string | null = null;
  let outline = fills;
  if (!fills.length) {
    const nb = blob(ctx, raw.vectorData?.vectorNetworkBlob);
    if (nb && nb.length) {
      try {
        const net = parseNetwork(nb);
        const ns = raw.vectorData?.normalizedSize;
        const sx = ns?.x ? w / ns.x : 1;
        const sy = ns?.y ? h / ns.y : 1;
        const shapes = networkShapes(net, sx, sy);
        fills = shapes.fills.map((f) => ({
          d: toPathData(f.cmds, m),
          rule: f.nonzero ? ("nonzero" as const) : ("evenodd" as const),
        }));
        outline = fills;
        openStrokes = shapes.strokes.length ? toPathData(shapes.strokes, m) : null;
      } catch {
        note(ctx, "unreadable vector network (skipped)");
      }
    } else if (BOX_TYPES.has(type)) {
      fills = [{ d: toPathData(box, m), rule: "nonzero" }];
      outline = fills;
    } else if (type === "ELLIPSE") {
      fills = [{ d: toPathData(ellipse(w, h), m), rule: "nonzero" }];
      outline = fills;
    } else if (type === "LINE") {
      openStrokes = toPathData(
        [
          { op: "M", p: [0, 0] },
          { op: "L", p: [w, 0] },
        ],
        m,
      );
      fills = [];
    }
  }
  return { fills, strokes: baked.length ? baked : null, outline, openStrokes, box };
}

function imageFiles(ctx: Ctx): Map<string, string> {
  if (ctx.imageFiles) return ctx.imageFiles;
  const map = new Map<string, string>();
  const dir = NodePath.join(ctx.dir, "images");
  if (NodeFS.existsSync(dir))
    for (const f of NodeFS.readdirSync(dir)) {
      const m = /^([0-9a-f]{40})/i.exec(f);
      if (m) map.set(m[1]!.toLowerCase(), NodePath.join(dir, f));
    }
  ctx.imageFiles = map;
  return map;
}

export function pixelSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50)
    return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49)
    return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = v.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tiff: "image/tiff",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

function gradientDef(ctx: Ctx, p: Raw, w: number, h: number, m: Matrix): string | null {
  const type = paintType(p);
  const t = matrixOf({ transform: p.transform });
  const inv = invert(t);
  if (!inv) {
    note(ctx, "gradient with a degenerate transform (skipped)");
    return null;
  }
  const toUser = mul(mul(m, { m00: w, m01: 0, m02: 0, m10: 0, m11: h, m12: 0 }), inv);
  const opacity = p.opacity ?? 1;
  const stops = gradientStops(p)
    .map(
      (s) =>
        `<stop offset="${fmt(s.position ?? 0)}" stop-color="${colorHex(s.color)}" stop-opacity="${fmt((s.color?.a ?? 1) * opacity)}"/>`,
    )
    .join("");
  const id = nextId(ctx, "g");
  if (type === "GRADIENT_LINEAR") {
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="${mat(toUser)}">${stops}</linearGradient>`,
    );
  } else {
    if (type !== "GRADIENT_RADIAL")
      note(ctx, `${type.replace("GRADIENT_", "").toLowerCase()} gradient drawn as radial`);
    const unit = mul(toUser, { m00: 0.5, m01: 0, m02: 0.5, m10: 0, m11: 0.5, m12: 0.5 });
    ctx.defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="${mat(unit)}">${stops}</radialGradient>`,
    );
  }
  return `url(#${id})`;
}

function blendAttr(ctx: Ctx, mode: unknown): string {
  if (!mode || mode === "NORMAL" || mode === "PASS_THROUGH") return "";
  const css = BLEND[String(mode)];
  if (!css) {
    note(ctx, `blend mode ${String(mode)} drawn normal`);
    return "";
  }
  return ` style="mix-blend-mode:${css}"`;
}

function imagePaint(ctx: Ctx, p: Raw, shapes: Shape[], w: number, h: number, m: Matrix): string {
  const hash = hashOf(p.image);
  const file = hash ? imageFiles(ctx).get(hash) : undefined;
  if (!hash || !file) {
    note(
      ctx,
      "no image bytes for this fill (rerun decode with --images all; pastes never carry pixels)",
    );
    return "";
  }
  const bytes = NodeFS.readFileSync(file);
  let size = pixelSize(bytes);
  if (!size && p.originalImageWidth && p.originalImageHeight)
    size = { w: p.originalImageWidth, h: p.originalImageHeight };
  const mode = String(p.imageScaleMode ?? "FILL");
  let place: Matrix;
  let iw = w;
  let ih = h;
  if (!size) {
    note(ctx, "image of unknown size (stretched to the box)");
    place = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  } else {
    iw = size.w;
    ih = size.h;
    if (mode === "STRETCH" || mode === "CROP") {
      const inv = invert(matrixOf({ transform: p.transform })) ?? {
        m00: 1,
        m01: 0,
        m02: 0,
        m10: 0,
        m11: 1,
        m12: 0,
      };
      place = mul(mul({ m00: w, m01: 0, m02: 0, m10: 0, m11: h, m12: 0 }, inv), {
        m00: 1 / iw,
        m01: 0,
        m02: 0,
        m10: 0,
        m11: 1 / ih,
        m12: 0,
      });
    } else if (mode === "TILE") {
      note(ctx, "tile fill: single copy only");
      const s = p.scale ?? 1;
      place = { m00: s, m01: 0, m02: 0, m10: 0, m11: s, m12: 0 };
    } else {
      const s = mode === "FIT" ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
      place = { m00: s, m01: 0, m02: (w - iw * s) / 2, m10: 0, m11: s, m12: (h - ih * s) / 2 };
    }
    if (p.rotation && mode !== "STRETCH" && mode !== "CROP")
      note(ctx, "rotated image fill (rotation ignored)");
  }
  const kind = detectImageType(bytes);
  const href = ctx.linkImages
    ? `file://${file}`
    : `data:${MIME[kind] ?? "application/octet-stream"};base64,${bytes.toString("base64")}`;
  const clip = nextId(ctx, "c");
  ctx.defs.push(
    `<clipPath id="${clip}">${shapes.map((s) => `<path d="${s.d}" clip-rule="${s.rule}"/>`).join("")}</clipPath>`,
  );
  const opacity = p.opacity ?? 1;
  return `<g clip-path="url(#${clip})"${blendAttr(ctx, p.blendMode)}><image href="${esc(href)}" width="${fmt(iw)}" height="${fmt(ih)}" preserveAspectRatio="none" transform="${mat(mul(m, place))}"${opacity < 1 ? ` opacity="${fmt(opacity)}"` : ""}/></g>`;
}

/** One SVG element per visible paint, bottom first. `stroke` draws outlines instead of fills. */
function paintStack(
  ctx: Ctx,
  paints: Raw[],
  shapes: Shape[],
  w: number,
  h: number,
  m: Matrix,
  stroke?: { d: string; width: number },
): string {
  const out: string[] = [];
  for (const p of paints) {
    if (!paintShown(p)) continue;
    const type = paintType(p);
    let fill: string | null = null;
    let alpha = 1;
    if (type === "SOLID") {
      fill = colorHex(p.color);
      alpha = (p.color?.a ?? 1) * (p.opacity ?? 1);
    } else if (type.startsWith("GRADIENT")) fill = gradientDef(ctx, p, w, h, m);
    else if (type === "IMAGE") {
      if (stroke) note(ctx, "image stroke (skipped)");
      else out.push(imagePaint(ctx, p, shapes, w, h, m));
      continue;
    } else {
      note(ctx, `unsupported paint ${type.toLowerCase()}`);
      continue;
    }
    if (!fill) continue;
    const blend = blendAttr(ctx, p.blendMode);
    if (stroke)
      out.push(
        `<path d="${stroke.d}" fill="none" stroke="${fill}" stroke-width="${fmt(stroke.width)}"${alpha < 1 ? ` stroke-opacity="${fmt(alpha)}"` : ""}${blend}/>`,
      );
    else
      for (const s of shapes)
        out.push(
          `<path d="${s.d}" fill="${fill}" fill-rule="${s.rule}"${alpha < 1 ? ` fill-opacity="${fmt(alpha)}"` : ""}${blend}/>`,
        );
  }
  return out.join("");
}

function effectsFilter(ctx: Ctx, raw: Raw, m: Matrix): string {
  const parts: string[] = [];
  const s = scaleOf(m);
  for (const e of Array.isArray(raw.effects) ? (raw.effects as Raw[]) : []) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW") {
      const ox = e.offset?.x ?? 0;
      const oy = e.offset?.y ?? 0;
      const dx = m.m00 * ox + m.m01 * oy;
      const dy = m.m10 * ox + m.m11 * oy;
      if (e.spread) note(ctx, "shadow spread ignored");
      parts.push(
        `<feDropShadow dx="${fmt(dx)}" dy="${fmt(dy)}" stdDeviation="${fmt(((e.radius ?? 0) / 2) * s)}" flood-color="${colorHex(e.color)}" flood-opacity="${fmt(e.color?.a ?? 1)}"/>`,
      );
    } else if (e.type === "FOREGROUND_BLUR" || e.type === "LAYER_BLUR") {
      parts.push(`<feGaussianBlur stdDeviation="${fmt(((e.radius ?? 0) / 2) * s)}"/>`);
    } else note(ctx, `effect ${String(e.type ?? "unknown").toLowerCase()} not drawn`);
  }
  if (!parts.length) return "";
  const id = nextId(ctx, "f");
  ctx.defs.push(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${parts.join("")}</filter>`,
  );
  return ` filter="url(#${id})"`;
}

function textGlyphs(ctx: Ctx, raw: Raw, m: Matrix, w: number, h: number): string {
  const glyphs = (raw.derivedTextData?.glyphs ?? []) as Raw[];
  if (!glyphs.length) {
    if (String(raw.textData?.characters ?? "").trim())
      note(ctx, "text without baked glyphs (skipped)");
    return "";
  }
  const styleIds = (raw.textData?.characterStyleIDs ?? []) as number[];
  const table = new Map<number, Raw>();
  for (const o of (raw.textData?.styleOverrideTable ?? []) as Raw[])
    if (typeof o.styleID === "number") table.set(o.styleID, o);
  const runs = new Map<number, Cmd[]>();
  for (const g of glyphs) {
    const b = blob(ctx, g.commandsBlob);
    if (!b || !b.length) continue;
    let cmds: Cmd[];
    try {
      cmds = parsePathBlob(b);
    } catch {
      note(ctx, "unreadable glyph outline (skipped)");
      continue;
    }
    const fs = g.fontSize ?? raw.fontSize ?? 12;
    const px = g.position?.x ?? 0;
    const py = g.position?.y ?? 0;
    const placed = cmds.map((c) => {
      if (c.op === "Z") return c;
      const p = c.p.map((v, k) => (k % 2 === 0 ? px + v * fs : py - v * fs));
      return { op: c.op, p } as Cmd;
    });
    const style = styleIds[g.firstCharacter ?? 0] ?? 0;
    const list = runs.get(style) ?? [];
    list.push(...placed);
    runs.set(style, list);
  }
  const out: string[] = [];
  for (const [style, cmds] of runs) {
    const o = table.get(style);
    const paints =
      o && Array.isArray(o.fillPaints) ? (o.fillPaints as Raw[]) : paintsOf(raw, "fillPaints");
    const shape = [{ d: toPathData(cmds, m), rule: "nonzero" as const }];
    out.push(
      paintStack(
        ctx,
        paints.length || raw.fillPaints
          ? paints
          : [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
        shape,
        w,
        h,
        m,
      ),
    );
  }
  return out.join("");
}

function renderChildren(ctx: Ctx, kids: FNode[], m: Matrix, scopes: Scope[]): string {
  const out: string[] = [];
  let clipOpen = 0;
  for (const c of kids) {
    const { raw, scopes: cs } = effective(c, scopes);
    const hidden = raw.visible === false && !ctx.includeHidden;
    if (raw.mask && !hidden) {
      if (raw.maskType && raw.maskType !== "ALPHA") note(ctx, "non-alpha mask drawn as a clip");
      const cm = mul(m, matrixOf(raw));
      const geo = nodeGeometry(ctx, raw, c.type, cm);
      const id = nextId(ctx, "m");
      ctx.defs.push(
        `<clipPath id="${id}">${geo.outline.map((s) => `<path d="${s.d}" clip-rule="${s.rule}"/>`).join("")}</clipPath>`,
      );
      out.push(`<g clip-path="url(#${id})">`);
      clipOpen++;
      continue;
    }
    out.push(renderNode(ctx, c, raw, mul(m, matrixOf(raw)), cs, false));
  }
  out.push("</g>".repeat(clipOpen));
  return out.join("");
}

function renderNode(
  ctx: Ctx,
  n: FNode,
  raw: Raw,
  m: Matrix,
  scopes: Scope[],
  isRoot: boolean,
): string {
  if (!isRoot && raw.visible === false && !ctx.includeHidden) return "";
  if (++ctx.drawn > MAX_DRAWN_NODES) {
    note(ctx, `drawing stopped at ${MAX_DRAWN_NODES} nodes (rest skipped)`);
    return "";
  }
  const type = n.type;
  const { w, h } = sizeOf(raw);
  const geo = nodeGeometry(ctx, raw, type, m);
  const body: string[] = [];

  if (type === "TEXT") body.push(textGlyphs(ctx, raw, m, w, h));
  else body.push(paintStack(ctx, paintsOf(raw, "fillPaints"), geo.fills, w, h, m));

  // Children (own, or the component's for instances).
  let kids: FNode[] = n.children;
  let childScopes = scopes;
  let expanded: string | null = null;
  if (type === "INSTANCE") {
    const sid = guidId(raw.overriddenSymbolID) ?? guidId(raw.symbolData?.symbolID);
    const comp = sid ? ctx.doc.byId.get(sid) : undefined;
    if (!comp) {
      note(ctx, "instance has no component in this file (left empty)");
      kids = [];
    } else if (ctx.expanding.has(comp.id)) {
      note(ctx, "instance nested inside its own component (contents skipped)");
      kids = [];
    } else {
      expanded = comp.id;
      ctx.expanding.add(comp.id);
      kids = comp.children;
      const derived = scopeMaps(raw.derivedSymbolData);
      const cs = sizeOf(comp.raw);
      if (!derived.size && cs.w && cs.h && (Math.abs(cs.w - w) > 0.5 || Math.abs(cs.h - h) > 0.5))
        note(ctx, "instance scale ignored (component size used)");
      childScopes = [
        { path: [], overrides: scopeMaps(raw.symbolData?.symbolOverrides), derived },
        ...scopes,
      ];
    }
  }
  const solvedBoolean =
    type === "BOOLEAN_OPERATION" && Array.isArray(raw.fillGeometry) && raw.fillGeometry.length;
  if (!solvedBoolean && kids.length) {
    const clips = CLIPPING_TYPES.has(type) && !raw.frameMaskDisabled && !raw.resizeToFit;
    const inner = renderChildren(ctx, kids, m, childScopes);
    if (clips && inner) {
      const id = nextId(ctx, "k");
      ctx.defs.push(`<clipPath id="${id}"><path d="${toPathData(geo.box, m)}"/></clipPath>`);
      body.push(`<g clip-path="url(#${id})">${inner}</g>`);
    } else body.push(inner);
  }
  if (expanded) ctx.expanding.delete(expanded);

  // Strokes: baked outline filled with the stroke paints; otherwise a centred SVG stroke.
  const strokePaints = paintsOf(raw, "strokePaints").filter(paintShown);
  if (strokePaints.length) {
    if (geo.strokes) body.push(paintStack(ctx, strokePaints, geo.strokes, w, h, m));
    else {
      const weight = raw.strokeWeight ?? 1;
      const d = [...geo.outline.map((s) => s.d), geo.openStrokes ?? ""].join("");
      if (d && weight > 0 && type !== "TEXT") {
        note(ctx, "stroke without baked outline drawn centred");
        body.push(paintStack(ctx, strokePaints, [], w, h, m, { d, width: weight * scaleOf(m) }));
      }
    }
  }

  const content = body.join("");
  if (!content) return "";
  const attrs: string[] = [];
  const op = raw.opacity ?? 1;
  if (op < 1) attrs.push(` opacity="${fmt(op)}"`);
  attrs.push(blendAttr(ctx, raw.blendMode));
  attrs.push(effectsFilter(ctx, raw, m));
  const a = attrs.join("");
  return a ? `<g${a}>${content}</g>` : content;
}

export function renderSvg(dir: string, nodeId: string, opts: SvgOptions = {}) {
  const doc = loadDecodedDir(dir);
  const n = doc.byId.get(nodeId);
  if (!n) throw new Error(`no node ${nodeId}; ids look like N:M (see outline.txt)`);
  const pad = opts.pad ?? 0;
  const scale = opts.scale ?? 1;
  const ctx: Ctx = {
    doc,
    dir: NodePath.resolve(dir),
    defs: [],
    approx: new Map(),
    n: 0,
    includeHidden: !!opts.includeHidden,
    linkImages: !!opts.linkImages,
    imageFiles: null,
    expanding: new Set(),
    drawn: 0,
  };
  const { w, h } = sizeOf(n.raw);
  const root: Matrix = { m00: 1, m01: 0, m02: pad, m10: 0, m11: 1, m12: pad };
  const body = renderNode(ctx, n, n.raw, root, [], true);
  const vw = w + 2 * pad;
  const vh = h + 2 * pad;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(vw * scale)}" height="${fmt(vh * scale)}" viewBox="0 0 ${fmt(vw)} ${fmt(vh)}">${ctx.defs.length ? `<defs>${ctx.defs.join("")}</defs>` : ""}${body}</svg>\n`;
  const out = NodePath.resolve(
    opts.out ??
      NodePath.join(dir, "svg", `${nodeId.replaceAll(":", "-").replaceAll(";", "_")}.svg`),
  );
  NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
  NodeFS.writeFileSync(out, svg);
  // Empty with nothing reported would look like success: say so.
  if (!body && !ctx.approx.size)
    note(
      ctx,
      "nothing was drawn: no visible paints, geometry or glyphs found (hidden content, or a schema mismatch: see summary.json diagnostics and schema.txt)",
    );
  const approximations = Object.fromEntries([...ctx.approx.entries()].sort((a, b) => b[1] - a[1]));
  return {
    svg: out,
    node: nodeId,
    name: n.name,
    width: Math.round(w * 100) / 100,
    height: Math.round(h * 100) / 100,
    approximations,
  };
}

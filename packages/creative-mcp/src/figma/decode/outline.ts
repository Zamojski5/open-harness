// outline.txt: page → top-level → layer tree as compact text lines.

import {
  canvasBox,
  colorLabel,
  guidId,
  hashOf,
  isDesignNode,
  paintShown,
  paintType,
  paintsOf,
  textOf,
  type Doc,
  type FNode,
} from "./model.ts";

export interface OutlineOptions {
  depth?: number | undefined;
  page?: string | undefined;
  node?: string | undefined;
  maxLines?: number | undefined;
}

/** One line per node: newlines in names/text (author data) must never start a fake outline line. */
const flat = (s: string) =>
  s.replace(/\r\n|[\r\n\u2028\u2029]/g, " / ").replace(/[\u0000-\u001f\u007f]/g, " ");
const clip = (s: string, n: number) => {
  const f = flat(s);
  return f.length > n ? `${f.slice(0, n - 1)}…` : f;
};
const num = (v: number) => String(Math.round(v * 10) / 10);

function fills(n: FNode): string | null {
  const out: string[] = [];
  for (const p of paintsOf(n.raw, "fillPaints")) {
    if (!paintShown(p) || out.length >= 3) continue;
    const t = paintType(p);
    if (t === "SOLID") out.push(colorLabel(p.color, p.opacity ?? 1).replace(" @ ", "@"));
    else if (t === "IMAGE") out.push(`image:${(hashOf(p.image) ?? "?").slice(0, 10)}`);
    else out.push(t.toLowerCase());
  }
  return out.length ? `fill=${out.join(",")}` : null;
}

export function nodeLine(doc: Doc, n: FNode): string {
  const b = canvasBox(n);
  const parts = [
    `${n.type} "${clip(n.name, 60)}" [${n.id}] ${num(b.w)}x${num(b.h)} @${num(b.x)},${num(b.y)}`,
  ];
  if (n.raw.visible === false) parts.push("HIDDEN");
  if (typeof n.raw.opacity === "number" && n.raw.opacity < 1)
    parts.push(`opacity=${n.raw.opacity.toFixed(2)}`);
  if (n.type === "FRAME" && n.raw.isStateGroup) parts.push("COMPONENT_SET");
  if (n.raw.mask) parts.push("MASK");
  if (n.type === "INSTANCE") {
    const sid = guidId(n.raw.symbolData?.symbolID);
    const comp = sid ? doc.byId.get(sid) : undefined;
    if (comp) parts.push(`of "${clip(comp.name, 60)}"`);
  }
  const f = fills(n);
  if (f) parts.push(f);
  if (n.type === "TEXT") {
    const font = n.raw.fontName ?? {};
    const text = clip(textOf(n.raw), 80);
    parts.push(
      `${clip(String(font.family ?? "Inter"), 60)} ${clip(String(font.style || "Regular"), 40)} ${num(n.raw.fontSize ?? 12)}px: "${text}"${n.raw.autoRename === false ? " (named)" : ""}`,
    );
  }
  return parts.join(" ");
}

export function buildOutline(doc: Doc, opts: OutlineOptions = {}): string {
  const depth = opts.depth ?? 3;
  const max = opts.maxLines ?? 3000;
  const lines: string[] = [];
  let cut = false;
  const push = (s: string) => {
    if (lines.length >= max) {
      cut = true;
      return false;
    }
    lines.push(s);
    return true;
  };
  const walk = (n: FNode, level: number, indent: number) => {
    if (cut) return;
    if (!push(`${"  ".repeat(indent)}${nodeLine(doc, n)}`)) return;
    const kids = n.children.filter(isDesignNode);
    if (!kids.length) return;
    if (level >= depth) {
      push(`${"  ".repeat(indent + 1)}… ${kids.length} children`);
      return;
    }
    for (const c of kids) walk(c, level + 1, indent + 1);
  };
  if (opts.node) {
    const n = doc.byId.get(opts.node);
    if (!n) throw new Error(`no node ${opts.node}`);
    walk(n, 1, 0);
  } else {
    const pages = opts.page ? doc.pages.filter((p) => p.name === opts.page) : doc.pages;
    if (opts.page && !pages.length) throw new Error(`no page named "${opts.page}"`);
    if (!doc.pages.length)
      push(
        doc.nodes.length
          ? `(no pages found among ${doc.nodes.length} nodes: possible schema mismatch; see summary.json "diagnostics" and schema.txt, or use --node ID)`
          : '(no nodes were read: possible schema mismatch; see summary.json "diagnostics" and schema.txt)',
      );
    for (const p of pages) {
      const flags = [
        p.raw.visible === false ? " HIDDEN" : "",
        p.raw.internalOnly ? " (internal-only library masters, not a design page)" : "",
      ];
      if (!push(`PAGE "${clip(p.name, 120)}" [${p.id}]${flags.join("")}`)) break;
      for (const c of p.children.filter(isDesignNode)) walk(c, 1, 1);
    }
  }
  if (cut)
    lines.push(
      `… output cut at ${max} lines; narrow with --page NAME, --node ID or a smaller --depth`,
    );
  return `${lines.join("\n")}\n`;
}

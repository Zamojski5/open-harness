// summary.json: the digest an agent reads first.

import {
  canvasBox,
  colorLabel,
  fontLabel,
  gradientStops,
  guidId,
  hashOf,
  isDesignNode,
  isStyleNode,
  isVisibleDeep,
  pageOf,
  paintShown,
  paintType,
  paintsOf,
  type Doc,
  type FNode,
  type Raw,
} from "./model.ts";

export interface MediaRecord {
  hash: string;
  uses: number;
  visibleUses: number;
  thumbnail: boolean;
  width?: number;
  height?: number;
  nodes: string[];
  bytes?: number;
  file?: string;
  missing?: true;
  notOnClipboard?: true;
}

export interface MediaUse {
  images: Map<string, MediaRecord>;
  videos: Map<string, MediaRecord>;
}

const tally = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const byCount = <K>(m: Map<K, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);

function record(map: Map<string, MediaRecord>, hash: string, thumb: boolean): MediaRecord {
  let r = map.get(hash);
  if (!r) {
    r = { hash, uses: 0, visibleUses: 0, thumbnail: thumb, nodes: [] };
    map.set(hash, r);
  }
  if (!thumb) r.thumbnail = false;
  return r;
}

/** Every image/video referenced by a paint, with use counts (hidden paints count as uses). */
export function collectMedia(doc: Doc): MediaUse {
  const images = new Map<string, MediaRecord>();
  const videos = new Map<string, MediaRecord>();
  const visit = (n: FNode, p: Raw, nodeVisible: boolean) => {
    const visible = nodeVisible && paintShown(p);
    const type = paintType(p);
    const use = (map: Map<string, MediaRecord>, hash: string | null, thumb: boolean) => {
      if (!hash) return;
      const r = record(map, hash, thumb);
      r.uses++;
      if (visible && !thumb) r.visibleUses++;
      if (r.nodes.length < 5 && !r.nodes.includes(n.id)) r.nodes.push(n.id);
      if (!thumb) {
        if (p.originalImageWidth && !r.width) r.width = p.originalImageWidth;
        if (p.originalImageHeight && !r.height) r.height = p.originalImageHeight;
      }
    };
    if (type === "IMAGE") {
      use(images, hashOf(p.image), false);
      use(images, hashOf(p.animatedImage), false);
      use(images, hashOf(p.imageThumbnail), true);
    } else if (type === "VIDEO") {
      use(videos, hashOf(p.video), false);
      use(images, hashOf(p.image), false);
      use(images, hashOf(p.imageThumbnail), true);
    }
  };
  for (const n of doc.nodes) {
    const vis = isDesignNode(n) && isVisibleDeep(n);
    for (const p of [...paintsOf(n.raw, "fillPaints"), ...paintsOf(n.raw, "strokePaints")])
      visit(n, p, vis);
    for (const o of n.raw.textData?.styleOverrideTable ?? [])
      for (const p of Array.isArray(o.fillPaints) ? o.fillPaints : []) visit(n, p, vis);
  }
  return { images, videos };
}

function describePaint(p: Raw): Raw {
  const type = paintType(p);
  const out: Raw = { type };
  if (type === "SOLID") out.color = colorLabel(p.color, p.opacity ?? 1);
  else if (type.startsWith("GRADIENT"))
    out.stops = gradientStops(p).map((s) => ({
      color: colorLabel(s.color, p.opacity ?? 1),
      position: Math.round((s.position ?? 0) * 1000) / 1000,
    }));
  else if (type === "IMAGE") {
    out.hash = hashOf(p.image);
    out.scaleMode = p.imageScaleMode ?? "FILL";
  }
  if (p.blendMode && p.blendMode !== "NORMAL" && p.blendMode !== "PASS_THROUGH")
    out.blendMode = p.blendMode;
  if (p.visible === false) out.hidden = true;
  return out;
}

function axisName(v: Raw): string {
  if (typeof v.axisName === "string" && v.axisName) return v.axisName;
  if (typeof v.axisTag === "number")
    return String.fromCharCode(
      (v.axisTag >>> 24) & 255,
      (v.axisTag >>> 16) & 255,
      (v.axisTag >>> 8) & 255,
      v.axisTag & 255,
    );
  return String(v.axisTag ?? "?");
}

function fonts(doc: Doc) {
  const uses = new Map<string, number>();
  const axes = new Map<string, Set<string>>();
  const add = (font: Raw | undefined, variations: Raw[] | undefined) => {
    const label = fontLabel(font);
    tally(uses, label);
    for (const v of variations ?? []) {
      const set = axes.get(label) ?? new Set<string>();
      set.add(`${axisName(v)}=${Math.round(Number(v.value) * 100) / 100}`);
      axes.set(label, set);
    }
  };
  for (const n of doc.nodes) {
    if (n.type !== "TEXT" || !isDesignNode(n)) continue;
    add(n.raw.fontName, n.raw.fontVariations);
    for (const o of n.raw.textData?.styleOverrideTable ?? [])
      if (o.fontName || o.fontVariations) add(o.fontName ?? n.raw.fontName, o.fontVariations);
  }
  return byCount(uses).map(([font, n]) => ({
    font,
    uses: n,
    ...(axes.get(font)?.size ? { variableAxes: [...axes.get(font)!].sort() } : {}),
  }));
}

interface VarCtx {
  byId: Map<string, FNode>;
  byKey: Map<string, FNode>;
  collections: Map<string, FNode>;
  collectionsByKey: Map<string, FNode>;
}

const refKey = (ref: Raw | undefined): { id: string | null; key: string | null } => ({
  id: guidId(ref?.guid ?? ref),
  key:
    typeof ref?.assetRef?.key === "string"
      ? ref.assetRef.key
      : typeof ref?.key === "string"
        ? ref.key
        : null,
});

function lookup(ctxMap: Map<string, FNode>, keyMap: Map<string, FNode>, ref: Raw | undefined) {
  const { id, key } = refKey(ref);
  return (id ? ctxMap.get(id) : undefined) ?? (key ? keyMap.get(key) : undefined);
}

function modesOf(col: FNode | undefined): { id: string; name: string }[] {
  return (col?.raw.variableSetModes ?? []).map((m: Raw) => ({
    id: guidId(m.id) ?? String(m.id),
    name: String(m.name ?? ""),
  }));
}

function entries(v: FNode): { modeId: string; data: Raw }[] {
  return (v.raw.variableDataValues?.entries ?? []).map((e: Raw) => ({
    modeId: guidId(e.modeID) ?? String(e.modeID),
    data: e.variableData ?? {},
  }));
}

const aliasOf = (data: Raw): Raw | undefined =>
  data.dataType === "ALIAS" || data.value?.alias ? data.value?.alias : undefined;

function literal(data: Raw): unknown {
  const v = data.value ?? {};
  if (v.colorValue) return colorLabel(v.colorValue);
  if (v.floatValue !== undefined) return v.floatValue;
  if (v.textValue !== undefined) return v.textValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return null;
}

function collectionOf(ctx: VarCtx, v: FNode) {
  return lookup(ctx.collections, ctx.collectionsByKey, v.raw.variableSetID);
}

/** Value of variable `v` for a mode *name*, following aliases (≤16 hops). */
function resolve(ctx: VarCtx, v: FNode, modeName: string, hops = 0): unknown {
  const col = collectionOf(ctx, v);
  const modes = modesOf(col);
  const es = entries(v);
  const mode = modes.find((m) => m.name === modeName) ?? modes[0];
  const entry =
    (mode && es.find((e) => e.modeId === mode.id)) ?? (es.length === 1 ? es[0] : undefined);
  if (!entry) return null;
  const alias = aliasOf(entry.data);
  if (!alias) return literal(entry.data);
  if (hops >= 16) return null;
  const target = lookup(ctx.byId, ctx.byKey, alias);
  return target ? resolve(ctx, target, modeName, hops + 1) : null;
}

function variables(doc: Doc) {
  const ctx: VarCtx = {
    byId: new Map(),
    byKey: new Map(),
    collections: new Map(),
    collectionsByKey: new Map(),
  };
  for (const n of doc.nodes) {
    if (n.type === "VARIABLE") {
      ctx.byId.set(n.id, n);
      if (typeof n.raw.key === "string") ctx.byKey.set(n.raw.key, n);
    } else if (n.type === "VARIABLE_SET") {
      ctx.collections.set(n.id, n);
      if (typeof n.raw.key === "string") ctx.collectionsByKey.set(n.raw.key, n);
    }
  }
  const collections = [...ctx.collections.values()].map((c) => ({
    id: c.id,
    name: c.name,
    fromLibrary: !!c.raw.sourceLibraryKey,
    modes: modesOf(c).map((m) => m.name),
  }));
  const vars = [...ctx.byId.values()].map((v) => {
    const col = collectionOf(ctx, v);
    const modes = modesOf(col);
    const valuesByMode: Record<string, unknown> = {};
    const aliasesByMode: Record<string, string> = {};
    const es = entries(v);
    for (const m of modes.length ? modes : es.map((e) => ({ id: e.modeId, name: e.modeId }))) {
      valuesByMode[m.name] = resolve(ctx, v, m.name);
      const e = es.find((x) => x.modeId === m.id);
      const alias = e && aliasOf(e.data);
      if (alias) {
        const t = lookup(ctx.byId, ctx.byKey, alias);
        aliasesByMode[m.name] = t ? t.name : (refKey(alias).key ?? refKey(alias).id ?? "?");
      }
    }
    return {
      id: v.id,
      name: v.name,
      type: v.raw.variableResolvedType ?? null,
      collection: col?.name ?? null,
      collectionId: col?.id ?? null,
      fromLibrary: !!v.raw.sourceLibraryKey,
      valuesByMode,
      ...(Object.keys(aliasesByMode).length ? { aliasesByMode } : {}),
    };
  });
  return { collections, vars };
}

/** Drops float32 noise (0.30000001192 → 0.3). */
const f32 = (v: unknown) => (typeof v === "number" ? Number(v.toPrecision(6)) : v);

function prototype(doc: Doc) {
  const flowStarts: Raw[] = [];
  const links: Raw[] = [];
  for (const n of doc.nodes) {
    const sp = n.raw.prototypeStartingPoint;
    if (sp && (sp.name !== undefined || sp.position !== undefined))
      flowStarts.push({ id: n.id, name: n.name, flow: sp.name ?? null });
    for (const it of n.raw.prototypeInteractions ?? []) {
      if (it.isDeleted) continue;
      for (const a of it.actions ?? []) {
        const to = guidId(a.transitionNodeID);
        const url = a.connectionURL || null;
        if (!to && !url) continue;
        const link: Raw = {
          from: n.id,
          fromName: n.name,
          trigger: it.event?.interactionType,
          afterSeconds: f32(it.event?.transitionTimeout),
          navigation: a.navigationType,
          to,
          toName: to ? doc.byId.get(to)?.name : undefined,
          transition: a.transitionType,
          seconds: f32(a.transitionDuration),
          easing: a.easingType,
          easingCurve:
            Array.isArray(a.easingFunction) && a.easingFunction.length
              ? a.easingFunction.map(f32)
              : undefined,
          smartAnimate: a.transitionShouldSmartAnimate || undefined,
          url,
        };
        for (const k of Object.keys(link))
          if (link[k] === undefined || link[k] === null || link[k] === "") delete link[k];
        links.push(link);
      }
    }
  }
  if (!flowStarts.length && !links.length) return undefined;
  links.sort(
    (a, b) => Number(a.navigation === "SWAP_STATE") - Number(b.navigation === "SWAP_STATE"),
  );
  return { flowStarts, links: links.slice(0, 500), linkCount: links.length };
}

export interface SummaryInput {
  doc: Doc;
  media: MediaUse;
  file: Raw;
}

export function makeSummary({ doc, media, file }: SummaryInput) {
  const byType = new Map<string, number>();
  for (const n of doc.nodes) tally(byType, n.type);

  const pages = doc.pages.map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.raw.visible === false ? { hidden: true } : {}),
    ...(p.raw.internalOnly ? { internalOnly: true } : {}),
    topLevel: p.children.filter(isDesignNode).map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      ...canvasBox(c),
      ...(c.raw.visible === false ? { hidden: true } : {}),
    })),
  }));

  const colors = new Map<string, number>();
  let gradientPaints = 0;
  for (const n of doc.nodes) {
    if (!isDesignNode(n) || !isVisibleDeep(n)) continue;
    for (const p of [...paintsOf(n.raw, "fillPaints"), ...paintsOf(n.raw, "strokePaints")]) {
      if (!paintShown(p)) continue;
      const t = paintType(p);
      if (t === "SOLID") tally(colors, colorLabel(p.color, p.opacity ?? 1));
      else if (t.startsWith("GRADIENT")) gradientPaints++;
    }
  }

  const styles = doc.nodes.filter(isStyleNode).map((n) => {
    const s: Raw = {
      id: n.id,
      name: n.name,
      styleType: n.raw.styleType,
      fromLibrary: !!n.raw.sourceLibraryKey,
    };
    const paints = paintsOf(n.raw, "fillPaints");
    if (paints.length) s.paints = paints.map(describePaint);
    if (n.raw.styleType === "TEXT" || n.type === "TEXT")
      s.font = {
        family: n.raw.fontName?.family ?? null,
        style: n.raw.fontName?.style ?? null,
        postscript: n.raw.fontName?.postscript ?? null,
        size: n.raw.fontSize ?? null,
      };
    if (Array.isArray(n.raw.effects) && n.raw.effects.length)
      s.effects = n.raw.effects.map((e: Raw) => e.type);
    return s;
  });

  const { collections, vars } = variables(doc);

  const components = doc.nodes
    .filter((n) => n.type === "SYMBOL" || (n.type === "FRAME" && n.raw.isStateGroup))
    .slice(0, 400)
    .map((n) => {
      const page = pageOf(n);
      return {
        id: n.id,
        name: n.name,
        kind: n.type === "SYMBOL" ? "component" : "componentSet",
        page: page?.name ?? null,
        ...(page?.raw.internalOnly ? { libraryMaster: true } : {}),
      };
    });

  const order = (a: MediaRecord, b: MediaRecord) =>
    Number(a.thumbnail) - Number(b.thumbnail) || b.visibleUses - a.visibleUses;
  const images = [...media.images.values()].sort(order);
  const videos = [...media.videos.values()].sort(order);

  const proto = prototype(doc);
  return {
    file,
    counts: {
      nodes: doc.nodes.length,
      byType: Object.fromEntries(byCount(byType)),
      blobs: doc.blobs.length,
      images: images.length,
    },
    pages,
    fonts: fonts(doc),
    solidColorsByUse: byCount(colors)
      .slice(0, 60)
      .map(([color, uses]) => ({ color, uses })),
    gradientPaints,
    styles,
    variableCollections: collections,
    variables: vars,
    components,
    images,
    ...(videos.length ? { videos } : {}),
    ...(proto ? { prototype: proto } : {}),
  };
}

export type Summary = ReturnType<typeof makeSummary>;

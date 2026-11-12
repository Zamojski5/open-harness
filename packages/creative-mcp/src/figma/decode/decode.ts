// `decode`: input (local-copy archive, bare canvas or clipboard HTML) → a folder of digestible files.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Schema } from "kiwi-schema";
import {
  decodeCanvas,
  DecodeError,
  extractClipboard,
  InflateBudget,
  isCanvas,
  isZip,
  LIMITS,
  zipEntries,
  zipRead,
} from "./container.ts";
import { buildDoc, guidId, isDesignNode, type Doc, type Raw } from "./model.ts";
import { buildOutline } from "./outline.ts";
import { diagnose } from "./schemaCheck.ts";
import { makeSummary, collectMedia, type MediaRecord } from "./summary.ts";

export type ImagesMode = "referenced" | "all" | "none";

/** Byte fields → hex (≤64 bytes) or {$base64,length}; int64 → number when safe, else string. */
export function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return b.length <= 64 ? b.toString("hex") : { $base64: b.toString("base64"), length: b.length };
  }
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  return value;
}
export const toJson = (v: unknown) => JSON.stringify(v, replacer);

export function renderSchema(schema: Schema): string {
  const out: string[] = [];
  for (const d of schema.definitions) {
    out.push(`${d.kind.toLowerCase()} ${d.name} {`);
    for (const f of d.fields)
      out.push(
        d.kind === "ENUM"
          ? `  ${f.name} = ${f.value}`
          : `  ${f.name}: ${f.type}${f.isArray ? "[]" : ""} = ${f.value}${f.isDeprecated ? " [deprecated]" : ""}`,
      );
    out.push("}", "");
  }
  return out.join("\n");
}

export function detectImageType(b: Uint8Array): string {
  const s = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (s(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (s(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (s(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (s(0, 0x52, 0x49, 0x46, 0x46) && s(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  if (s(0, 0x49, 0x49, 0x2a, 0x00) || s(0, 0x4d, 0x4d, 0x00, 0x2a)) return "tiff";
  if (s(0, 0x42, 0x4d)) return "bmp";
  if (s(0, 0x25, 0x50, 0x44, 0x46)) return "pdf";
  const head = Buffer.from(b.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "bin";
}

export function detectVideoType(b: Uint8Array): string {
  const s = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (s(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (s(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = Buffer.from(b.subarray(8, 12)).toString("latin1");
    return brand === "qt  " ? "mov" : "mp4";
  }
  return "bin";
}

interface Loaded {
  magic: string;
  version: number;
  schema: Schema;
  message: Raw;
  media: Map<string, { folder: "images" | "videos"; bytes: Buffer }>;
  meta: Buffer | null;
  thumbnail: Buffer | null;
  clipboardMeta?: Raw | null;
  isPaste: boolean;
}

export function loadInput(path: string): Loaded {
  const size = NodeFS.statSync(path).size;
  if (size > LIMITS.inputBytes)
    throw new DecodeError(
      `input is ${Math.round(size / 1024 / 1024)} MB; the decoder accepts up to ${Math.round(LIMITS.inputBytes / 1024 / 1024)} MB`,
    );
  const buf = NodeFS.readFileSync(path);
  const budget = new InflateBudget();
  if (isZip(buf)) {
    const entries = zipEntries(buf);
    const canvasEntry = entries.get("canvas.fig");
    if (!canvasEntry) throw new DecodeError("zip has no canvas.fig");
    const decoded = decodeCanvas(zipRead(buf, canvasEntry, budget), budget);
    const media = new Map<string, { folder: "images" | "videos"; bytes: Buffer }>();
    for (const e of entries.values()) {
      const m = /^(images|videos)\/([0-9a-f]{40})$/i.exec(e.name);
      if (m)
        media.set(m[2]!.toLowerCase(), {
          folder: m[1] as "images" | "videos",
          bytes: zipRead(buf, e, budget),
        });
    }
    const meta = entries.get("meta.json");
    const thumb = entries.get("thumbnail.png");
    return {
      ...decoded,
      media,
      meta: meta ? zipRead(buf, meta, budget) : null,
      thumbnail: thumb ? zipRead(buf, thumb, budget) : null,
      isPaste: false,
    };
  }
  if (isCanvas(buf))
    return {
      ...decodeCanvas(buf, budget),
      media: new Map(),
      meta: null,
      thumbnail: null,
      isPaste: false,
    };
  const clip = extractClipboard(buf.toString("utf8"));
  return {
    ...decodeCanvas(clip.canvas, budget),
    media: new Map(),
    meta: null,
    thumbnail: null,
    clipboardMeta: clip.meta,
    isPaste: true,
  };
}

function blobsOf(message: Raw): Uint8Array[] {
  return (Array.isArray(message.blobs) ? message.blobs : []).map((b: Raw) =>
    b?.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(),
  );
}

/** Every guid found anywhere under a value (used for the clipboard selection regions). */
function guidsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (!v || typeof v !== "object" || depth > 6 || v instanceof Uint8Array) return out;
  const id = guidId(v as Raw);
  if (id) out.push(id);
  else for (const x of Array.isArray(v) ? v : Object.values(v)) guidsIn(x, out, depth + 1);
  return out;
}

function pasteRoots(doc: Doc, message: Raw): string[] {
  const fromRegions = [...new Set(guidsIn(message.clipboardSelectionRegions))].filter((id) =>
    doc.byId.has(id),
  );
  if (fromRegions.length) return fromRegions;
  const page = doc.pages.find((p) => !p.raw.internalOnly);
  return page ? page.children.filter(isDesignNode).map((c) => c.id) : [];
}

export interface DecodeOptions {
  out: string;
  images?: ImagesMode;
}

export function decodeToDir(input: string, opts: DecodeOptions) {
  const mode = opts.images ?? "referenced";
  const out = NodePath.resolve(opts.out);
  const loaded = loadInput(input);
  const { message } = loaded;
  const nodeChanges: Raw[] = Array.isArray(message.nodeChanges) ? message.nodeChanges : [];
  const blobs = blobsOf(message);
  const doc = buildDoc(nodeChanges, blobs);
  NodeFS.mkdirSync(out, { recursive: true });

  const nodesFile = NodeFS.openSync(NodePath.join(out, "nodes.jsonl"), "w");
  try {
    for (const n of nodeChanges) NodeFS.writeSync(nodesFile, `${toJson(n)}\n`);
  } finally {
    NodeFS.closeSync(nodesFile);
  }
  NodeFS.writeFileSync(
    NodePath.join(out, "blobs.jsonl"),
    blobs
      .map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64"))
      .join("\n") + (blobs.length ? "\n" : ""),
  );
  const rest: Raw = {};
  for (const [k, v] of Object.entries(message))
    if (k !== "nodeChanges" && k !== "blobs") rest[k] = v;
  NodeFS.writeFileSync(NodePath.join(out, "message.json"), toJson(rest));
  NodeFS.writeFileSync(NodePath.join(out, "schema.txt"), renderSchema(loaded.schema));
  if (loaded.meta) NodeFS.writeFileSync(NodePath.join(out, "meta.json"), loaded.meta);
  if (loaded.thumbnail) NodeFS.writeFileSync(NodePath.join(out, "thumbnail.png"), loaded.thumbnail);

  // Media: referenced records merged with archive members.
  const media = collectMedia(doc);
  const referencedImages = media.images.size + media.videos.size;
  if (mode === "all")
    for (const [hash, m] of loaded.media) {
      const map = m.folder === "videos" ? media.videos : media.images;
      if (!map.has(hash))
        map.set(hash, { hash, uses: 0, visibleUses: 0, thumbnail: false, nodes: [] });
    }
  let imagesWritten = 0;
  const place = (folder: "images" | "videos", map: Map<string, MediaRecord>) => {
    for (const r of map.values()) {
      const m = loaded.media.get(r.hash);
      if (!m) {
        if (loaded.isPaste) r.notOnClipboard = true;
        else r.missing = true;
        continue;
      }
      r.bytes = m.bytes.length;
      const write = mode === "all" || (mode === "referenced" && r.visibleUses > 0 && !r.thumbnail);
      if (!write) continue;
      const ext = folder === "videos" ? detectVideoType(m.bytes) : detectImageType(m.bytes);
      NodeFS.mkdirSync(NodePath.join(out, folder), { recursive: true });
      const rel = `${folder}/${r.hash}.${ext}`;
      NodeFS.writeFileSync(NodePath.join(out, rel), m.bytes);
      r.file = rel;
      if (folder === "images") imagesWritten++;
    }
  };
  place("images", media.images);
  place("videos", media.videos);

  let metaName: string | null = null;
  if (loaded.meta) {
    try {
      const j = JSON.parse(loaded.meta.toString("utf8")) as Raw;
      metaName = j.file_name ?? j.fileName ?? j.name ?? null;
    } catch {
      // meta is copied verbatim anyway
    }
  }
  const file: Raw = { name: metaName, magic: loaded.magic, version: loaded.version };
  let fileKey: string | null = null;
  let roots: { id: string; type: string; name: string }[] = [];
  if (loaded.isPaste) {
    const meta = loaded.clipboardMeta ?? null;
    fileKey =
      (typeof meta?.fileKey === "string" && meta.fileKey) ||
      (typeof message.pasteFileKey === "string" && message.pasteFileKey) ||
      null;
    roots = pasteRoots(doc, message).map((id) => {
      const n = doc.byId.get(id)!;
      return { id, type: n.type, name: n.name };
    });
    file.clipboard = { ...meta, fileKey, roots };
  }

  const diagnostics = diagnose({
    schema: loaded.schema,
    message,
    doc,
    isPaste: loaded.isPaste,
    archiveMedia: loaded.media.size,
    referencedImages,
  });
  const summary = { ...makeSummary({ doc, media, file }), diagnostics };
  NodeFS.writeFileSync(NodePath.join(out, "summary.json"), JSON.stringify(summary, null, 1));
  NodeFS.writeFileSync(NodePath.join(out, "outline.txt"), buildOutline(doc));

  return {
    out,
    magic: loaded.magic,
    version: loaded.version,
    nodes: doc.nodes.length,
    pages: doc.pages.map((p) => p.name),
    images: summary.images.length,
    imagesWritten,
    ...(summary.videos ? { videos: summary.videos.length } : {}),
    fonts: summary.fonts.length,
    styles: summary.styles.length,
    variables: summary.variables.length,
    ...(loaded.isPaste ? { fileKey, roots: roots.map((r) => r.id) } : {}),
    ...(diagnostics.schemaMismatch
      ? {
          schemaMismatch: true,
          warnings: diagnostics.warnings,
          hint: `${diagnostics.hint} schema.txt: ${NodePath.join(out, "schema.txt")}`,
        }
      : {}),
  };
}

/** Reloads nodes.jsonl + blobs.jsonl (byte fields stay hex / {$base64}). */
export function loadDecodedDir(dir: string): Doc {
  const nodesPath = NodePath.join(dir, "nodes.jsonl");
  if (!NodeFS.existsSync(nodesPath))
    throw new Error(`${dir} is not a decoded folder (no nodes.jsonl); run decode first`);
  const nodes: Raw[] = [];
  for (const line of NodeFS.readFileSync(nodesPath, "utf8").split("\n"))
    if (line) nodes.push(JSON.parse(line) as Raw);
  const blobsPath = NodePath.join(dir, "blobs.jsonl");
  const blobs = NodeFS.existsSync(blobsPath)
    ? NodeFS.readFileSync(blobsPath, "utf8")
        .split("\n")
        .slice(0, -1)
        .map((l) => new Uint8Array(Buffer.from(l, "base64")))
    : [];
  return buildDoc(nodes, blobs);
}

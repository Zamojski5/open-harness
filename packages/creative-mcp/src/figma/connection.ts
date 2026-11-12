// The token connection's four reads (status, get, render, images) and the status cache that feeds
// the passive status line. Tools in tools.ts are thin wrappers around these.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ohHome } from "../home.ts";
import { detectImageType } from "./decode/decode.ts";
import { apiGet, atomicWrite, download, FigmaError, pool, type RateLimitInfo } from "./api.ts";
import { FigmaLinkError, parseFigmaLink, validNodeId } from "./link.ts";
import { forgetCachedToken, resolveToken, type TokenSource } from "./token.ts";

export type FigmaState = "connected" | "not-connected" | "reconnect-required" | "unavailable";

export interface StatusCache {
  state: FigmaState;
  tokenSource: TokenSource;
  figmaUserId: string | null;
  checkedAt: string;
}

const CACHE = () => ohHome("figma.json");

export function readStatusCache(): StatusCache | null {
  try {
    const j = JSON.parse(NodeFS.readFileSync(CACHE(), "utf8")) as StatusCache;
    return j && typeof j.state === "string" ? j : null;
  } catch {
    return null;
  }
}

function writeStatusCache(c: StatusCache) {
  try {
    NodeFS.mkdirSync(ohHome(), { recursive: true });
    NodeFS.writeFileSync(CACHE(), JSON.stringify(c), { mode: 0o600 });
  } catch {
    // the cache only feeds the status line
  }
}

/** One context line derived passively from the cache (no network); null when unknown. */
export function statusLine(cache = readStatusCache()): string | null {
  if (!cache) return null;
  if (cache.state === "connected")
    return "Figma: token connected; read links with figma_get / figma_render / figma_images (decode pastes and local copies with figma_decode).";
  if (cache.state === "not-connected")
    return "Figma: no token; work from a paste or local copy (figma_decode), offer to set one up only if the live file is needed.";
  if (cache.state === "reconnect-required")
    return "Figma: token rejected or expired; ask the user for a new one (stored in the Keychain from their own terminal).";
  return null;
}

/** On a 401 anywhere, remember that the token needs replacing. */
function markRejected(source: TokenSource) {
  forgetCachedToken();
  writeStatusCache({
    state: "reconnect-required",
    tokenSource: source,
    figmaUserId: readStatusCache()?.figmaUserId ?? null,
    checkedAt: new Date().toISOString(),
  });
}

async function call(path: string) {
  const t = resolveToken();
  if (!t.token) throw new FigmaError("AUTH_REQUIRED", t.keychainError ?? "No Figma token is set");
  try {
    return await apiGet(path, t.token);
  } catch (error) {
    if (error instanceof FigmaError && error.code === "AUTH_INVALID") markRejected(t.source);
    throw error;
  }
}

export interface FileRef {
  fileKey: string;
  nodeId: string | null;
}

export function parseFile(file: string): FileRef {
  if (file.length > 2048)
    throw new FigmaError("INVALID_INPUT", "file is longer than 2048 characters");
  try {
    return parseFigmaLink(file);
  } catch (error) {
    if (error instanceof FigmaLinkError)
      throw new FigmaError("INVALID_INPUT", error.message, {
        hint: "Pass a figma.com link or a bare file key.",
      });
    throw error;
  }
}

export function parseNodes(nodes: string[] | undefined, fallback: string | null): string[] {
  const list = nodes && nodes.length ? nodes : fallback ? [fallback] : [];
  if (list.length > 500) throw new FigmaError("INVALID_INPUT", "at most 500 nodes per call");
  const out: string[] = [];
  for (const raw of list) {
    if (raw.length > 400)
      throw new FigmaError("INVALID_INPUT", "a node id is longer than 400 characters");
    const id = validNodeId(raw);
    if (!id)
      throw new FigmaError("INVALID_INPUT", `not a node id: ${raw.slice(0, 60)}`, {
        hint: "Use colon-form ids like 12:345 or I40:3;88:15 (hyphen forms from URLs are accepted).",
      });
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const fileName = (id: string) => id.replaceAll(":", "-").replaceAll(";", "_");

// figma_status

export interface StatusResult {
  state: FigmaState;
  tokenSource: TokenSource;
  figmaUser?: { handle: string; email?: string };
  identityUnknown?: true;
  checkedAt: string;
  rateLimitType?: string;
  note?: string;
}

export async function figmaStatus(file?: string): Promise<StatusResult> {
  const t = resolveToken();
  const checkedAt = new Date().toISOString();
  const done = (r: StatusResult, userId: string | null = null) => {
    if (r.state === "reconnect-required") forgetCachedToken();
    writeStatusCache({
      state: r.state,
      tokenSource: r.tokenSource,
      figmaUserId: userId,
      checkedAt,
    });
    return r;
  };
  if (!t.token)
    return done({
      state: "not-connected",
      tokenSource: "none",
      checkedAt,
      ...(t.keychainError ? { note: t.keychainError } : {}),
    });
  try {
    const { body, rateLimit } = await apiGet("/me", t.token);
    const handle = typeof body.handle === "string" ? body.handle : "";
    const email = typeof body.email === "string" ? body.email : undefined;
    return done(
      {
        state: "connected",
        tokenSource: t.source,
        figmaUser: { handle, ...(email ? { email } : {}) },
        checkedAt,
        ...(rateLimit.rateLimitType ? { rateLimitType: rateLimit.rateLimitType } : {}),
      },
      typeof body.id === "string" ? body.id : null,
    );
  } catch (error) {
    if (!(error instanceof FigmaError)) throw error;
    if (error.code === "AUTH_INVALID")
      return done({ state: "reconnect-required", tokenSource: t.source, checkedAt });
    if (error.code === "ACCESS_DENIED") {
      // A 403 on /me usually means the token lacks current_user:read, not that it is bad.
      const base: StatusResult = {
        state: "connected",
        tokenSource: t.source,
        identityUnknown: true,
        checkedAt,
        note: "The token cannot read the user profile (add current_user:read to see who it belongs to).",
      };
      if (file) {
        try {
          const ref = parseFile(file);
          await apiGet(`/files/${ref.fileKey}/meta`, t.token);
          base.note = `${base.note} A file-scoped probe of ${ref.fileKey} succeeded.`;
        } catch (probe) {
          if (probe instanceof FigmaError && probe.code === "AUTH_INVALID")
            return done({ state: "reconnect-required", tokenSource: t.source, checkedAt });
          if (probe instanceof FigmaError) base.note = `${base.note} File probe: ${probe.code}.`;
        }
      }
      return done(base);
    }
    if (error.code === "TRANSPORT")
      return done({ state: "unavailable", tokenSource: t.source, checkedAt, note: error.message });
    throw error;
  }
}

// figma_get

export const PARTS = [
  "nodes",
  "file",
  "styles",
  "components",
  "component-sets",
  "variables",
  "meta",
] as const;
export type Part = (typeof PARTS)[number];

export interface GetArgs {
  file: string;
  nodes?: string[] | undefined;
  part?: Part | undefined;
  depth?: number | undefined;
  geometry?: boolean | undefined;
  output?: string | undefined;
}

export function getPath(ref: FileRef, a: GetArgs): { path: string; ids: string[] } {
  const part = a.part ?? "nodes";
  const params = new URLSearchParams();
  let ids: string[] = [];
  if (part === "nodes" || part === "file") {
    if (part === "nodes") {
      ids = parseNodes(a.nodes, ref.nodeId);
      if (!ids.length)
        throw new FigmaError("INVALID_INPUT", "part nodes needs node ids", {
          hint: "Name the nodes, pass a link with node-id, or use part file.",
        });
      params.set("ids", ids.join(","));
    } else if (a.nodes?.length) {
      ids = parseNodes(a.nodes, null);
      params.set("ids", ids.join(","));
    }
    if (a.depth !== undefined) params.set("depth", String(a.depth));
    if (a.geometry) params.set("geometry", "paths");
  }
  const q = params.toString()
    ? `?${params.toString().replaceAll("%2C", ",").replaceAll("%3A", ":").replaceAll("%3B", ";")}`
    : "";
  const base = `/files/${ref.fileKey}`;
  const path =
    part === "nodes"
      ? `${base}/nodes${q}`
      : part === "file"
        ? `${base}${q}`
        : part === "variables"
          ? `${base}/variables/local`
          : part === "component-sets"
            ? `${base}/component_sets`
            : `${base}/${part}`;
  return { path, ids };
}

function getSummary(part: Part, body: Record<string, unknown>, ids: string[]) {
  if (part === "nodes") {
    const nodes = (body.nodes ?? {}) as Record<
      string,
      { document?: { name?: string; type?: string } } | null
    >;
    return {
      name: body.name ?? null,
      nodes: ids.map((id) => {
        const d = nodes[id]?.document;
        return d ? { id, name: d.name ?? null, type: d.type ?? null } : { id, missing: true };
      }),
    };
  }
  if (part === "file") {
    const doc = body.document as { children?: { id: string; name: string }[] } | undefined;
    return {
      name: body.name ?? null,
      lastModified: body.lastModified ?? null,
      pages: (doc?.children ?? []).map((p) => ({ id: p.id, name: p.name })),
    };
  }
  const counts: Record<string, number | string> = {};
  const scan = (o: Record<string, unknown>, prefix = "") => {
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) counts[prefix + k] = v.length;
      else if (v && typeof v === "object" && !prefix) scan(v as Record<string, unknown>, `${k}.`);
      else if (v && typeof v === "object") counts[prefix + k] = Object.keys(v).length;
    }
  };
  scan(body);
  return { keys: Object.keys(body), counts };
}

export async function figmaGet(a: GetArgs, project = process.cwd()) {
  const ref = parseFile(a.file);
  const part = a.part ?? "nodes";
  if (!PARTS.includes(part)) throw new FigmaError("INVALID_INPUT", `unknown part ${String(part)}`);
  if (a.depth !== undefined && (!Number.isInteger(a.depth) || a.depth < 1 || a.depth > 100))
    throw new FigmaError("INVALID_INPUT", "depth must be 1-100");
  const { path, ids } = getPath(ref, a);
  const { body, bytes } = await call(path);
  const output = NodePath.resolve(
    project,
    a.output ??
      NodePath.join(".open-herness", "tmp", "figma", "rest", `${ref.fileKey}-${part}.json`),
  );
  atomicWrite(output, bytes);
  return {
    fileKey: ref.fileKey,
    part,
    output,
    bytes: bytes.length,
    summary: getSummary(part, body, ids),
  };
}

// figma_render

export interface RenderArgs {
  file: string;
  nodes?: string[] | undefined;
  format?: "png" | "jpg" | "svg" | "pdf" | undefined;
  scale?: number | undefined;
  output?: string | undefined;
}

export async function figmaRender(a: RenderArgs, project = process.cwd()) {
  const ref = parseFile(a.file);
  const ids = parseNodes(a.nodes, ref.nodeId);
  if (!ids.length)
    throw new FigmaError("INVALID_INPUT", "name the nodes to render, or pass a link with node-id");
  const format = a.format ?? "png";
  const scale = a.scale ?? 2;
  if (!(scale >= 0.01 && scale <= 4)) throw new FigmaError("INVALID_INPUT", "scale must be 0.01-4");
  const outDir = NodePath.resolve(
    project,
    a.output ?? NodePath.join("assets", "figma", ref.fileKey),
  );
  const urls = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const q = `ids=${batch.join(",")}&format=${format}${format === "png" || format === "jpg" ? `&scale=${scale}` : ""}`;
    const { body } = await call(`/images/${ref.fileKey}?${q}`);
    if (body.err)
      throw new FigmaError(
        "INVALID_RESPONSE",
        `Figma render error: ${String(body.err).slice(0, 200)}`,
      );
    const images = (body.images ?? {}) as Record<string, unknown>;
    for (const id of batch) if (images[id]) urls.set(id, images[id]);
  }
  const todo = ids.filter((id) => urls.has(id));
  const results = await pool(todo, 4, async (id) => {
    const { bytes } = await download(urls.get(id));
    const path = NodePath.join(outDir, `${fileName(id)}.${format}`);
    atomicWrite(path, bytes);
    return { node: id, path };
  });
  const failed = results.find((r) => r.status === "rejected");
  if (failed && results.every((r) => r.status === "rejected"))
    throw (failed as PromiseRejectedResult).reason;
  const files = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const downloadFailed = todo.filter((_, i) => results[i]!.status === "rejected");
  return {
    fileKey: ref.fileKey,
    format,
    files,
    notRendered: ids.filter((id) => !urls.has(id)),
    ...(downloadFailed.length ? { downloadFailed, hint: "URLs expire; run again for these." } : {}),
  };
}

// figma_images

const MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "image/svg+xml": "svg",
};

export async function figmaImages(
  a: { file: string; hashes: string[]; output?: string | undefined },
  project = process.cwd(),
) {
  const ref = parseFile(a.file);
  if (!a.hashes.length || a.hashes.length > 500)
    throw new FigmaError("INVALID_INPUT", "pass 1-500 image hashes");
  for (const h of a.hashes)
    if (!/^[0-9a-f]{40}$/.test(h))
      throw new FigmaError(
        "INVALID_INPUT",
        `not an image hash (40 lowercase hex): ${h.slice(0, 50)}`,
      );
  const hashes = [...new Set(a.hashes)];
  const outDir = NodePath.resolve(
    project,
    a.output ?? NodePath.join("assets", "figma", ref.fileKey, "images"),
  );
  const { body } = await call(`/files/${ref.fileKey}/images`);
  const map = ((body.meta as { images?: Record<string, unknown> } | undefined)?.images ??
    {}) as Record<string, unknown>;
  const present = hashes.filter((h) => typeof map[h] === "string" && map[h]);
  const results = await pool(present, 4, async (hash) => {
    const { bytes, contentType } = await download(map[hash]);
    let ext = detectImageType(bytes);
    if (ext === "bin" || ext === "tiff" || ext === "bmp")
      ext = MEDIA_EXT[(contentType ?? "").split(";")[0]!.trim()] ?? (ext === "bin" ? "bin" : ext);
    const path = NodePath.join(outDir, `${hash}.${ext}`);
    atomicWrite(path, bytes);
    return { hash, path };
  });
  const failed = results.find((r) => r.status === "rejected");
  if (failed && results.every((r) => r.status === "rejected"))
    throw (failed as PromiseRejectedResult).reason;
  const downloadFailed = present.filter((_, i) => results[i]!.status === "rejected");
  return {
    fileKey: ref.fileKey,
    files: results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
    missing: hashes.filter((h) => !present.includes(h)),
    ...(downloadFailed.length ? { downloadFailed, hint: "URLs expire; run again for these." } : {}),
  };
}

export type { RateLimitInfo };

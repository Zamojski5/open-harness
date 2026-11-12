// Provenance sidecars: takes/.meta/<take-file>.json next to every generated take, and lookup by path
// or by content (sha256), so a renamed/copied take can still be traced to its model, prompt and inputs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const sidecarPath = (outputPath: string) => join(dirname(outputPath), ".meta", `${basename(outputPath)}.json`);

export function writeSidecar(outputPath: string, data: Record<string, unknown>) {
  const p = sidecarPath(outputPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ file: basename(outputPath), outputSha256: sha256File(outputPath), bytes: statSync(outputPath).size, ...data }, null, 2));
  return p;
}

/** Reference description for provenance: local files by content hash, URLs as given. */
export function describeRef(ref: string) {
  if (/^https?:/.test(ref)) return { url: ref };
  if (ref.startsWith("data:")) return { dataUri: true, sha256: sha256(ref) };
  try {
    return { path: ref, sha256: sha256File(ref), bytes: statSync(ref).size };
  } catch {
    return { path: ref, missing: true };
  }
}

/** Native input with inline data (data URIs, base64 image bytes) replaced by a short summary. */
export function sanitizeNative(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:") && value.includes(",")) return `${value.slice(0, value.indexOf(",") + 1)}… (${(value.length * 0.75 / 1024).toFixed(1)} KB, sha256 ${sha256(value).slice(0, 16)})`;
    if (value.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 200))) return `<base64 ${Math.round(value.length * 0.75 / 1024)} KB, sha256 ${sha256(value).slice(0, 16)}>`;
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeNative);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeNative(v)]));
  return value;
}

/** Sidecar for a file: by its own .meta entry, else by sha256 among the given takes folders. */
export function findProvenance(path: string, searchDirs: string[]): { sidecar: string; data: Record<string, unknown>; matchedBy: "path" | "sha256" } | undefined {
  const direct = sidecarPath(path);
  if (existsSync(direct)) return { sidecar: direct, data: JSON.parse(readFileSync(direct, "utf8")), matchedBy: "path" };
  if (!existsSync(path)) return undefined;
  const hash = sha256File(path);
  for (const dir of new Set([join(dirname(path), ".meta"), ...searchDirs.map((d) => join(d, ".meta"))])) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
        if (data.outputSha256 === hash) return { sidecar: join(dir, name), data, matchedBy: "sha256" };
      } catch {
        // skip unreadable sidecar
      }
    }
  }
  return undefined;
}

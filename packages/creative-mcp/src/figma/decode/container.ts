// Figma local-copy containers: the ZIP archive layer, the `fig-…` canvas layer with its chunks,
// per-chunk decompression (sniffed from each chunk's own bytes) and Kiwi decoding with the schema
// the file carries itself. Nothing here hard-codes a schema.

import * as NodeZlib from "node:zlib";
import { Decompress as FzstdStream } from "fzstd";
import { compileSchema, decodeBinarySchema, type Schema } from "kiwi-schema";

export class DecodeError extends Error {}

/**
 * Limits for untrusted input. A local copy is mostly stored images (100 MB+ is normal); the schema
 * and message chunks inflate to a few hundred MB for very large files. Anything past these limits is
 * treated as a decompression bomb and refused with a clear error instead of exhausting memory.
 */
export const LIMITS = {
  /** Input file on disk. */
  inputBytes: 1536 * 1024 * 1024,
  /** One inflated chunk or ZIP member. */
  inflatedBytes: 1024 * 1024 * 1024,
  /** All inflated chunks and ZIP members of one input together. */
  totalInflatedBytes: 3 * 1024 * 1024 * 1024,
};

const tooBig = (what: string, cap: number) =>
  new DecodeError(
    `${what} inflates past ${Math.round(cap / 1024 / 1024)} MB; refusing (corrupt file or decompression bomb)`,
  );

/** Tracks the inflated total of one input against LIMITS.totalInflatedBytes. */
export class InflateBudget {
  used = 0;
  take(n: number, what: string) {
    this.used += n;
    if (this.used > LIMITS.totalInflatedBytes)
      throw tooBig(`${what} (running total)`, LIMITS.totalInflatedBytes);
  }
}

const isTooLarge = (error: unknown) =>
  (error as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

export const isZip = (b: Buffer) => b.length >= 4 && u32(b, 0) === 0x04034b50;

/** Lists entries from the central directory (ZIP64 aware). */
export function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DecodeError("broken zip: no end-of-directory record");
  let count = u16(buf, eocd + 10);
  let cdOffset = u32(buf, eocd + 16);
  const loc = eocd - 20;
  if (loc >= 0 && u32(buf, loc) === 0x07064b50) {
    const z64 = u64(buf, loc + 8);
    if (u32(buf, z64) === 0x06064b50) {
      count = u64(buf, z64 + 32);
      cdOffset = u64(buf, z64 + 48);
    }
  }
  const out = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50)
      throw new DecodeError("broken zip: bad central directory");
    const method = u16(buf, p + 10);
    let compressedSize = u32(buf, p + 20);
    let size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    let localOffset = u32(buf, p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // ZIP64 extended info: present values follow in this order for fields saturated at 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = u16(buf, e);
      const len = u16(buf, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = u64(buf, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(buf, q);
          q += 8;
        }
        if (localOffset === 0xffffffff) localOffset = u64(buf, q);
      }
      e += 4 + len;
    }
    out.set(name, { name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(buf: Buffer, entry: ZipEntry, budget?: InflateBudget): Buffer {
  const p = entry.localOffset;
  if (p + 30 > buf.length || u32(buf, p) !== 0x04034b50)
    throw new DecodeError(`broken zip: bad header for ${entry.name}`);
  const start = p + 30 + u16(buf, p + 26) + u16(buf, p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    let out: Buffer;
    try {
      out = NodeZlib.inflateRawSync(data, { maxOutputLength: LIMITS.inflatedBytes });
    } catch (error) {
      if (isTooLarge(error)) throw tooBig(`zip entry ${entry.name}`, LIMITS.inflatedBytes);
      throw new DecodeError(
        `zip entry ${entry.name} could not be inflated: ${String(error).slice(0, 120)}`,
      );
    }
    budget?.take(out.length, `zip entry ${entry.name}`);
    return out;
  }
  throw new DecodeError(`zip entry ${entry.name} uses unsupported compression ${entry.method}`);
}

export interface Canvas {
  magic: string;
  version: number;
  chunks: Uint8Array[];
}

export const isCanvas = (b: Uint8Array) =>
  b.length >= 4 && b[0] === 0x66 && b[1] === 0x69 && b[2] === 0x67 && b[3] === 0x2d; // "fig-"

export function splitCanvas(buf: Uint8Array): Canvas {
  if (!isCanvas(buf) || buf.length < 12)
    throw new DecodeError("not a Figma canvas (no fig- magic)");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder("latin1").decode(buf.subarray(0, 8)).replace(/\0+$/, "");
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let p = 12;
  while (p + 4 <= buf.length) {
    const len = view.getUint32(p, true);
    if (len === 0 || p + 4 + len > buf.length) break;
    chunks.push(buf.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  if (chunks.length < 2)
    throw new DecodeError(`canvas has ${chunks.length} chunk(s); need schema + message`);
  return { magic, version, chunks };
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export type Compression = "zstd" | "zlib" | "deflate";

export function sniffCompression(b: Uint8Array): Compression {
  if (b.length >= 4 && ZSTD_MAGIC.every((v, i) => b[i] === v)) return "zstd";
  if (b.length >= 2 && (b[0]! & 0x0f) === 8 && b[0]! >> 4 <= 7 && ((b[0]! << 8) | b[1]!) % 31 === 0)
    return "zlib";
  return "deflate";
}

/** Pure-JS zstd with an output cap (fzstd's one-shot API has none). */
export function fzstdCapped(b: Uint8Array, cap: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const stream = new FzstdStream((chunk) => {
    total += chunk.length;
    if (total > cap) throw tooBig("zstd chunk", cap);
    parts.push(chunk);
  });
  stream.push(b, true);
  return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

function zstd(b: Uint8Array): Uint8Array {
  const native = (
    NodeZlib as { zstdDecompressSync?: (x: Uint8Array, o?: { maxOutputLength?: number }) => Buffer }
  ).zstdDecompressSync;
  if (typeof native === "function") {
    try {
      return native(b, { maxOutputLength: LIMITS.inflatedBytes });
    } catch (error) {
      if (isTooLarge(error)) throw tooBig("zstd chunk", LIMITS.inflatedBytes);
      // otherwise fall through to the pure-JS decoder
    }
  }
  try {
    return fzstdCapped(b, LIMITS.inflatedBytes);
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(
      `zstd chunk could not be decompressed (${String(error).slice(0, 120)}). Use Node 22.15+/23.8+ (built-in zstd) or reinstall the fzstd dependency.`,
    );
  }
}

export function inflateChunk(b: Uint8Array, budget?: InflateBudget): Uint8Array {
  const kind = sniffCompression(b);
  const opts = { maxOutputLength: LIMITS.inflatedBytes };
  try {
    const out =
      kind === "zstd"
        ? zstd(b)
        : kind === "zlib"
          ? NodeZlib.inflateSync(b, opts)
          : NodeZlib.inflateRawSync(b, opts);
    budget?.take(out.length, `${kind} chunk`);
    return out;
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    if (isTooLarge(error)) throw tooBig(`${kind} chunk`, LIMITS.inflatedBytes);
    throw new DecodeError(
      `${kind} chunk could not be decompressed: ${String(error).slice(0, 120)}`,
    );
  }
}

export interface DecodedCanvas {
  magic: string;
  version: number;
  schema: Schema;
  message: Record<string, unknown>;
}

/** Decodes a `fig-…` payload: chunk 0 = binary Kiwi schema, chunk 1 = root `Message`. */
export function decodeCanvas(buf: Uint8Array, budget = new InflateBudget()): DecodedCanvas {
  const { magic, version, chunks } = splitCanvas(buf);
  let schema: Schema;
  try {
    schema = decodeBinarySchema(inflateChunk(chunks[0]!, budget));
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(`schema chunk unreadable: ${(error as Error).message}`);
  }
  let compiled: Record<string, unknown>;
  try {
    compiled = compileSchema(schema) as Record<string, unknown>;
  } catch (error) {
    throw new DecodeError(
      `schema chunk is malformed: ${String((error as Error).message).slice(0, 160)}`,
    );
  }
  const decodeMessage = compiled["decodeMessage"];
  if (typeof decodeMessage !== "function")
    throw new DecodeError("schema has no Message type; this container is not a design document");
  let message: Record<string, unknown>;
  try {
    message = (decodeMessage as (b: Uint8Array) => Record<string, unknown>).call(
      compiled,
      inflateChunk(chunks[1]!, budget),
    );
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError(`message chunk unreadable: ${(error as Error).message}`);
  }
  return { magic, version, schema, message };
}

export interface ClipboardPayload {
  canvas: Buffer;
  meta: Record<string, unknown> | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (ENTITIES[e.toLowerCase()] ?? m),
  );

function block(html: string, tag: string): string | null {
  const m = new RegExp(`\\(${tag}\\)([\\s\\S]*?)\\(/${tag}\\)`).exec(html);
  if (!m) return null;
  return m[1]!.replace(/[^A-Za-z0-9+/=]/g, "");
}

/** Pulls the `(figma)` canvas and `(figmeta)` JSON out of copied HTML (literal or entity-escaped markers). */
export function extractClipboard(htmlRaw: string): ClipboardPayload {
  const html = /\(figma\)/.test(htmlRaw) ? htmlRaw : unescapeHtml(htmlRaw);
  // Entity-escaped bodies can hide '+' or '/' as &#43; / &#47;, so unescape before stripping.
  const body = block(html.includes("&#") ? unescapeHtml(html) : html, "figma");
  if (!body) throw new DecodeError("this HTML holds no Figma copy data");
  const canvas = Buffer.from(body, "base64");
  if (!isCanvas(canvas)) throw new DecodeError("this HTML holds no Figma copy data");
  let meta: Record<string, unknown> | null = null;
  const metaBody = block(html.includes("&#") ? unescapeHtml(html) : html, "figmeta");
  if (metaBody) {
    try {
      const parsed = JSON.parse(Buffer.from(metaBody, "base64").toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return { canvas, meta };
}

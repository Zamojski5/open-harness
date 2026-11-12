// Images sent to the model: a long edge over 2000 px is scaled to 2000. Anything still over 5 MB (16-bit renders, big GIF/WebP) is re-encoded as
// 8-bit PNG, then JPEG q90. Runs ffmpeg/sips as async child processes; every change is reported.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const IMAGE_MAX_SIDE = 2000;
export const IMAGE_MAX_BYTES = 5_242_880;
export const IMAGE_MAX_PIXELS = 50_000_000;

/** Width and height from a PNG, JPEG, GIF or WebP header; undefined when unknown. */
export function imageSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && data.toString("ascii", 0, 3) === "GIF")
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF") {
    const kind = data.toString("ascii", 12, 16);
    if (kind === "VP8X")
      return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (kind === "VP8 ")
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const b = data.readUInt32LE(21);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
    }
    return undefined;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return undefined;
      const marker = data[offset + 1]!;
      const length = data.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return undefined;
}

export function needsFit(data: Buffer): boolean {
  const size = imageSize(data);
  if (data.length > IMAGE_MAX_BYTES) return true;
  return size !== undefined && Math.max(size.width, size.height) > IMAGE_MAX_SIDE;
}

type Format = "png" | "jpg" | "gif" | "webp";

function formatOf(data: Buffer): Format | undefined {
  if (data.length >= 4 && data.readUInt32BE(0) === 0x89504e47) return "png";
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return "jpg";
  if (data.length >= 4 && data.toString("ascii", 0, 3) === "GIF") return "gif";
  if (data.length >= 12 && data.toString("ascii", 8, 12) === "WEBP") return "webp";
  return undefined;
}

const MIME: Record<Format, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** A PNG with an alpha channel (colour type 4 or 6). */
const pngHasAlpha = (data: Buffer) => data.length > 25 && (data[25] === 4 || data[25] === 6);

function runTool(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(bin, args, { timeout: 60_000 }, (error) => resolve(!error));
  });
}

export interface FittedImage {
  data: Buffer;
  mimeType: string;
  note: string;
}

/**
 * Makes `data` sendable: under 2000 px on the long edge and under 5 MB. Returns undefined when it
 * already is; otherwise the new image and a note saying what was done, or a note-only result
 * (data empty) when nothing worked.
 */
export async function fitImageAsync(data: Buffer): Promise<FittedImage | undefined> {
  const format = formatOf(data);
  const size = imageSize(data);
  const tooBig = size !== undefined && Math.max(size.width, size.height) > IMAGE_MAX_SIDE;
  if (!tooBig && data.length <= IMAGE_MAX_BYTES) return undefined;
  const label = size ? `${size.width}x${size.height}` : "unknown size";
  const fail = (why: string): FittedImage => ({
    data: Buffer.alloc(0),
    mimeType: "",
    note: `image (${label}, ${data.length} bytes) could not be made small enough to send: ${why}`,
  });
  if (!format) return fail("unknown image format");
  if (size && size.width * size.height > IMAGE_MAX_PIXELS) return fail("over 50 megapixels");
  const dir = await NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oh-fit-"));
  try {
    const src = NodePath.join(dir, `in.${format}`);
    await NodeFS.promises.writeFile(src, data);
    const scale =
      size && size.width >= size.height
        ? `scale='min(${IMAGE_MAX_SIDE},iw)':-2:flags=area`
        : `scale=-2:'min(${IMAGE_MAX_SIDE},ih)':flags=area`;
    const alpha = format === "png" ? pngHasAlpha(data) : format !== "jpg";
    const attempts: Array<{ out: string; format: Format; how: string; args: string[] }> = [
      {
        out: NodePath.join(dir, "out.png"),
        format: "png",
        how: "8-bit PNG",
        args: ["-vf", `${scale},format=${alpha ? "rgba" : "rgb24"}`],
      },
      {
        out: NodePath.join(dir, "out.jpg"),
        format: "jpg",
        how: "JPEG q90",
        args: ["-vf", `${scale},format=yuvj444p`, "-q:v", "2"],
      },
      {
        out: NodePath.join(dir, "out-small.jpg"),
        format: "jpg",
        how: "JPEG q75 (q90 was still over 5 MB)",
        args: ["-vf", `${scale},format=yuvj420p`, "-q:v", "6"],
      },
    ];
    // A JPEG source stays JPEG; everything else tries 8-bit PNG first, then JPEG.
    const ordered = format === "jpg" ? attempts.slice(1) : attempts;
    // sips cannot do the q75 step; it only stands in when ffmpeg is missing.
    for (const attempt of ordered) {
      const ok = await runTool("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        src,
        "-frames:v",
        "1",
        ...attempt.args,
        attempt.out,
      ]);
      if (!ok)
        await runTool("sips", [
          "-Z",
          String(IMAGE_MAX_SIDE),
          "-s",
          "format",
          attempt.format === "png" ? "png" : "jpeg",
          ...(attempt.format === "jpg"
            ? ["-s", "formatOptions", attempt.how.startsWith("JPEG q75") ? "75" : "90"]
            : []),
          src,
          "--out",
          attempt.out,
        ]);
      const out = await NodeFS.promises.readFile(attempt.out).catch(() => undefined);
      if (!out || out.length === 0 || out.length > IMAGE_MAX_BYTES) continue;
      const after = imageSize(out);
      return {
        data: out,
        mimeType: MIME[attempt.format],
        note: `image scaled from ${label} (${data.length} bytes) to ${after ? `${after.width}x${after.height}` : "a smaller size"} ${attempt.how} (${out.length} bytes)`,
      };
    }
    return fail("re-encoding with ffmpeg/sips did not get it under 5 MB");
  } finally {
    await NodeFS.promises.rm(dir, { recursive: true, force: true });
  }
}

type Block = { type: string; data?: unknown; mimeType?: unknown; [key: string]: unknown };

/** Fits every image block of a tool result; says what changed in one text block. */
export async function fitResultImages<T extends { content?: Block[] }>(result: T): Promise<T> {
  const content = Array.isArray(result?.content) ? result.content : undefined;
  if (!content?.some((block) => block.type === "image")) return result;
  const notes: string[] = [];
  const next: Block[] = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== "image" || typeof block.data !== "string") {
      next.push(block);
      continue;
    }
    const fitted = await fitImageAsync(Buffer.from(block.data, "base64"));
    if (!fitted) {
      next.push(block);
      continue;
    }
    notes.push(`${fitted.note.replace(/^image/, `image ${index + 1}`)}`);
    next.push(
      fitted.data.length === 0
        ? { type: "text", text: `[image ${index + 1} not sent: ${fitted.note}]` }
        : { ...block, data: fitted.data.toString("base64"), mimeType: fitted.mimeType },
    );
  }
  if (notes.length === 0) return result;
  return {
    ...result,
    content: [...next, { type: "text", text: `(Open Herness: ${notes.join("; ")}.)` }],
  };
}

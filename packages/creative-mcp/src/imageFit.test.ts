import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  fitImageAsync,
  fitResultImages,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  imageSize,
  needsFit,
} from "./imageFit.ts";

/** A noisy test image (noise defeats compression, like a real render) via ffmpeg. */
function make(width: number, height: number, ext: string, pixFmt?: string): Buffer | undefined {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-fit-test-"));
  try {
    const out = NodePath.join(dir, `img.${ext}`);
    NodeChildProcess.execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `nullsrc=s=${width}x${height},geq=random(1)*255:random(2)*255:random(3)*255`,
      "-frames:v",
      "1",
      ...(pixFmt ? ["-pix_fmt", pixFmt] : []),
      out,
    ]);
    return NodeFS.readFileSync(out);
  } catch {
    return undefined;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

NodeTest.test("reads PNG dimensions from the header", () => {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(4000, 16);
  header.writeUInt32BE(3000, 20);
  NodeAssert.deepEqual(imageSize(header), { width: 4000, height: 3000 });
  NodeAssert.equal(needsFit(header), true);
  header.writeUInt32BE(2000, 16);
  header.writeUInt32BE(1000, 20);
  NodeAssert.equal(needsFit(header), false);
});

NodeTest.test(
  "a 16-bit render at 2000 px but over 5 MB becomes an 8-bit image under the limit",
  async (t) => {
    const render = make(2000, 1600, "png", "rgb48be");
    if (!render) return t.skip("ffmpeg not available");
    NodeAssert.ok(render.length > IMAGE_MAX_BYTES);
    const fitted = await fitImageAsync(render);
    NodeAssert.ok(fitted && fitted.data.length > 0 && fitted.data.length <= IMAGE_MAX_BYTES);
    NodeAssert.match(fitted.note, /8-bit PNG|JPEG/);
  },
);

NodeTest.test("a 4K 16-bit render is scaled to 2000 px and reported", async (t) => {
  const render = make(3840, 1608, "png", "rgb48be");
  if (!render) return t.skip("ffmpeg not available");
  const result = await fitResultImages({
    content: [{ type: "image", data: render.toString("base64"), mimeType: "image/png" }],
  });
  const image = result.content![0]!;
  const size = imageSize(Buffer.from(String(image.data), "base64"))!;
  NodeAssert.equal(size.width, IMAGE_MAX_SIDE);
  NodeAssert.match(String(result.content![1]!.text), /image 1 scaled from 3840x1608/);
});

NodeTest.test(
  "a large GIF is converted, not dropped; small GIFs and PNGs pass unchanged",
  async (t) => {
    const gif = make(2600, 1400, "gif");
    if (!gif) return t.skip("ffmpeg not available");
    const result = await fitResultImages({
      content: [{ type: "image", data: gif.toString("base64"), mimeType: "image/gif" }],
    });
    NodeAssert.equal(result.content![0]!.type, "image");
    NodeAssert.notEqual(result.content![0]!.mimeType, "image/gif");
    const small = {
      content: [
        { type: "image", data: make(64, 64, "gif")!.toString("base64"), mimeType: "image/gif" },
      ],
    };
    NodeAssert.equal(await fitResultImages(small), small);
    const png = {
      content: [
        { type: "image", data: make(64, 64, "png")!.toString("base64"), mimeType: "image/png" },
      ],
    };
    NodeAssert.equal(await fitResultImages(png), png);
  },
);

NodeTest.test("an image that cannot be fitted is replaced by a note that says why", async () => {
  const junk = Buffer.alloc(IMAGE_MAX_BYTES + 10, 1);
  const result = await fitResultImages({
    content: [{ type: "image", data: junk.toString("base64"), mimeType: "image/png" }],
  });
  NodeAssert.match(String(result.content![0]!.text), /not sent: .*unknown image format/);
  NodeAssert.match(String(result.content![1]!.text), /could not be made small enough/);
});

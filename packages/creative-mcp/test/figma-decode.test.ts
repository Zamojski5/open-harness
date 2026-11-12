import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { run } from "../src/figma/cli.ts";
import {
  DecodeError,
  decodeCanvas,
  extractClipboard,
  sniffCompression,
  splitCanvas,
} from "../src/figma/decode/container.ts";
import { decodeToDir } from "../src/figma/decode/decode.ts";
import { parsePathBlob, parseNetwork, networkShapes } from "../src/figma/svg/geometry.ts";
import {
  canvas,
  clipboardHtml,
  designFixture,
  figArchive,
  g,
  networkBlob,
  pathBlob,
  zip,
} from "./figma-fixture.ts";

let dir = "";
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-figma-"));
});
afterEach(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, data: Buffer | string) => {
  const p = NodePath.join(dir, name);
  NodeFS.writeFileSync(p, data);
  return p;
};
const readJson = (p: string) => JSON.parse(NodeFS.readFileSync(p, "utf8"));
const lines = (p: string) => NodeFS.readFileSync(p, "utf8").split("\n").filter(Boolean);

describe("container layer", () => {
  it("sniffs compression per chunk, never by position", () => {
    const f = designFixture();
    for (const [schemaC, messageC] of [
      ["zstd", "zlib"],
      ["deflate", "zstd"],
      ["zlib", "deflate"],
    ] as const) {
      const buf = canvas(f.message, { schemaC, messageC, extra: true });
      const { chunks } = splitCanvas(buf);
      expect(chunks).toHaveLength(3);
      expect(sniffCompression(chunks[0]!)).toBe(schemaC);
      expect(sniffCompression(chunks[1]!)).toBe(messageC);
      const d = decodeCanvas(buf);
      expect(d.magic).toBe("fig-kiwi");
      expect(d.version).toBe(48);
      expect((d.message.nodeChanges as unknown[]).length).toBe(f.message.nodeChanges.length);
    }
  });

  it("reports other product magics instead of rejecting them", () => {
    expect(decodeCanvas(canvas(designFixture().message, { magic: "fig-deck" })).magic).toBe(
      "fig-deck",
    );
  });

  it("fails clearly on too few chunks and on a zip without canvas.fig", () => {
    const head = Buffer.alloc(16);
    head.write("fig-kiwi", 0, "latin1");
    expect(() => splitCanvas(head)).toThrow(/chunk/);
    const p = write("x.fig", zip([["meta.json", Buffer.from("{}")]]));
    expect(() => decodeToDir(p, { out: NodePath.join(dir, "o") })).toThrow("zip has no canvas.fig");
  });

  it("reads clipboard markers literally or entity-escaped, tolerating a bad meta block", () => {
    const m = designFixture().message;
    const a = extractClipboard(clipboardHtml(m, { fileKey: "PasteKey123" }, true));
    expect(a.meta).toEqual({ fileKey: "PasteKey123" });
    const b = extractClipboard(clipboardHtml(m, null, false));
    expect(b.meta).toBeNull();
    expect(b.canvas.subarray(0, 8).toString("latin1")).toBe("fig-kiwi");
    expect(() => extractClipboard("<p>hello</p>")).toThrow(DecodeError);
    expect(() => extractClipboard("<p>hello</p>")).toThrow("this HTML holds no Figma copy data");
  });
});

describe("decode outputs", () => {
  it("writes every output from a local-copy archive", () => {
    const f = designFixture();
    const out = NodePath.join(dir, "out");
    const r = decodeToDir(write("a.fig", figArchive(f)), { out });
    expect(r).toMatchObject({
      magic: "fig-kiwi",
      version: 48,
      nodes: 26,
      pages: ["Page 1", "Internal Only Canvas"],
      images: 2,
      imagesWritten: 1,
      styles: 1,
      variables: 3,
    });
    expect(r).not.toHaveProperty("fileKey");
    for (const name of [
      "summary.json",
      "outline.txt",
      "nodes.jsonl",
      "blobs.jsonl",
      "message.json",
      "schema.txt",
      "meta.json",
      "thumbnail.png",
    ])
      expect(NodeFS.existsSync(NodePath.join(out, name)), name).toBe(true);
    // nodes.jsonl: every stored node in file order, removed ones too; bytes as hex; int64 safe-or-string
    const nodes = lines(NodePath.join(out, "nodes.jsonl")).map((l) => JSON.parse(l));
    expect(nodes).toHaveLength(f.message.nodeChanges.length);
    expect(nodes[0].bigCounter).toBe("9007199254740993");
    const photo = nodes.find((n) => n.name === "Photo");
    expect(photo.fillPaints[0].image.hash).toBe(f.imageHash);
    // blobs.jsonl: one base64 line per blob, empty string for the empty one
    const blobs = NodeFS.readFileSync(NodePath.join(out, "blobs.jsonl"), "utf8").split("\n");
    expect(blobs.slice(0, -1)).toHaveLength(6);
    expect(blobs[5]).toBe("");
    expect(readJson(NodePath.join(out, "message.json"))).toEqual({ type: 1 });
    const schema = NodeFS.readFileSync(NodePath.join(out, "schema.txt"), "utf8");
    expect(schema).toContain("message NodeChange {");
    expect(schema).toContain("  fillPaints: Paint[] = 11");
    expect(schema).toContain("enum NodeType {");
    expect(schema).toContain("  SYMBOL = 10");
    // images: referenced visible written with sniffed extension, unused skipped by default
    expect(NodeFS.readdirSync(NodePath.join(out, "images"))).toEqual([`${f.imageHash}.png`]);
  });

  it("writes the digest fields", () => {
    const f = designFixture();
    const out = NodePath.join(dir, "out");
    decodeToDir(write("a.fig", figArchive(f, { schemaC: "deflate", messageC: "zlib" })), { out });
    const s = readJson(NodePath.join(out, "summary.json"));
    expect(s.file).toEqual({ name: "Fixture Design", magic: "fig-kiwi", version: 48 });
    expect(s.counts.nodes).toBe(26);
    expect(Object.keys(s.counts.byType)[0]).toBe("ROUNDED_RECTANGLE");
    expect(s.pages[0].topLevel).toEqual([
      { id: "1:10", type: "FRAME", name: "Hero", x: 100, y: 50, w: 200, h: 100 },
    ]);
    expect(s.pages[1]).toMatchObject({ hidden: true, internalOnly: true });
    expect(s.fonts).toContainEqual({
      font: "Satoshi / Medium",
      uses: 1,
      variableAxes: ["wght=500"],
    });
    expect(s.fonts).toContainEqual({ font: "Satoshi / Black", uses: 1 });
    expect(s.fonts).toContainEqual({ font: "Inter / Regular", uses: 1 });
    // hidden node colour (#00FFFF) excluded, style node colours excluded from use counts
    expect(s.solidColorsByUse.map((c: { color: string }) => c.color)).not.toContain("#00FFFF");
    // red: one fill + one stroke
    expect(s.solidColorsByUse).toContainEqual({ color: "#FF0000", uses: 2 });
    expect(s.gradientPaints).toBe(2);
    expect(s.styles).toEqual([
      {
        id: "1:40",
        name: "Brand/Red",
        styleType: "FILL",
        fromLibrary: false,
        paints: [{ type: "SOLID", color: "#FF0000" }],
      },
    ]);
    expect(s.variableCollections).toContainEqual({
      id: "1:41",
      name: "Theme",
      fromLibrary: false,
      modes: ["Light", "Dark"],
    });
    const accent = s.variables.find((v: { name: string }) => v.name === "bg/accent");
    expect(accent).toMatchObject({
      collection: "Theme",
      valuesByMode: { Light: "#FF0000", Dark: "#000000 @ 0.5" },
      aliasesByMode: { Light: "red/500" },
    });
    // an alias cycle stops at the hop cap
    expect(
      s.variables.find((v: { name: string }) => v.name === "loop/a").valuesByMode.Value,
    ).toBeNull();
    expect(s.components).toEqual([
      {
        id: "1:30",
        name: "Button",
        kind: "component",
        page: "Internal Only Canvas",
        libraryMaster: true,
      },
    ]);
    expect(s.images[0]).toMatchObject({
      hash: f.imageHash,
      uses: 1,
      visibleUses: 1,
      thumbnail: false,
      width: 4,
      height: 2,
      nodes: ["1:13"],
      file: `images/${f.imageHash}.png`,
    });
    expect(s.images[1]).toMatchObject({ thumbnail: true, missing: true });
    // prototype: deleted skipped, navigation before swaps, floats cleaned
    expect(s.prototype.flowStarts).toEqual([{ id: "1:10", name: "Hero", flow: "Flow 1" }]);
    expect(s.prototype.linkCount).toBe(2);
    expect(s.prototype.links[0]).toMatchObject({
      navigation: "NAVIGATE",
      to: "1:11",
      toName: "Brand block",
      seconds: 0.3,
      transition: "DISSOLVE",
    });
    expect(s.prototype.links[1].navigation).toBe("SWAP_STATE");
  });

  it("honours --images all and none", () => {
    const f = designFixture();
    const all = NodePath.join(dir, "all");
    expect(decodeToDir(write("a.fig", figArchive(f)), { out: all, images: "all" })).toMatchObject({
      images: 3,
      imagesWritten: 2,
    });
    expect(NodeFS.readdirSync(NodePath.join(all, "images")).sort()).toEqual(
      [`${f.imageHash}.png`, `${f.unusedHash}.png`].sort(),
    );
    const none = NodePath.join(dir, "none");
    expect(decodeToDir(write("b.fig", figArchive(f)), { out: none, images: "none" })).toMatchObject(
      { images: 2, imagesWritten: 0 },
    );
    expect(NodeFS.existsSync(NodePath.join(none, "images"))).toBe(false);
  });

  it("decodes a bare canvas payload", () => {
    const r = decodeToDir(
      write("canvas.fig", canvas(designFixture().message, { schemaC: "zlib" })),
      { out: NodePath.join(dir, "o") },
    );
    expect(r.nodes).toBe(26);
    expect(readJson(NodePath.join(dir, "o", "summary.json")).images[0].missing).toBe(true);
  });

  it("decodes a clipboard paste: file key, roots, notOnClipboard", () => {
    const f = designFixture();
    f.message.clipboardSelectionRegions = [{ nodes: [g(10)] }];
    const p = write(
      "figma-selection-1.html",
      clipboardHtml(f.message, { fileKey: "PasteKey123", pasteID: 7 }),
    );
    const out = NodePath.join(dir, "paste");
    const r = decodeToDir(p, { out });
    expect(r).toMatchObject({ fileKey: "PasteKey123", roots: ["1:10"], imagesWritten: 0 });
    const s = readJson(NodePath.join(out, "summary.json"));
    expect(s.file.name).toBeNull();
    expect(s.file.clipboard).toEqual({
      fileKey: "PasteKey123",
      pasteID: 7,
      roots: [{ id: "1:10", type: "FRAME", name: "Hero" }],
    });
    expect(s.images[0]).toMatchObject({ hash: f.imageHash, notOnClipboard: true });
    expect(s.images[0]).not.toHaveProperty("missing");
  });

  it("falls back to the message paste key and page children when meta and regions are absent", () => {
    const f = designFixture();
    f.message.pasteFileKey = "FromMessage9";
    const r = decodeToDir(write("p.html", clipboardHtml(f.message, null, false)), {
      out: NodePath.join(dir, "p"),
    });
    expect(r.fileKey).toBe("FromMessage9");
    expect(r.roots).toEqual(["1:10"]);
  });
});

describe("outline", () => {
  it("prints pages, tokens and depth trailers; cuts at max lines", () => {
    const out = NodePath.join(dir, "out");
    decodeToDir(write("a.fig", figArchive(designFixture())), { out });
    const full = NodeFS.readFileSync(NodePath.join(out, "outline.txt"), "utf8");
    expect(full).toContain('PAGE "Page 1" [1:1]');
    expect(full).toContain('PAGE "Internal Only Canvas" [1:2] HIDDEN (internal-only');
    expect(full).toContain('  FRAME "Hero" [1:10] 200x100 @100,50 fill=#FFFFFF');
    expect(full).toContain('ELLIPSE "Mask shape" [1:15] 30x30 @230,50 MASK');
    expect(full).toContain('INSTANCE "Button" [1:20] 80x20 @160,110 of "Button"');
    expect(full).toContain("fill=image:");
    expect(full).toContain('Satoshi Medium 12px: "Hello / world" (named)');
    expect(full).toContain("[1:23] 5x5 @100,50 HIDDEN");
    expect(full).not.toContain("Brand/Red");
    expect(full).not.toContain("bg/accent");
    expect(full).not.toContain("Gone");
    expect(run(["outline", out, "--depth", "1"]).stdout).toContain("… 11 children");
    const cut = run(["outline", out, "--max-lines", "3"]).stdout;
    expect(cut.split("\n")).toHaveLength(4);
    expect(cut).toContain("narrow with --page");
    expect(run(["outline", out, "--node", "1-14"]).stdout.split("\n")[0]).toContain(
      'FRAME "Masked" [1:14]',
    );
    expect(() => run(["outline", out, "--node", "9:9"])).toThrow("no node 9:9");
    expect(run(["outline", out, "--page", "Page 1"]).stdout).not.toContain("Internal Only");
  });
});

describe("path blobs and vector networks", () => {
  it("reads the quadratic opcode as a curve", () => {
    const cmds = parsePathBlob(pathBlob([[1, 0, 0], [3, 5, 5, 10, 0], [0]]));
    expect(cmds.map((c) => c.op)).toEqual(["M", "Q", "Z"]);
  });

  it("retries a blob that only parses with the legacy close reading", () => {
    const legacy = new Uint8Array([
      ...pathBlob([
        [1, 0, 0],
        [2, 5, 0],
        [2, 5, 5],
      ]),
      3,
      ...pathBlob([
        [1, 1, 1],
        [2, 2, 2],
      ]),
    ]);
    expect(parsePathBlob(legacy).map((c) => c.op)).toEqual(["M", "L", "L", "Z", "M", "L", "Z"]);
  });

  it("walks network loops, flipping reversed segments with their tangents", () => {
    // segment 1 is stored end→start relative to the loop direction
    const net = parseNetwork(
      networkBlob(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        [
          [0, 0, 0, 1, 0, 0],
          [2, 0, 0.5, 1, 0, 0],
          [2, 0, 0, 0, 0, 0],
        ],
        [{ nonzero: false, loops: [[0, 1, 2]] }],
      ),
    );
    const { fills, strokes } = networkShapes(net, 10, 10);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.nonzero).toBe(false);
    expect(fills[0]!.cmds.map((c) => c.op)).toEqual(["M", "L", "C", "L", "Z"]);
    // walking segment 1 backwards: from vertex 1 to 2, control points swapped with their tangents
    expect(fills[0]!.cmds[2]!.p).toEqual([10, 0, 10, 15, 10, 10]);
    expect(strokes).toHaveLength(0);
  });

  it("fills closed runs and strokes open ones when there are no regions", () => {
    const net = parseNetwork(
      networkBlob(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [5, 5],
        ],
        [
          [0, 0, 0, 1, 0, 0],
          [1, 0, 0, 2, 0, 0],
          [2, 0, 0, 0, 0, 0],
          [3, 0, 0, 2, 0, 0],
        ],
        [],
      ),
    );
    const { fills, strokes } = networkShapes(net, 1, 1);
    expect(fills).toHaveLength(1);
    expect(strokes.filter((c) => c.op === "M")).toHaveLength(2);
  });
});

describe("cli", () => {
  const CLI = NodeURL.fileURLToPath(new URL("../src/figma/cli.ts", import.meta.url));
  const exec = (args: string[]) => {
    try {
      return {
        code: 0,
        out: NodeChildProcess.execFileSync(process.execPath, [CLI, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (error) {
      const e = error as { status: number; stderr: string };
      return { code: e.status, err: e.stderr };
    }
  };

  it("prints one JSON line, or one error line with exit 1", () => {
    const p = write("a.fig", figArchive(designFixture()));
    const ok = exec(["decode", p, "--out", NodePath.join(dir, "o")]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out!).nodes).toBe(26);
    const bad = exec(["decode", write("x.html", "<b>nope</b>"), "--out", NodePath.join(dir, "x")]);
    expect(bad).toEqual({ code: 1, err: "error: this HTML holds no Figma copy data\n" });
    expect(exec([]).code).toBe(2);
  });
});

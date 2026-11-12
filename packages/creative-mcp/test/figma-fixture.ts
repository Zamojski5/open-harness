// Builds minimal Figma-style containers from the public format description, for tests only:
// a Kiwi schema written here (field names follow the community-known decoded dialect), a message
// encoded with it, the `fig-kiwi` chunked canvas, a stored ZIP archive and clipboard HTML.
// No real Figma file or client data is involved.

import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { compileSchema, encodeBinarySchema, parseSchema } from "kiwi-schema";

export const SCHEMA = `
package fig;
enum NodeType { NONE = 0; DOCUMENT = 1; CANVAS = 2; FRAME = 3; GROUP = 4; VECTOR = 5; BOOLEAN_OPERATION = 6; ELLIPSE = 7; ROUNDED_RECTANGLE = 8; TEXT = 9; SYMBOL = 10; INSTANCE = 11; VARIABLE_SET = 12; VARIABLE = 13; SLIDE_GRID = 14; SLIDE_ROW = 15; SLIDE = 16; LINE = 17; }
enum NodePhase { CREATED = 0; REMOVED = 1; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; GRADIENT_RADIAL = 2; GRADIENT_ANGULAR = 3; GRADIENT_DIAMOND = 4; IMAGE = 5; EMOJI = 6; VIDEO = 7; }
enum BlendMode { PASS_THROUGH = 0; NORMAL = 1; MULTIPLY = 2; SCREEN = 3; LINEAR_BURN = 4; }
enum ImageScaleMode { STRETCH = 0; FIT = 1; FILL = 2; TILE = 3; }
enum WindingRule { NONZERO = 0; ODD = 1; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; FOREGROUND_BLUR = 2; BACKGROUND_BLUR = 3; }
enum MaskType { ALPHA = 0; OUTLINE = 1; LUMINANCE = 2; }
enum StyleType { NONE = 0; FILL = 1; STROKE = 2; TEXT = 3; EFFECT = 4; GRID = 5; }
enum VariableResolvedType { BOOLEAN = 0; FLOAT = 1; STRING = 2; COLOR = 3; }
enum VariableDataType { BOOLEAN = 0; FLOAT = 1; STRING = 2; ALIAS = 3; COLOR = 4; }
enum NavigationType { NAVIGATE = 0; OVERLAY = 1; SWAP_STATE = 2; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Image { byte[] hash = 1; string name = 2; }
message ColorStop { Color color = 1; float position = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; BlendMode blendMode = 5; ColorStop[] stops = 6; Matrix transform = 7; Image image = 8; Image imageThumbnail = 9; ImageScaleMode imageScaleMode = 10; uint originalImageWidth = 11; uint originalImageHeight = 12; ColorStop[] stopsVar = 13; float scale = 14; Image animatedImage = 15; Image video = 16; float rotation = 17; }
message Path { WindingRule windingRule = 1; uint commandsBlob = 2; uint styleID = 3; }
message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; }
message Effect { EffectType type = 1; Color color = 2; Vector offset = 3; float radius = 4; bool visible = 5; float spread = 6; BlendMode blendMode = 7; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message FontVariation { uint axisTag = 1; string axisName = 2; float value = 3; }
message TextData { string characters = 1; uint[] characterStyleIDs = 2; NodeChange[] styleOverrideTable = 3; }
message Glyph { uint commandsBlob = 1; Vector position = 2; float fontSize = 3; uint firstCharacter = 4; }
message DerivedTextData { Glyph[] glyphs = 1; int truncationStartIndex = 2; }
message GUIDPath { GUID[] guids = 1; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message AssetRef { string key = 1; string version = 2; }
message VariableID { GUID guid = 1; AssetRef assetRef = 2; }
message VariableSetMode { GUID id = 1; string name = 2; }
message VariableAnyValue { bool boolValue = 1; string textValue = 2; float floatValue = 3; Color colorValue = 4; VariableID alias = 5; }
message VariableData { VariableAnyValue value = 1; VariableDataType dataType = 2; }
message VariableDataValuesEntry { GUID modeID = 1; VariableData variableData = 2; }
message VariableDataValues { VariableDataValuesEntry[] entries = 1; }
message PrototypeEvent { string interactionType = 1; float transitionTimeout = 2; }
message PrototypeAction { GUID transitionNodeID = 1; NavigationType navigationType = 2; string transitionType = 3; float transitionDuration = 4; string easingType = 5; float[] easingFunction = 6; bool transitionShouldSmartAnimate = 7; string connectionURL = 8; }
message PrototypeInteraction { PrototypeEvent event = 1; PrototypeAction[] actions = 2; bool isDeleted = 3; }
message PrototypeStartingPoint { string name = 1; string position = 2; }
message NodeChange {
  GUID guid = 1; NodePhase phase = 2; ParentIndex parentIndex = 3; NodeType type = 4; string name = 5;
  bool visible = 6; float opacity = 7; BlendMode blendMode = 8; Vector size = 9; Matrix transform = 10;
  Paint[] fillPaints = 11; Paint[] strokePaints = 12; float strokeWeight = 13;
  Path[] fillGeometry = 14; Path[] strokeGeometry = 15; VectorData vectorData = 16;
  float cornerRadius = 17; bool frameMaskDisabled = 18; bool mask = 19; MaskType maskType = 20;
  Effect[] effects = 21; TextData textData = 22; DerivedTextData derivedTextData = 23; FontName fontName = 24;
  float fontSize = 25; FontVariation[] fontVariations = 26; bool autoRename = 27; SymbolData symbolData = 28;
  NodeChange[] derivedSymbolData = 29; GUIDPath guidPath = 30; GUID overrideKey = 31; StyleType styleType = 32;
  string sourceLibraryKey = 33; bool isStateGroup = 34; bool resizeToFit = 35; bool internalOnly = 36;
  VariableSetMode[] variableSetModes = 37; VariableID variableSetID = 38; VariableResolvedType variableResolvedType = 39;
  VariableDataValues variableDataValues = 40; string key = 41; PrototypeInteraction[] prototypeInteractions = 42;
  PrototypeStartingPoint prototypeStartingPoint = 43; uint styleID = 44; int64 bigCounter = 45;
}
message Blob { byte[] bytes = 1; }
message SelectionRegion { GUID[] nodes = 1; }
message Message { uint type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; string pasteFileKey = 4; SelectionRegion[] clipboardSelectionRegions = 5; }
`;

type Any = Record<string, any>;

const schema = parseSchema(SCHEMA);
const compiled = compileSchema(schema) as { encodeMessage(m: Any): Uint8Array };

export type Compression = "zstd" | "zlib" | "deflate";

const squash = (b: Uint8Array, c: Compression): Uint8Array =>
  c === "zstd"
    ? NodeZlib.zstdCompressSync(b)
    : c === "zlib"
      ? NodeZlib.deflateSync(b)
      : NodeZlib.deflateRawSync(b);

/** `fig-kiwi` + LE u32 version + [LE u32 length, bytes]… with schema and message chunks. */
export function canvas(
  message: Any,
  opts: { schemaC?: Compression; messageC?: Compression; magic?: string; extra?: boolean } = {},
): Buffer {
  const chunks = [
    squash(encodeBinarySchema(schema), opts.schemaC ?? "zstd"),
    squash(compiled.encodeMessage(message), opts.messageC ?? "zstd"),
  ];
  if (opts.extra) chunks.push(new Uint8Array([1, 2, 3]));
  const head = Buffer.alloc(12);
  head.write((opts.magic ?? "fig-kiwi").padEnd(8, "\0").slice(0, 8), 0, "latin1");
  head.writeUInt32LE(48, 8);
  const parts: Buffer[] = [head];
  for (const c of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(c.length);
    parts.push(len, Buffer.from(c));
  }
  return Buffer.concat(parts);
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Stored (uncompressed) ZIP, like Figma's local copies. */
export function zip(files: [string, Uint8Array][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, Buffer.from(data));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A valid w×h RGB PNG filled with one colour. */
export function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(...rgb);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", NodeZlib.deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const sha1 = (b: Uint8Array) => NodeCrypto.createHash("sha1").update(b).digest();

/** Path blob writer: ops as [opcode, ...floats]. */
export function pathBlob(ops: number[][]): Uint8Array {
  const size = ops.reduce((n, o) => n + 1 + (o.length - 1) * 4, 0);
  const b = Buffer.alloc(size);
  let i = 0;
  for (const [op, ...v] of ops) {
    b[i++] = op!;
    for (const f of v) {
      b.writeFloatLE(f, i);
      i += 4;
    }
  }
  return new Uint8Array(b);
}

export function networkBlob(
  vertices: [number, number][],
  segments: [number, number, number, number, number, number][],
  regions: { nonzero: boolean; loops: number[][] }[],
): Uint8Array {
  const out: Buffer[] = [];
  const u = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    out.push(b);
  };
  const f = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    out.push(b);
  };
  u(vertices.length);
  u(segments.length);
  u(regions.length);
  for (const [x, y] of vertices) {
    u(0);
    f(x);
    f(y);
  }
  for (const [s, tsx, tsy, e, tex, tey] of segments) {
    u(0);
    u(s);
    f(tsx);
    f(tsy);
    u(e);
    f(tex);
    f(tey);
  }
  for (const r of regions) {
    u(r.nonzero ? 1 : 0);
    u(r.loops.length);
    for (const l of r.loops) {
      u(l.length);
      l.forEach(u);
    }
  }
  return new Uint8Array(Buffer.concat(out));
}

export const g = (localID: number, sessionID = 1) => ({ sessionID, localID });
const at = (x: number, y: number) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r: number, gg: number, b: number, a = 1, extra: Any = {}) => ({
  type: "SOLID",
  color: { r, g: gg, b, a },
  opacity: 1,
  visible: true,
  ...extra,
});
const node = (
  id: number,
  parent: number | null,
  pos: string,
  type: string,
  name: string,
  extra: Any = {},
): Any => ({
  guid: g(id),
  phase: "CREATED",
  ...(parent !== null
    ? { parentIndex: { guid: parent === 0 ? g(0, 0) : g(parent), position: pos } }
    : {}),
  type,
  name,
  ...extra,
});

export interface DesignFixture {
  message: Any;
  imageHash: string;
  imageBytes: Buffer;
  unusedHash: string;
  unusedBytes: Buffer;
}

/** A page with a frame holding a rect, a gradient, an image, a masked group, a boolean, text and an instance. */
export function designFixture(): DesignFixture {
  const imageBytes = png(4, 2, [200, 30, 30]);
  const imageHash = sha1(imageBytes);
  const unusedBytes = png(1, 1, [0, 0, 255]);
  const unusedHash = sha1(unusedBytes);
  const thumbHash = sha1(Buffer.from("thumb"));
  // blobs: 0 square path (quadratic opcode used as a curve), 1 legacy-close path, 2 glyph "I", 3 network triangle, 4 star boolean
  const blobs = [
    pathBlob([[1, 0, 0], [2, 10, 0], [3, 10, 10, 0, 10], [0]]),
    // legacy encoder: opcode 3 written as an operand-less close, then a second subpath
    new Uint8Array([
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
    ]),
    pathBlob([[1, 0, 0], [2, 0.1, 0], [2, 0.1, 0.7], [2, 0, 0.7], [0]]),
    networkBlob(
      [
        [0, 0],
        [1, 0],
        [0.5, 1],
      ],
      [
        [0, 0, 0, 1, 0, 0],
        [1, 0, 0, 2, 0, 0],
        [2, 0, 0, 0, 0, 0],
      ],
      [{ nonzero: true, loops: [[0, 1, 2]] }],
    ),
    pathBlob([[1, 0, 0], [2, 20, 0], [2, 20, 20], [2, 0, 20], [0]]),
    new Uint8Array(),
  ];
  const nodes: Any[] = [
    node(0, null, "", "DOCUMENT", "Document", { guid: g(0, 0) }),
    node(1, 0, "!", "CANVAS", "Page 1"),
    node(2, 0, "#", "CANVAS", "Internal Only Canvas", { visible: false, internalOnly: true }),
    // component master on the internal page
    node(30, 2, "!", "SYMBOL", "Button", {
      size: { x: 80, y: 20 },
      transform: at(0, 0),
      fillPaints: [solid(0, 0, 1)],
    }),
    node(31, 30, "!", "TEXT", "Label", {
      size: { x: 40, y: 10 },
      transform: at(5, 5),
      autoRename: true,
      fontName: { family: "Inter", style: "Bold", postscript: "Inter-Bold" },
      fontSize: 10,
      textData: { characters: "OK" },
      fillPaints: [solid(1, 1, 1)],
      derivedTextData: {
        glyphs: [{ commandsBlob: 2, position: { x: 0, y: 8 }, fontSize: 10, firstCharacter: 0 }],
      },
    }),
    // the frame
    node(10, 1, "!", "FRAME", "Hero", {
      size: { x: 200, y: 100 },
      transform: at(100, 50),
      fillPaints: [solid(1, 1, 1)],
      cornerRadius: 8,
      effects: [
        {
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          offset: { x: 0, y: 4 },
          radius: 8,
          visible: true,
          spread: 2,
        },
        { type: "INNER_SHADOW", color: { r: 0, g: 0, b: 0, a: 1 }, radius: 2, visible: true },
      ],
      prototypeStartingPoint: { name: "Flow 1", position: "a" },
      prototypeInteractions: [
        {
          event: { interactionType: "ON_CLICK" },
          actions: [
            { transitionNodeID: g(30), navigationType: "SWAP_STATE", transitionDuration: 0.2 },
          ],
        },
        {
          event: { interactionType: "ON_CLICK" },
          actions: [
            {
              transitionNodeID: g(11),
              navigationType: "NAVIGATE",
              transitionType: "DISSOLVE",
              transitionDuration: 0.3,
              easingType: "EASE_OUT",
            },
          ],
        },
        {
          isDeleted: true,
          event: { interactionType: "ON_HOVER" },
          actions: [{ transitionNodeID: g(11), navigationType: "NAVIGATE" }],
        },
      ],
    }),
    node(11, 10, "!", "ROUNDED_RECTANGLE", "Brand block", {
      size: { x: 10, y: 10 },
      transform: at(0, 0),
      fillPaints: [solid(1, 0, 0)],
      fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 0 }],
      strokePaints: [solid(0, 0, 0)],
      strokeGeometry: [{ windingRule: "NONZERO", commandsBlob: 4 }],
    }),
    node(12, 10, '"', "ROUNDED_RECTANGLE", "Gradient", {
      size: { x: 50, y: 20 },
      transform: at(20, 0),
      fillPaints: [
        {
          type: "GRADIENT_LINEAR",
          visible: true,
          opacity: 1,
          transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
          stops: [],
          stopsVar: [
            { color: { r: 0, g: 0, b: 0, a: 1 }, position: 0 },
            { color: { r: 1, g: 1, b: 1, a: 1 }, position: 1 },
          ],
        },
        {
          type: "GRADIENT_ANGULAR",
          visible: true,
          opacity: 0.5,
          transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
          stops: [
            { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
            { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
          ],
        },
      ],
    }),
    node(13, 10, "#", "ROUNDED_RECTANGLE", "Photo", {
      size: { x: 40, y: 40 },
      transform: at(80, 0),
      fillPaints: [
        {
          type: "IMAGE",
          visible: true,
          opacity: 1,
          image: { hash: imageHash },
          imageThumbnail: { hash: thumbHash },
          imageScaleMode: "FILL",
          originalImageWidth: 4,
          originalImageHeight: 2,
        },
      ],
    }),
    node(14, 10, "$", "FRAME", "Masked", {
      size: { x: 30, y: 30 },
      transform: at(130, 0),
      resizeToFit: true,
    }),
    node(15, 14, "!", "ELLIPSE", "Mask shape", {
      size: { x: 30, y: 30 },
      transform: at(0, 0),
      mask: true,
      fillPaints: [solid(0, 0, 0)],
    }),
    node(16, 14, '"', "ROUNDED_RECTANGLE", "Under mask", {
      size: { x: 30, y: 30 },
      transform: at(0, 0),
      fillPaints: [solid(0, 1, 0)],
    }),
    node(17, 10, "%", "BOOLEAN_OPERATION", "Union", {
      size: { x: 20, y: 20 },
      transform: at(0, 40),
      fillPaints: [solid(0.2, 0.2, 0.2)],
      fillGeometry: [{ windingRule: "ODD", commandsBlob: 4 }],
    }),
    node(18, 17, "!", "ROUNDED_RECTANGLE", "Operand", {
      size: { x: 10, y: 10 },
      fillPaints: [solid(0.1, 0.9, 0.1)],
    }),
    node(19, 10, "&", "VECTOR", "Triangle", {
      size: { x: 20, y: 20 },
      transform: at(30, 40),
      vectorData: { vectorNetworkBlob: 3, normalizedSize: { x: 1, y: 1 } },
      fillPaints: [solid(0, 0, 0)],
      strokePaints: [solid(1, 0, 0)],
      strokeWeight: 2,
    }),
    node(20, 10, "'", "INSTANCE", "Button", {
      size: { x: 80, y: 20 },
      transform: at(60, 60),
      fillPaints: [solid(0, 0, 1)],
      symbolData: {
        symbolID: g(30),
        symbolOverrides: [{ guidPath: { guids: [g(31)] }, textData: { characters: "Go" } }],
      },
      derivedSymbolData: [
        {
          guidPath: { guids: [g(31)] },
          derivedTextData: {
            glyphs: [
              { commandsBlob: 2, position: { x: 0, y: 8 }, fontSize: 10, firstCharacter: 0 },
              { commandsBlob: 2, position: { x: 3, y: 8 }, fontSize: 10, firstCharacter: 1 },
            ],
          },
        },
      ],
    }),
    node(21, 10, "(", "TEXT", "Headline", {
      size: { x: 60, y: 12 },
      transform: at(100, 60),
      autoRename: false,
      fontName: { family: "Satoshi", style: "Medium" },
      fontSize: 12,
      fontVariations: [{ axisName: "wght", value: 500 }],
      textData: {
        characters: "Hello\nworld",
        characterStyleIDs: [0, 0, 1],
        styleOverrideTable: [
          {
            styleID: 1,
            fontName: { family: "Satoshi", style: "Black" },
            fillPaints: [solid(1, 0, 0)],
          },
        ],
      },
      fillPaints: [solid(0.1, 0.1, 0.1)],
    }),
    node(22, 10, ")", "TEXT", "Unbaked", {
      size: { x: 20, y: 10 },
      transform: at(0, 80),
      textData: { characters: "no glyphs" },
    }),
    node(23, 10, "*", "ROUNDED_RECTANGLE", "Hidden thing", {
      visible: false,
      size: { x: 5, y: 5 },
      fillPaints: [solid(0, 1, 1)],
    }),
    node(24, 10, "+", "ROUNDED_RECTANGLE", "Legacy path", {
      size: { x: 5, y: 5 },
      transform: at(190, 90),
      fillPaints: [solid(0.5, 0.5, 0.5)],
      fillGeometry: [{ windingRule: "NONZERO", commandsBlob: 1 }],
    }),
    // styles and variables
    node(40, 1, "~", "ROUNDED_RECTANGLE", "Brand/Red", {
      styleType: "FILL",
      fillPaints: [solid(1, 0, 0)],
      visible: true,
    }),
    node(41, 1, "~~", "VARIABLE_SET", "Theme", {
      variableSetModes: [
        { id: g(1, 9), name: "Light" },
        { id: g(2, 9), name: "Dark" },
      ],
    }),
    node(42, 1, "~~~", "VARIABLE_SET", "Primitives", {
      variableSetModes: [{ id: g(3, 9), name: "Value" }],
    }),
    node(43, 1, "~~~~", "VARIABLE", "red/500", {
      variableSetID: { guid: g(42) },
      variableResolvedType: "COLOR",
      variableDataValues: {
        entries: [
          {
            modeID: g(3, 9),
            variableData: { dataType: "COLOR", value: { colorValue: { r: 1, g: 0, b: 0, a: 1 } } },
          },
        ],
      },
    }),
    node(44, 1, "~~~~~", "VARIABLE", "bg/accent", {
      variableSetID: { guid: g(41) },
      variableResolvedType: "COLOR",
      variableDataValues: {
        entries: [
          {
            modeID: g(1, 9),
            variableData: { dataType: "ALIAS", value: { alias: { guid: g(43) } } },
          },
          {
            modeID: g(2, 9),
            variableData: {
              dataType: "COLOR",
              value: { colorValue: { r: 0, g: 0, b: 0, a: 0.5 } },
            },
          },
        ],
      },
    }),
    node(45, 1, "~~~~~~", "VARIABLE", "loop/a", {
      variableSetID: { guid: g(42) },
      variableResolvedType: "FLOAT",
      variableDataValues: {
        entries: [
          {
            modeID: g(3, 9),
            variableData: { dataType: "ALIAS", value: { alias: { guid: g(45) } } },
          },
        ],
      },
    }),
    // a removed node must be ignored
    node(99, 1, "z", "ROUNDED_RECTANGLE", "Gone", { phase: "REMOVED" }),
  ];
  nodes[0]!.bigCounter = 9007199254740993n;
  return {
    message: { type: 1, nodeChanges: nodes, blobs: blobs.map((bytes) => ({ bytes })) },
    imageHash: imageHash.toString("hex"),
    imageBytes,
    unusedHash: unusedHash.toString("hex"),
    unusedBytes,
  };
}

export function figArchive(
  f: DesignFixture,
  c: { schemaC?: Compression; messageC?: Compression } = {},
): Buffer {
  return zip([
    ["canvas.fig", canvas(f.message, c)],
    ["meta.json", Buffer.from(JSON.stringify({ file_name: "Fixture Design", client_meta: {} }))],
    ["thumbnail.png", png(2, 2, [9, 9, 9])],
    [`images/${f.imageHash}`, f.imageBytes],
    [`images/${f.unusedHash}`, f.unusedBytes],
  ]);
}

/** Clipboard HTML as Figma writes it: base64 blocks inside comment markers in span attributes. */
export function clipboardHtml(message: Any, meta: Any | null, escaped = true): string {
  const fig = canvas(message).toString("base64");
  const m = meta ? Buffer.from(JSON.stringify(meta)).toString("base64") : "!!notbase64json";
  const wrap = (tag: string, body: string) =>
    escaped ? `&lt;!--(${tag})${body}(/${tag})--&gt;` : `<!--(${tag})${body}(/${tag})-->`;
  return `<meta charset="utf-8"><span data-metadata="${wrap("figmeta", m)}"></span><span data-buffer="${wrap("figma", fig)}"></span>`;
}

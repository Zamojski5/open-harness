// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - small reads of the project's brand folder per turn.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Open Herness: a short brand block for every user turn, built from the ./brand/ layout. Deterministic for unchanged files, so it stays cache-friendly.

export const BRAND_BLOCK_MAX_CHARS = 1500;
const NAME_MAX = 80;
const MAX_CHARACTERS = 2;
const MAX_GRAPHICS = 8;
const MAX_LOGOS = 4;
const MAX_PALETTE = 8;
const READ_LIMIT = 200_000;
/** A brand read slower than this is dropped for the turn (no block, a warning). */
export const BRAND_READ_TIMEOUT_MS = 2_000;

const CAPTURE_FILES = ["kit.md", "palette.json", "motion.json"] as const;
const NOT_A_BRAND = new Set(["logos", "fonts", "references", "assets", "directions"]);

export type BrandState = "active" | "choose" | "none";

export interface BrandResolution {
  readonly state: BrandState;
  /** Display name of the active brand. */
  readonly name?: string;
  /** Main file the brand came from, relative to the project. */
  readonly source?: string;
  /** Capture folders under brand/ (the choices when state is "choose"). */
  readonly choices: ReadonlyArray<string>;
  /** The block for the agent; only when state is "active". */
  readonly block?: string;
}

/**
 * Reads under one project folder. Paths that resolve (through symlinks) outside the project are
 * treated as missing, and at most READ_LIMIT bytes of a file are read.
 */
interface ProjectReader {
  readonly text: (path: string) => Promise<string | undefined>;
  readonly json: (path: string) => Promise<Record<string, unknown> | undefined>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly dirents: (path: string) => Promise<NodeFS.Dirent[]>;
}

async function insideRoot(root: string, path: string): Promise<string | undefined> {
  try {
    const real = await NodeFSP.realpath(path);
    return real === root || real.startsWith(`${root}${NodePath.sep}`) ? real : undefined;
  } catch {
    return undefined;
  }
}

async function readHead(path: string): Promise<string | undefined> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    // Stat first and open non-blocking: a FIFO named brand.md must not hold a libuv thread.
    if (!(await NodeFSP.stat(path)).isFile()) return undefined;
    handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, READ_LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function projectReader(cwd: string): Promise<ProjectReader | undefined> {
  let root: string;
  try {
    root = await NodeFSP.realpath(cwd);
  } catch {
    return undefined;
  }
  const text = async (path: string) => {
    const real = await insideRoot(root, path);
    return real === undefined ? undefined : readHead(real);
  };
  return {
    text,
    json: async (path) => parseJsonObject(await text(path)),
    exists: async (path) => (await insideRoot(root, path)) !== undefined,
    dirents: async (path) => {
      const real = await insideRoot(root, path);
      if (real === undefined) return [];
      try {
        return await NodeFSP.readdir(real, { withFileTypes: true });
      } catch {
        return [];
      }
    },
  };
}

/** One line, no angle brackets, collapsed whitespace, at most `max` chars. */
function cleanBrandText(value: string, max = 300): string {
  const line = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const cleanName = (value: string) => cleanBrandText(value, NAME_MAX);

/** Direct children of brand/ that hold a capture (kit.md, palette.json or motion.json). */
async function brandCaptureFolders(fs: ProjectReader, brandDir: string): Promise<string[]> {
  const candidates = (await fs.dirents(brandDir)).filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !NOT_A_BRAND.has(entry.name.toLowerCase()),
  );
  const holds = await Promise.all(
    candidates.map(async (entry) => {
      for (const file of CAPTURE_FILES)
        if (await fs.exists(NodePath.join(brandDir, entry.name, file))) return true;
      return false;
    }),
  );
  return candidates
    .filter((_, index) => holds[index])
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function activeMarker(
  fs: ProjectReader,
  brandDir: string,
  folders: ReadonlyArray<string>,
): Promise<string | undefined> {
  const text = await fs.text(NodePath.join(brandDir, "ACTIVE"));
  const wanted = text
    ?.split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^brand\//, "")
        .replace(/\/$/, ""),
    )
    .find((line) => line !== "");
  if (!wanted) return undefined;
  // Only an existing capture folder can be picked, so ACTIVE can't point outside brand/.
  return folders.find((folder) => folder.toLowerCase() === wanted.toLowerCase());
}

interface MarkdownDoc {
  readonly title?: string;
  readonly sections: ReadonlyMap<string, string[]>;
}

function parseMarkdown(text: string): MarkdownDoc {
  const sections = new Map<string, string[]>();
  let title: string | undefined;
  let current: string[] | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      if (heading[1] === "#" && title === undefined) {
        title = heading[2]!.trim();
        current = undefined;
      } else {
        current = [];
        sections.set(heading[2]!.trim().toLowerCase(), current);
      }
      continue;
    }
    if (current && line.trim() !== "") current.push(line.trim());
  }
  return { ...(title === undefined ? {} : { title }), sections };
}

function section(doc: MarkdownDoc, ...names: string[]): string[] {
  for (const [key, lines] of doc.sections) {
    if (
      names.some((name) => key === name || key.startsWith(`${name} `) || key.startsWith(`${name}(`))
    )
      return lines;
  }
  return [];
}

const bullet = (line: string) => line.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
const HEX = /#[0-9a-f]{3,8}\b/i;
// brand_capture writes "path, then a long dash, then why" lines in kit.md.
const KIT_SEPARATOR = ` ${String.fromCharCode(0x2014)} `;

/** "Paper #F4F2EE, ink: #0E0E0E" style prose, when brand.md has no palette table. */
function paletteFromProse(lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/([A-Za-z][\w -]{0,24}?)\s*[:=]?\s*(#[0-9a-f]{3,8})\b/gi)) {
      out.push(`${cleanBrandText(match[1]!.trim(), 30)} ${match[2]!.toUpperCase()}`);
    }
  }
  return out;
}

function paletteFromTable(lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const hexIndex = cells.findIndex((cell) => HEX.test(cell));
    if (hexIndex < 0) continue;
    const hex = HEX.exec(cells[hexIndex]!)![0].toUpperCase();
    const role = cells.find((cell, index) => index !== hexIndex && cell !== "" && !HEX.test(cell));
    out.push(role ? `${cleanBrandText(role, 30)} ${hex}` : hex);
  }
  return out;
}

const PATH_IN_TEXT = /\bbrand\/[^\s,;|)`'"]+\.(?:svg|png|pdf|jpe?g|webp|eps|ai)\b/gi;

function logosFrom(lines: ReadonlyArray<string>): string[] {
  const found = lines.flatMap((line) => line.match(PATH_IN_TEXT) ?? []);
  return [...new Set(found)].slice(0, MAX_LOGOS);
}

const DO_DONT = /^(do|don't|dont|do not|never|avoid|always)\b/i;

function doDontFrom(doc: MarkdownDoc): string[] {
  const listed = [
    ...section(doc, "do's and don'ts", "dos and don'ts", "do and don't", "rules").map(bullet),
    ...section(doc, "do").map((line) => `Do: ${bullet(line)}`),
    ...section(doc, "don't", "dont", "don’t").map((line) => `Don't: ${bullet(line)}`),
  ];
  const inline = [...doc.sections.values()]
    .flat()
    .map(bullet)
    .filter((line) => DO_DONT.test(line));
  return [...new Set([...listed, ...inline])];
}

function brandNameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const name = title
    .replace(/\s+[\u2014\u2013-]\s+brand capture$/i, "")
    .replace(/\s+brand(\s+(kit|contract|guide|book|guidelines))?$/i, "")
    .trim();
  return name === "" ? undefined : cleanName(name);
}

function paletteFromJson(palette: Record<string, unknown> | undefined): string[] {
  if (!palette) return [];
  const hexes = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          const hex = (entry as { hex?: unknown } | null)?.hex;
          return typeof hex === "string" && HEX.test(hex) ? [hex.toUpperCase()] : [];
        })
      : [];
  const theme = typeof palette.theme_color === "string" ? palette.theme_color.toUpperCase() : null;
  const accents = hexes(palette.chromatic).slice(0, 3);
  const neutrals = hexes(palette.neutrals).slice(0, 3);
  return [
    ...(theme && HEX.test(theme) ? [`theme ${theme}`] : []),
    ...accents.map((hex) => `accent ${hex}`),
    ...neutrals.map((hex) => `neutral ${hex}`),
  ];
}

function fontsFromKit(doc: MarkdownDoc): string[] {
  return section(doc, "typography")
    .filter((line) => /^[-*+]\s/.test(line))
    .map((line) => bullet(line).replace(/\s*\(\d+ rules\)$/, ""))
    .filter((line) => !/^no font-family/i.test(line))
    .slice(0, 3);
}

function logosFromKit(doc: MarkdownDoc, folder: string): string[] {
  return section(doc, "logos and icons", "logo")
    .map((line) => bullet(line).split(KIT_SEPARATOR)[0]!.trim())
    .filter((path) => /\.(svg|png|jpe?g|webp|ico)$/i.test(path) && !/^https?:/i.test(path))
    .map((path) => (path.startsWith("brand/") ? path : `brand/${folder}/${path}`))
    .slice(0, MAX_LOGOS);
}

function motionLine(motion: Record<string, unknown> | undefined): string | undefined {
  if (!motion) return undefined;
  const parts: string[] = [];
  if (typeof motion.pace === "string") parts.push(motion.pace);
  const median = (motion.shot_length_seconds as { median?: unknown } | undefined)?.median;
  if (typeof median === "number") parts.push(`median shot ${median} s`);
  if (typeof motion.cuts_per_minute === "number") parts.push(`${motion.cuts_per_minute} cuts/min`);
  const style = (motion.graphic_style as { render_style?: unknown } | undefined)?.render_style;
  if (typeof style === "string") parts.push(`look: ${style}`);
  const graphics = Array.isArray(motion.graphics)
    ? motion.graphics
        .flatMap((graphic) => {
          const name = (graphic as { name?: unknown } | null)?.name;
          const kind = (graphic as { kind?: unknown } | null)?.kind;
          return typeof name === "string"
            ? [cleanName(typeof kind === "string" ? `${name} (${kind})` : name)]
            : [];
        })
        .slice(0, MAX_GRAPHICS)
    : [];
  if (graphics.length)
    parts.push(`graphic devices (rebuild as vector/HTML motion): ${graphics.join(", ")}`);
  return parts.length ? parts.join("; ") : undefined;
}

interface CastMatch {
  readonly id: string;
  readonly line: string;
}

async function brandCharacters(
  fs: ProjectReader,
  cwd: string,
  keys: ReadonlyArray<string>,
): Promise<CastMatch[]> {
  const castDir = NodePath.join(cwd, "cast");
  const ids = (await fs.dirents(castDir))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const out: CastMatch[] = [];
  for (const id of ids) {
    if (out.length >= MAX_CHARACTERS) break;
    const card = await fs.json(NodePath.join(castDir, id, "card.json"));
    if (!card) continue;
    const brand = typeof card.brand === "string" ? card.brand.toLowerCase() : undefined;
    const tags = Array.isArray(card.tags)
      ? card.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    if (!(brand && wanted.has(brand)) && !tags.some((tag) => tag.toLowerCase() === "brand"))
      continue;
    const name = typeof card.name === "string" ? cleanName(card.name) : id;
    const kind = typeof card.kind === "string" ? cleanBrandText(card.kind, 40) : "character";
    const status = card.status === "ready" ? "ready" : "draft";
    out.push({ id, line: `${name} (cast/${cleanName(id)}, ${kind}, ${status})` });
  }
  return out;
}

export interface BrandFacts {
  readonly name: string;
  readonly source: string;
  readonly palette: ReadonlyArray<string>;
  readonly fonts: ReadonlyArray<string>;
  readonly logos: ReadonlyArray<string>;
  readonly voice?: string;
  readonly doDont: ReadonlyArray<string>;
  readonly characters: ReadonlyArray<string>;
  readonly motion?: string;
  readonly details: ReadonlyArray<string>;
}

const OPENING =
  "The project has a brand. Use it for anything branded (graphics, video, copy, sites); ignore it for unrelated work.";

type Section = "palette" | "fonts" | "logos" | "voice" | "doDont" | "characters" | "motion";
// Dropped first when over the cap.
const DROP_ORDER: ReadonlyArray<Section> = [
  "motion",
  "characters",
  "doDont",
  "voice",
  "logos",
  "fonts",
];

/** Builds the block; drops whole sections, then trims the palette, to stay within the cap. */
export function buildBrandBlock(facts: BrandFacts, maxChars = BRAND_BLOCK_MAX_CHARS): string {
  const name = cleanName(facts.name).replace(/"/g, "'");
  const source = cleanBrandText(facts.source, 120).replace(/"/g, "'");
  const open = `<oh_brand name="${name}" source="${source}">`;
  const close = "</oh_brand>";
  const details = `Details: ${facts.details.map((path) => cleanBrandText(path, 120)).join(", ")}`;
  const lines: Record<Section, string | undefined> = {
    palette: facts.palette.length
      ? `Palette: ${facts.palette
          .slice(0, MAX_PALETTE)
          .map((entry) => cleanBrandText(entry, 60))
          .join("; ")}`
      : undefined,
    fonts: facts.fonts.length
      ? `Fonts: ${facts.fonts.map((font) => cleanBrandText(font, 140)).join("; ")}`
      : undefined,
    logos: facts.logos.length ? `Logos: ${facts.logos.join(", ")}` : undefined,
    voice: facts.voice ? `Voice: ${cleanBrandText(facts.voice, 260)}` : undefined,
    doDont: facts.doDont.length
      ? `Do/don't: ${facts.doDont
          .slice(0, 5)
          .map((rule) => cleanBrandText(rule, 120))
          .join(" | ")}`
      : undefined,
    characters: facts.characters.length
      ? `Characters: ${facts.characters.join("; ")}. Generate them with the cast card id (cast argument), never redraw from memory.`
      : undefined,
    motion: facts.motion ? `Motion: ${cleanBrandText(facts.motion, 400)}` : undefined,
  };
  const order: ReadonlyArray<Section> = [
    "palette",
    "fonts",
    "logos",
    "voice",
    "doDont",
    "characters",
    "motion",
  ];
  const render = () =>
    [
      open,
      OPENING,
      // Every value line is cleaned once more here, so no field can break the tag or add a line.
      ...order.flatMap((key) => (lines[key] ? [cleanBrandText(lines[key], maxChars)] : [])),
      cleanBrandText(details, maxChars),
      close,
    ].join("\n");
  let block = render();
  for (const key of DROP_ORDER) {
    if (block.length <= maxChars) break;
    lines[key] = undefined;
    block = render();
  }
  if (block.length > maxChars && lines.palette) {
    const over = block.length - maxChars;
    lines.palette = `${lines.palette.slice(0, Math.max(0, lines.palette.length - over - 1)).trimEnd()}…`;
    block = render();
  }
  return block;
}

const NO_BRAND: BrandResolution = { state: "none", choices: [] };

/**
 * Reads ./brand/ of a project and builds the block. Never rejects: a read error, or a read slower
 * than `timeoutMs`, means no brand and a log warning.
 */
export async function resolveBrand(
  cwd: string | null | undefined,
  timeoutMs = BRAND_READ_TIMEOUT_MS,
): Promise<BrandResolution> {
  if (!cwd) return NO_BRAND;
  return withBrandTimeout(
    resolveBrandUnsafe(cwd).catch((cause: unknown) => {
      console.warn("Open Herness: could not read the brand folder", cause);
      return NO_BRAND;
    }),
    timeoutMs,
  );
}

/** The read, or no brand (and a warning) when it takes longer than `timeoutMs`. Exported for tests. */
export async function withBrandTimeout(
  read: Promise<BrandResolution>,
  timeoutMs: number,
): Promise<BrandResolution> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BrandResolution>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`Open Herness: the brand folder took over ${timeoutMs} ms; no brand this turn`);
      resolve(NO_BRAND);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBrandUnsafe(cwd: string): Promise<BrandResolution> {
  const fs = await projectReader(cwd);
  if (!fs) return NO_BRAND;
  const brandDir = NodePath.join(cwd, "brand");
  if (!(await fs.exists(brandDir))) return NO_BRAND;
  const folders = await brandCaptureFolders(fs, brandDir);
  if (await fs.exists(NodePath.join(brandDir, "NONE"))) return { state: "none", choices: folders };
  const marked = await activeMarker(fs, brandDir, folders);
  const single = folders.length === 1 ? folders[0] : undefined;
  const captureFolder = marked ?? single;

  const curatedText = await fs.text(NodePath.join(brandDir, "brand.md"));
  const motionFile =
    captureFolder && (await fs.exists(NodePath.join(brandDir, captureFolder, "motion.json")))
      ? `brand/${captureFolder}/motion.json`
      : undefined;
  const motion = motionLine(motionFile ? await fs.json(NodePath.join(cwd, motionFile)) : undefined);

  if (curatedText !== undefined) {
    const doc = parseMarkdown(curatedText);
    const name = brandNameFromTitle(doc.title) ?? captureFolder ?? NodePath.basename(cwd);
    const voiceLines = section(doc, "voice").map(bullet);
    const curatedMotion = section(doc, "motion").map(bullet).slice(0, 2).join("; ");
    const facts: BrandFacts = {
      name,
      source: "brand/brand.md",
      palette: (() => {
        const lines = section(doc, "palette", "colours", "colors", "colour", "color");
        const table = paletteFromTable(lines);
        return table.length ? table : paletteFromProse(lines);
      })(),
      fonts: section(doc, "typography")
        .map(bullet)
        .filter((line) => !/^rules:/i.test(line))
        .slice(0, 3),
      logos: (() => {
        const lines = section(doc, "logo", "logos");
        const paths = logosFrom(lines);
        return paths.length || !lines[0] ? paths : [cleanBrandText(bullet(lines[0]), 160)];
      })(),
      ...(voiceLines.length ? { voice: voiceLines.slice(0, 2).join("; ") } : {}),
      doDont: doDontFrom(doc),
      characters: (
        await brandCharacters(fs, cwd, [name, ...(captureFolder ? [captureFolder] : [])])
      ).map((match) => match.line),
      ...(motion || curatedMotion ? { motion: motion ?? curatedMotion } : {}),
      details: [
        "brand/brand.md",
        ...((await fs.exists(NodePath.join(brandDir, "overrides.md")))
          ? ["brand/overrides.md"]
          : []),
        ...(motionFile ? [motionFile] : []),
      ],
    };
    return {
      state: "active",
      name,
      source: "brand/brand.md",
      choices: folders,
      block: buildBrandBlock(facts),
    };
  }

  if (!captureFolder) {
    return folders.length > 1 ? { state: "choose", choices: folders } : NO_BRAND;
  }

  const folderDir = NodePath.join(brandDir, captureFolder);
  const kitText = await fs.text(NodePath.join(folderDir, "kit.md"));
  const kit = kitText === undefined ? undefined : parseMarkdown(kitText);
  const name = brandNameFromTitle(kit?.title) ?? cleanName(captureFolder);
  const source =
    kitText !== undefined ? `brand/${captureFolder}/kit.md` : `brand/${captureFolder}/`;
  const facts: BrandFacts = {
    name,
    source,
    palette: paletteFromJson(await fs.json(NodePath.join(folderDir, "palette.json"))),
    fonts: kit ? fontsFromKit(kit) : [],
    logos: kit ? logosFromKit(kit, captureFolder) : [],
    doDont: [],
    characters: (await brandCharacters(fs, cwd, [name, captureFolder])).map((match) => match.line),
    ...(motion ? { motion } : {}),
    details: [
      ...(kitText !== undefined ? [`brand/${captureFolder}/kit.md`] : []),
      ...((await fs.exists(NodePath.join(folderDir, "palette.json")))
        ? [`brand/${captureFolder}/palette.json`]
        : []),
      ...(motionFile ? [motionFile] : []),
      "raw capture: curate brand/brand.md with the brand-kit skill",
    ],
  };
  return { state: "active", name, source, choices: folders, block: buildBrandBlock(facts) };
}

const ohHome = () => process.env.OH_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");
const switchFile = () => NodePath.join(ohHome(), "brand-context.json");

function readSwitches(): Record<string, true> {
  let stored: Record<string, unknown> | undefined;
  try {
    stored = parseJsonObject(NodeFS.readFileSync(switchFile(), "utf8"));
  } catch {
    stored = undefined;
  }
  const off = stored?.off;
  return off && typeof off === "object" && !Array.isArray(off)
    ? (Object.fromEntries(
        Object.entries(off as Record<string, unknown>).filter(([, value]) => value === true),
      ) as Record<string, true>)
    : {};
}

export function isBrandContextEnabled(threadId: string | null | undefined): boolean {
  if (!threadId) return true;
  return readSwitches()[threadId] !== true;
}

export function setBrandContextEnabled(threadId: string, enabled: boolean): boolean {
  const off = readSwitches();
  if (enabled) delete off[threadId];
  else off[threadId] = true;
  const file = switchFile();
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${JSON.stringify({ off }, null, 2)}\n`);
  NodeFS.renameSync(temp, file);
  return enabled;
}

/** The block for a user turn, or "" when there is none or the thread switched it off. Never rejects. */
export async function brandContextForTurn(input: {
  readonly cwd: string | null | undefined;
  readonly threadId: string;
  readonly timeoutMs?: number;
}): Promise<string> {
  try {
    if (!isBrandContextEnabled(input.threadId)) return "";
    return (await resolveBrand(input.cwd, input.timeoutMs)).block ?? "";
  } catch (cause) {
    console.warn("Open Herness: brand context unavailable", cause);
    return "";
  }
}

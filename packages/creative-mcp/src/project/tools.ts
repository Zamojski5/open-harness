// Project memory and identity: the project brief + decisions log (in CLAUDE.md / AGENTS.md),
// cast cards (characters, locations, props with role-tagged references and a consent gate)
// and brand capture (site -> palette, fonts, logos, copy, screenshot; video -> cutting rhythm).

import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as cast from "./cast.ts";
import * as likeness from "./likeness.ts";
import { coded, GATED, KINDS, ORIGINS, ROLES, type CastCard, type Role } from "./cast.ts";

const run = promisify(execFile);
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const project = () => process.cwd();
const abs = (p: string) => resolve(project(), p);
const rel = (p: string) => {
  const r = relative(project(), abs(p));
  return r.startsWith("..") ? abs(p) : r;
};
const today = () => new Date().toISOString().slice(0, 10);
const errText = (error: unknown) =>
  (error as { stderr?: string }).stderr?.slice(-1500) || String(error);
const BIG = { maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 };
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// ---------------------------------------------------------------------------------------------
// Project brief: "## Project brief" section with an append-only "### Decisions" log.
// ---------------------------------------------------------------------------------------------
const BRIEF_HEADING = "## Project brief";
const DECISIONS_HEADING = "### Decisions";
const SECTION_MAX = 6000;
const BRIEF_MAX = 4000;

/** CLAUDE.md is what Claude Code loads; fall back to AGENTS.md (the app injects its brief). */
function briefFile(): string {
  const claude = join(project(), "CLAUDE.md");
  return existsSync(claude) ? claude : join(project(), "AGENTS.md");
}

/** [start, end) character offsets of the brief section, or undefined. */
function findSection(doc: string): [number, number] | undefined {
  const m = /^## Project brief[ \t]*$/m.exec(doc);
  if (!m) return undefined;
  const after = m.index + m[0].length;
  const next = /^## (?!#)/m.exec(doc.slice(after));
  return [m.index, next ? after + next.index : doc.length];
}

interface Brief {
  body: string;
  decisions: string[];
}
function parseSection(section: string): Brief {
  const inner = section.replace(/^## Project brief[ \t]*\n?/, "");
  const i = inner.search(/^### Decisions[ \t]*$/m);
  const body = (i >= 0 ? inner.slice(0, i) : inner).trim();
  const decisions =
    i >= 0
      ? inner
          .slice(i)
          .split("\n")
          .slice(1)
          .filter((l) => l.trim().startsWith("- "))
      : [];
  return { body, decisions };
}
const renderSection = (b: Brief) =>
  [
    BRIEF_HEADING,
    "",
    b.body || "_(no brief yet)_",
    "",
    DECISIONS_HEADING,
    "",
    ...(b.decisions.length ? b.decisions : ["_(none yet)_"]),
    "",
  ].join("\n");

function writeSection(file: string, doc: string, brief: Brief) {
  const section = renderSection(brief);
  const span = findSection(doc);
  let out: string;
  if (span) out = `${doc.slice(0, span[0])}${section}${doc.slice(span[1]).replace(/^\n*/, "\n")}`;
  else out = doc.trim() ? `${doc.replace(/\s*$/, "")}\n\n${section}` : `${section}`;
  writeFileSync(file, out.replace(/\n*$/, "\n"));
}

/** Keeps the section under SECTION_MAX by moving the oldest decisions to an archive file. */
function archiveOverflow(brief: Brief): number {
  const pointer = /^- _\((\d+) earlier decisions in \.open-herness\/decisions-archive\.md\)_$/;
  const prior = brief.decisions[0] && pointer.exec(brief.decisions[0]);
  const live = prior ? brief.decisions.slice(1) : [...brief.decisions];
  const moved: string[] = [];
  const total = () =>
    renderSection({
      body: brief.body,
      decisions: ["- _(9999 earlier decisions in .open-herness/decisions-archive.md)_", ...live],
    }).length;
  while (total() > SECTION_MAX && live.length > 1) moved.push(live.shift()!);
  if (!moved.length) return 0;
  const file = join(project(), ".open-herness", "decisions-archive.md");
  mkdirSync(dirname(file), { recursive: true });
  const head = existsSync(file)
    ? readFileSync(file, "utf8").replace(/\n*$/, "\n")
    : "# Archived project decisions (oldest first)\n\n";
  writeFileSync(file, `${head}${moved.join("\n")}\n`);
  const archived = (prior ? Number(prior[1]) : 0) + moved.length;
  brief.decisions = [
    `- _(${archived} earlier decisions in .open-herness/decisions-archive.md)_`,
    ...live,
  ];
  return archived;
}

// ---------------------------------------------------------------------------------------------
// Cast cards
// ---------------------------------------------------------------------------------------------
const castDir = (id: string) => cast.castDir(project(), id);
const cardPath = (id: string) => join(castDir(id), "card.json");
const readCard = (id: string) => cast.readCardAt(project(), id);
function settleStatus(card: CastCard) {
  card.status =
    !GATED.has(card.origin) || (card.consent?.confirmed && card.consent.user_quote?.trim())
      ? "ready"
      : "draft";
}
function writeCard(card: CastCard) {
  settleStatus(card);
  card.updated = new Date().toISOString();
  mkdirSync(castDir(card.id), { recursive: true });
  writeFileSync(cardPath(card.id), `${JSON.stringify(card, null, 2)}\n`);
}
function copyRefs(
  card: CastCard,
  refs: { path: string; role: Role; note?: string }[],
): string | undefined {
  const dir = join(castDir(card.id), "refs");
  mkdirSync(dir, { recursive: true });
  for (const r of refs) {
    const src = abs(r.path);
    if (!existsSync(src) || !statSync(src).isFile()) return `Reference not found: ${src}`;
  }
  for (const r of refs) {
    const src = abs(r.path);
    const ext = extname(src).toLowerCase() || ".png";
    let n = card.refs.filter((x) => x.role === r.role).length + 1;
    let dest = join(dir, `${r.role}-${n}${ext}`);
    while (existsSync(dest)) dest = join(dir, `${r.role}-${++n}${ext}`);
    copyFileSync(src, dest);
    card.refs.push({
      path: rel(dest),
      role: r.role,
      source: rel(src),
      ...(r.note ? { note: r.note } : {}),
    });
  }
  return undefined;
}
const draftWarning = (c: CastCard) =>
  c.status === "draft"
    ? `DRAFT (${c.origin}): do NOT use this card's likeness for generation until the user explicitly confirms consent/licence; then cast_update consent=true with user_quote = their own words.\n`
    : "";
const cardLine = (c: CastCard) =>
  `${c.id} | ${c.kind} | ${c.name} | ${c.style} | ${c.origin} | ${c.status} | ${c.refs.length} refs (${[...new Set(c.refs.map((r) => r.role))].join(", ") || "-"})`;
function describeCard(c: CastCard) {
  return [
    draftWarning(c) +
      `Cast card ${c.id}: ${c.name} (${c.kind}, ${c.style}, origin ${c.origin}, status ${c.status}) — ${rel(cardPath(c.id))}`,
    `Description (paste verbatim into prompts): ${c.description}`,
    `Rev: ${c.updated} (use as base_rev in cast_update)`,
    c.consent
      ? `Consent: ${c.consent.confirmed ? "confirmed" : "not confirmed"}${c.consent.user_quote ? ` — user said: "${c.consent.user_quote}" (${c.consent.at ?? ""})` : ""}`
      : "",
    "Refs:",
    ...c.refs.map((r, i) => `  ${i + 1}. [${r.role}] ${r.path}${r.note ? ` — ${r.note}` : ""}`),
  ]
    .filter(Boolean)
    .join("\n");
}

const refInput = z.object({
  path: z
    .string()
    .describe("Image file (project-relative or absolute); copied into ./cast/<id>/refs/"),
  role: z.enum(ROLES),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------------------------
// Brand capture helpers
// ---------------------------------------------------------------------------------------------
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Hosts that only serve openly licensed fonts (Google Fonts, Bunny Fonts, Fontsource). */
const openFontUrl = (u: string) =>
  /^https:\/\/(fonts\.gstatic\.com|fonts\.bunny\.net)\//.test(u) ||
  /^https:\/\/cdn\.jsdelivr\.net\/(npm|gh)\/@?fontsource/.test(u);
const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "inherit",
  "initial",
  "unset",
  "cursive",
  "fantasy",
  "-apple-system",
  "blinkmacsystemfont",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "apple color emoji",
  "segoe ui emoji",
  "segoe ui symbol",
  "noto color emoji",
  "revert",
]);

async function fetchBytes(
  url: string,
  limit: number,
): Promise<{ buf: Buffer; url: string; type: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > limit) throw new Error(`Too large (${len} bytes): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new Error(`Too large (${buf.length} bytes): ${url}`);
  return { buf, url: res.url || url, type: res.headers.get("content-type") ?? "" };
}
const fetchText = async (url: string, limit = 3_000_000) => {
  const r = await fetchBytes(url, limit);
  return { text: r.buf.toString("utf8"), url: r.url };
};
const absUrl = (u: string, base: string) => {
  try {
    const url = new URL(u.trim().replace(/&amp;/g, "&"), base);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};
const attr = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(tag)
    ?.slice(1)
    .find((x) => x !== undefined);
const stripTags = (s: string) =>
  s
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
function toHex(raw: string): { hex: string; alpha: number } | undefined {
  const s = raw.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return undefined;
    return { hex: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,/]+([\d.]+)(%?))?\s*\)$/.exec(
    s,
  );
  if (m) {
    const k = m[2] ? 2.55 : 1;
    const a = m[5] === undefined ? 1 : m[6] ? Number(m[5]) / 100 : Number(m[5]);
    return {
      hex: `#${hex2(Number(m[1]) * k)}${hex2(Number(m[3]) * k)}${hex2(Number(m[4]) * k)}`,
      alpha: a,
    };
  }
  m =
    /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+)(%?))?\s*\)$/.exec(
      s,
    );
  if (m) {
    const h = Number(m[1]) % 360;
    const sat = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const o = l - c / 2;
    const [r, g, b] =
      h < 60
        ? [c, x, 0]
        : h < 120
          ? [x, c, 0]
          : h < 180
            ? [0, c, x]
            : h < 240
              ? [0, x, c]
              : h < 300
                ? [x, 0, c]
                : [c, 0, x];
    const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4]);
    return { hex: `#${hex2((r + o) * 255)}${hex2((g + o) * 255)}${hex2((b + o) * 255)}`, alpha: a };
  }
  return undefined;
}
function chroma(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return { sat: max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1)), light: l };
}
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{5,60}\)|hsla?\([^)]{5,60}\)/g;

interface FontFace {
  family: string;
  weight?: string;
  style?: string;
  urls: string[];
}

async function screenshot(url: string, out: string): Promise<string | undefined> {
  if (!existsSync(CHROME)) return "Google Chrome not installed; no screenshot.";
  const profile = mkdtempSync(join(tmpdir(), "oh-chrome-"));
  try {
    await run(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--mute-audio",
        `--user-data-dir=${profile}`,
        "--window-size=1440,900",
        "--virtual-time-budget=8000",
        `--screenshot=${out}`,
        url,
      ],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return existsSync(out) ? undefined : "Chrome ran but wrote no screenshot.";
  } catch (error) {
    return existsSync(out) ? undefined : `Screenshot failed: ${String(error).slice(0, 300)}`;
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Downscaled JPEG of an image for returning to the agent. */
async function preview(src: string, width: number): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "oh-prev-"));
  try {
    const out = join(dir, "p.jpg");
    await run("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      src,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${width},iw)':-2`,
      "-q:v",
      "4",
      out,
    ]);
    return readFileSync(out).toString("base64");
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Contact sheet of still images (or video frames at times) as a tiled JPEG written to out. */
const sheet = cast.sheet;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) =>
    s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? 0;
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    count: s.length,
    mean: r(mean),
    median: r(q(0.5)),
    min: r(s[0] ?? 0),
    max: r(s.at(-1) ?? 0),
    p10: r(q(0.1)),
    p90: r(q(0.9)),
  };
};

export function registerProjectTools(server: McpServer) {
  // ------------------------------------------------------------------------------- brief
  server.registerTool(
    "project_brief",
    {
      description: `The project's brief and decisions log, kept as a "## Project brief" section (with an append-only "### Decisions" list of dated one-liners) in ./CLAUDE.md if it exists, else ./AGENTS.md (created if missing; the rest of the file is preserved). It is loaded into every new chat and survives compaction, so keep it current. get: read it. set: replace the brief text (goal, audience, deliverables + formats, tone, constraints, deadline, open questions; ≤ ${BRIEF_MAX} chars, markdown bullets; get first and merge) — decisions are kept. decide: append one decision (what was decided and why, e.g. "Hero colour #FF6B2C, user picked take t3 over t2: warmer"). Record a decision whenever the user approves a direction, picks a take or rules something out. The section stays under ~${SECTION_MAX} chars; the oldest decisions move to .open-herness/decisions-archive.md.`,
      inputSchema: {
        action: z.enum(["get", "set", "decide"]),
        text: z.string().optional().describe("set: the full brief text; decide: one decision line"),
      },
    },
    async ({ action, text: body }) => {
      const file = briefFile();
      const doc = existsSync(file) ? readFileSync(file, "utf8") : "";
      const span = findSection(doc);
      const brief = span ? parseSection(doc.slice(span[0], span[1])) : { body: "", decisions: [] };
      if (action === "get") {
        if (!span)
          return text(
            `No project brief yet (would be written to ${rel(file)}). Ask the user for goal, audience, deliverables, tone, constraints and deadline, then project_brief set.`,
          );
        return text(`From ${rel(file)}:\n\n${renderSection(brief)}`);
      }
      if (!body?.trim()) return fail(`'text' is required for ${action}.`);
      if (action === "set") {
        const clean = body
          .replace(/^##+ *Project brief.*$/gim, "")
          .replace(/^### Decisions[\s\S]*$/m, "")
          .replace(/^## /gm, "#### ")
          .trim();
        if (clean.length > BRIEF_MAX)
          return fail(
            `Brief is ${clean.length} chars; keep it under ${BRIEF_MAX} (bullets, no prose). Move detail to a separate file and link it.`,
          );
        brief.body = clean;
      } else {
        const line = body.replace(/\s+/g, " ").replace(/^-\s+/, "").trim();
        if (line.length > 400)
          return fail("A decision is one line (≤ 400 chars): what was decided and why.");
        if (brief.decisions.length === 1 && /^- _\(none yet\)_$/.test(brief.decisions[0]!))
          brief.decisions = [];
        brief.decisions.push(`- ${today()}: ${line}`);
      }
      brief.decisions = brief.decisions.filter((d) => !/^- _\(none yet\)_$/.test(d));
      const archived = archiveOverflow(brief);
      writeSection(file, doc, brief);
      const note = archived
        ? ` Oldest decisions archived (${archived} total in .open-herness/decisions-archive.md).`
        : "";
      return text(
        action === "set"
          ? `Saved the project brief in ${rel(file)} (${brief.body.length} chars, ${brief.decisions.length} decisions kept).${note}`
          : `Logged decision #${brief.decisions.length} in ${rel(file)}: ${brief.decisions.at(-1)}${note}`,
      );
    },
  );

  // ------------------------------------------------------------------------------- cast
  server.registerTool(
    "cast_create",
    {
      description:
        "Create a cast card for a recurring character, location or prop so it looks the same in every shot: ./cast/<id>/card.json with a fixed, reusable description (paste it verbatim into every prompt) and role-tagged reference images copied into ./cast/<id>/refs/ (hero = the canonical look; fullbody, angle, expression, outfit, plate = location/background, style = rendering style). origin: generated (made by us), user-photo (photo the user supplied of themselves/their own thing), real-person (an identifiable real person other than the user, incl. public figures) or licensed (third-party IP/model release). real-person/licensed cards stay status=draft until the user explicitly confirms consent/licence (cast_update consent=true + user_quote); never generate their likeness while draft.",
      inputSchema: {
        id: z.string().describe("Short id, e.g. 'mira' or 'lighthouse'; slugified"),
        kind: z.enum(KINDS),
        name: z.string(),
        description: z
          .string()
          .describe(
            "Fixed visual description: age/build/face/hair/skin/wardrobe/colours/materials/distinguishing marks; 40-120 words, no scene or action",
          ),
        style: z.enum(["photoreal", "stylized"]),
        refs: z.array(refInput).optional(),
        origin: z.enum(ORIGINS),
        consent: z.boolean().optional(),
        user_quote: z
          .string()
          .optional()
          .describe(
            "Required with consent=true for real-person/licensed: the user's own words confirming it",
          ),
      },
    },
    async ({ id, kind, name, description, style, refs = [], origin, consent, user_quote }) => {
      const cid = slug(id);
      if (!cid) return fail("Invalid id.");
      if (readCard(cid))
        return fail(
          coded(
            "CONFLICT",
            `Cast card '${cid}' already exists.`,
            "Use cast_update (with base_rev from cast_show), or pick another id.",
          ),
        );
      if (consent && GATED.has(origin) && !user_quote?.trim())
        return fail(
          "consent=true for a real-person/licensed card needs user_quote: the user's own words confirming consent. Ask the user first.",
        );
      const now = new Date().toISOString();
      const card: CastCard = {
        id: cid,
        kind,
        name,
        description: description.trim(),
        style,
        origin,
        status: "draft",
        refs: [],
        created: now,
        updated: now,
      };
      if (consent !== undefined)
        card.consent = {
          confirmed: consent,
          ...(user_quote?.trim() ? { user_quote: user_quote.trim(), at: now } : {}),
        };
      const err = copyRefs(card, refs);
      if (err) return fail(err);
      writeCard(card);
      const tip = card.refs.some((r) => r.role === "hero")
        ? ""
        : "\nTip: add a 'hero' ref (the canonical look) before generating with it.";
      return text(`Created.\n${describeCard(card)}${tip}`);
    },
  );

  server.registerTool(
    "cast_list",
    {
      description:
        "List all cast cards in ./cast/ (id | kind | name | style | origin | status | refs).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const dir = join(project(), "cast");
      const cards = existsSync(dir)
        ? readdirSync(dir)
            .map((d) => readCard(d))
            .filter((c): c is CastCard => !!c)
        : [];
      if (!cards.length)
        return text(
          "No cast cards yet (./cast/). Create one with cast_create for any character, location or prop that recurs across shots.",
        );
      return text([`${cards.length} cast cards:`, ...cards.map(cardLine)].join("\n"));
    },
  );

  server.registerTool(
    "cast_show",
    {
      description:
        "Show a cast card: description to paste into prompts, refs with roles and paths, consent status, and its rev (pass as base_rev to cast_update to detect concurrent edits).",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const card = readCard(slug(id));
      return card
        ? text(describeCard(card))
        : fail(coded("NOT_FOUND", `No cast card '${id}'.`, "Use cast_list."));
    },
  );

  server.registerTool(
    "cast_update",
    {
      description:
        "Update a cast card: change name/description/style/kind/origin, add refs (copied in, never overwritten), remove refs by number from cast_show, or record consent. consent=true on a real-person/licensed card requires user_quote = the user's own words confirming consent/licence (quote them exactly; never infer consent). consent=false puts the card back to draft.",
      inputSchema: {
        id: z.string(),
        kind: z.enum(KINDS).optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        style: z.enum(["photoreal", "stylized"]).optional(),
        origin: z.enum(ORIGINS).optional(),
        add_refs: z.array(refInput).optional(),
        remove_refs: z
          .array(z.number().int().min(1))
          .optional()
          .describe("Ref numbers from cast_show"),
        consent: z.boolean().optional(),
        user_quote: z.string().optional(),
        base_rev: z
          .string()
          .optional()
          .describe(
            "rev from cast_show/cast_update; refused as STALE_REV if the card changed since",
          ),
      },
    },
    async ({
      id,
      kind,
      name,
      description,
      style,
      origin,
      add_refs,
      remove_refs,
      consent,
      user_quote,
      base_rev,
    }) => {
      const card = readCard(slug(id));
      if (!card) return fail(coded("NOT_FOUND", `No cast card '${id}'.`, "Use cast_list."));
      if (base_rev && base_rev !== card.updated)
        return fail(
          coded(
            "STALE_REV",
            `Card '${card.id}' changed since rev ${base_rev} (now ${card.updated}).`,
            "Re-read it with cast_show, merge your change and resend with the new base_rev.",
          ),
        );
      const nextOrigin = origin ?? card.origin;
      if (consent && GATED.has(nextOrigin) && !user_quote?.trim())
        return fail(
          coded(
            "CONSENT_REQUIRED",
            "consent=true needs user_quote: the user's own words confirming consent/licence.",
            "Ask the user and quote their reply exactly; never infer consent.",
          ),
        );
      const was = card.status;
      if (kind) card.kind = kind;
      if (name) card.name = name;
      if (description) card.description = description.trim();
      if (style) card.style = style;
      if (origin && origin !== card.origin) {
        card.origin = origin;
        if (GATED.has(origin) && consent === undefined) card.consent = { confirmed: false };
      }
      if (consent !== undefined)
        card.consent = {
          confirmed: consent,
          ...(consent && user_quote?.trim()
            ? { user_quote: user_quote.trim(), at: new Date().toISOString() }
            : {}),
        };
      if (remove_refs?.length) {
        const drop = new Set(remove_refs.map((n) => n - 1));
        for (const i of drop)
          if (!card.refs[i]) return fail(`No ref #${i + 1}; card has ${card.refs.length}.`);
        card.refs = card.refs.filter((_, i) => !drop.has(i));
      }
      if (add_refs?.length) {
        const err = copyRefs(card, add_refs);
        if (err) return fail(err);
      }
      writeCard(card);
      const change = was !== card.status ? `Status ${was} -> ${card.status}.\n` : "";
      return text(`Updated.\n${change}${describeCard(card)}`);
    },
  );

  server.registerTool(
    "cast_check",
    {
      description:
        "Likeness check of a new image against a cast card (identity refs). Without score: an independent VLM judge (fal openrouter/router/vision, default anthropic/claude-sonnet-4.5, override OH_LIKENESS_MODEL; ~$0.02 for 2 calls at temperature 0, third call + median if they differ > 0.2; per-aspect scores; video = 3 sampled frames) scores it, counted in the spend ledger, logged to checks.jsonl; optional local face cosine for real people if OH_FACE_EMBED_MODEL + OH_FACE_DETECT_MODEL are set. With no fal key (or OH_LIKENESS_JUDGE=off) or on judge failure: a contact sheet + rubric marked UNSCORED to score yourself. With score (0-1; >10 read as /100, >1 as /10) + reason: logs {verdict, score, reason} to ./cast/<id>/checks.jsonl; match >= 0.75, drift <= 0.45, else unsure (use too_small_to_judge for a subject too small/hidden). On drift: regenerate from the card (media_generate cast:[id]), at most 2 retake rounds, and report honestly.",
      inputSchema: {
        id: z.string(),
        image: z.string().describe("Candidate image (project-relative or absolute)"),
        score: z.number().optional(),
        reason: z.string().optional(),
        too_small_to_judge: z.boolean().optional(),
        job_id: z.string().optional(),
      },
    },
    async ({ id, image, score, reason, too_small_to_judge, job_id }) => {
      const card = readCard(slug(id));
      if (!card) return fail(coded("NOT_FOUND", `No cast card '${id}'.`, "Use cast_list."));
      if (!cast.consented(card))
        return fail(
          coded(
            "CONSENT_REQUIRED",
            `Card '${card.id}' is a draft without confirmed consent/licence.`,
            "Get the user's explicit consent first (cast_update consent=true + user_quote).",
          ),
        );
      const src = abs(image);
      if (!existsSync(src)) return fail(coded("NOT_FOUND", `Image not found: ${src}`));
      if (score === undefined) {
        if (likeness.judgeEnabled()) {
          try {
            const isVideo = /\.(mp4|mov|webm|m4v|mkv)$/i.test(src);
            const judged = isVideo
              ? await likeness.judgeVideo(project(), card, src)
              : { judged: await likeness.judgeImage(project(), card, src), frames: [] };
            likeness.logJudged(project(), card, src, rel(src), judged.judged, job_id);
            return text(
              `${likeness.judgedText(card, src, judged.judged)}${judged.frames.length ? `\nFrames: ${judged.frames.map((f) => `${f.t}s=${f.overall}`).join(", ")}` : ""}`,
            );
          } catch (error) {
            const brief = await cast.likenessBrief(project(), card, src);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `VLM judge unavailable (${String(error).slice(0, 200)}); falling back to manual scoring.\n${brief.text}`,
                },
                ...(brief.sheetPath
                  ? [
                      {
                        type: "image" as const,
                        data: readFileSync(brief.sheetPath).toString("base64"),
                        mimeType: "image/jpeg",
                      },
                    ]
                  : []),
              ],
            };
          }
        }
        const brief = await cast.likenessBrief(project(), card, src);
        return {
          content: [
            { type: "text" as const, text: brief.text },
            ...(brief.sheetPath
              ? [
                  {
                    type: "image" as const,
                    data: readFileSync(brief.sheetPath).toString("base64"),
                    mimeType: "image/jpeg",
                  },
                ]
              : []),
          ],
        };
      }
      if (!Number.isFinite(score) || score < 0)
        return fail(coded("INVALID_INPUT", "score must be a non-negative number."));
      if (!reason?.trim())
        return fail(
          coded(
            "INVALID_INPUT",
            "A one-line reason is required with a score.",
            "Name the features that match or drifted.",
          ),
        );
      const normalised = cast.normaliseScore(score);
      const verdict = too_small_to_judge ? "unsure" : cast.verdictOf(normalised);
      cast.appendCheck(project(), card.id, {
        at: new Date().toISOString(),
        image: rel(src),
        score: normalised,
        verdict,
        reason: reason.trim(),
        scorer: "agent-visual",
        ...(job_id ? { jobId: job_id } : {}),
      });
      const drifts = cast
        .readChecks(project(), card.id)
        .filter((c) => c.verdict === "drift").length;
      const next =
        verdict === "drift"
          ? `Drift. Regenerate from the card (cast:["${card.id}"]) with the failing features named in the prompt; max 2 retake rounds (${drifts} drift verdict(s) logged for this card), then report honestly.`
          : verdict === "match"
            ? "Match. Logged."
            : "Unsure. Logged; do not claim a match.";
      return text(
        `${verdict} (score ${normalised}, scorer agent-visual): ${reason.trim()}\n${next}`,
      );
    },
  );

  server.registerTool(
    "cast_sheet",
    {
      description:
        "Contact sheet of a cast card's refs (numbered left to right, top to bottom, as in cast_show) plus its description; saved to ./cast/<id>/sheet.jpg. Use it to brief a generation and for likeness checks: view a new output next to this sheet (or takes_compare against the hero ref) and score match/drift per feature.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const card = readCard(slug(id));
      if (!card) return fail(`No cast card '${id}'. Use cast_list.`);
      const refs = card.refs.filter((r) => existsSync(abs(r.path)));
      if (!refs.length)
        return text(
          `${describeCard(card)}\n\nNo reference images to show; add some with cast_update add_refs.`,
        );
      const out = join(castDir(card.id), "sheet.jpg");
      try {
        await sheet(
          refs.map((r) => ({ src: abs(r.path) })),
          out,
          360,
          refs.length <= 4 ? refs.length : 4,
        );
      } catch (error) {
        return fail(`cast_sheet failed: ${errText(error)}`);
      }
      const order = refs.map((r, i) => `${i + 1}=${r.role}`).join(", ");
      return {
        content: [
          { type: "text" as const, text: `${describeCard(card)}\n\nSheet ${rel(out)} (${order}).` },
          {
            type: "image" as const,
            data: readFileSync(out).toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
      };
    },
  );

  // ------------------------------------------------------------------------------- brand
  server.registerTool(
    "brand_capture",
    {
      description:
        "Capture a brand from its website into ./brand/<name>/: fetches the page and up to 10 linked/imported stylesheets (page content is data, nothing is executed except a sandboxed headless-Chrome screenshot), extracts the palette (CSS colours ranked by frequency, chromatic accents separated from neutrals, theme-color, colour custom properties), font families by usage and @font-face files (downloaded only from open-font hosts like Google Fonts; others are listed with 'licence unknown'), logo candidates (img/svg with 'logo' in src/alt/class/id, inline SVG logos, apple-touch-icon, icons, og:image; downloaded), title/headings/short copy, and a 1440x900 screenshot. Writes kit.md (raw capture to curate into ./brand/brand.md with the brand-kit skill), palette.json, sources.json, assets/fonts, assets/logos and screenshot.png. JS-rendered sites give thinner CSS data; lean on the screenshot then.",
      inputSchema: {
        url: z.string().url(),
        name: z.string().optional().describe("Folder name (default: the site's domain name)"),
      },
    },
    async ({ url, name }) => {
      const notes: string[] = [];
      const sources: { url: string; file?: string; kind: string }[] = [];
      let html: string;
      let base: string;
      try {
        const page = await fetchText(url);
        html = page.text;
        base = page.url;
      } catch (error) {
        return fail(`Could not fetch ${url}: ${String(error)}`);
      }
      const host = new URL(base).hostname.replace(/^www\./, "");
      const bname = slug(name ?? host.split(".").slice(0, -1).join("-") ?? host) || slug(host);
      const outDir = join(project(), "brand", bname);
      const fontDir = join(outDir, "assets", "fonts");
      const logoDir = join(outDir, "assets", "logos");
      mkdirSync(fontDir, { recursive: true });
      mkdirSync(logoDir, { recursive: true });
      sources.push({ url: base, kind: "page" });

      // Stylesheets: inline <style>, style="", linked sheets and @import (max 10 fetched).
      const css: { text: string; base: string }[] = [];
      for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
        css.push({ text: m[1]!, base });
      const inlineStyles = [...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)]
        .map((m) => m[1]!)
        .join(";\n");
      css.push({ text: inlineStyles, base });
      const queue: string[] = [];
      for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        if (
          /stylesheet/i.test(attr(tag, "rel") ?? "") ||
          /\.css(\?|$)/i.test(attr(tag, "href") ?? "")
        ) {
          const href = absUrl(attr(tag, "href") ?? "", base);
          if (href && !queue.includes(href)) queue.push(href);
        }
      }
      const imports = (t: string, b: string) =>
        [...t.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)]
          .map((m) => absUrl(m[1]!, b))
          .filter((u): u is string => !!u);
      for (const c of css)
        for (const u of imports(c.text, c.base)) if (!queue.includes(u)) queue.push(u);
      let fetched = 0;
      for (let i = 0; i < queue.length && fetched < 10; i++) {
        try {
          const r = await fetchText(queue[i]!, 2_000_000);
          fetched++;
          css.push({ text: r.text, base: r.url });
          sources.push({ url: r.url, kind: "stylesheet" });
          for (const u of imports(r.text, r.url)) if (!queue.includes(u)) queue.push(u);
        } catch (error) {
          notes.push(`Stylesheet skipped: ${queue[i]} (${String(error).slice(0, 120)})`);
        }
      }
      if (queue.length > 10)
        notes.push(`${queue.length - 10} more stylesheets not fetched (limit 10).`);

      // Palette.
      const counts = new Map<string, number>();
      const vars: Record<string, string> = {};
      for (const c of css) {
        const body = c.text.replace(/\/\*[\s\S]*?\*\//g, "");
        for (const m of body.matchAll(COLOR_RE)) {
          const col = toHex(m[0]);
          if (col && col.alpha >= 0.15) counts.set(col.hex, (counts.get(col.hex) ?? 0) + 1);
        }
        for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
          const col = toHex(m[2]!.trim());
          if (col && Object.keys(vars).length < 60 && !(m[1]! in vars))
            vars[m[1]!] = col.alpha < 1 ? `${col.hex} @${col.alpha.toFixed(2)}` : col.hex;
        }
      }
      const themeTags = (html.match(/<meta\b[^>]*>/gi) ?? []).filter((t) =>
        /theme-color|msapplication-TileColor/i.test(attr(t, "name") ?? ""),
      );
      const themeColor = themeTags.map((t) => toHex(attr(t, "content") ?? "")?.hex).find(Boolean);
      const ranked = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([hex, count]) => ({ hex, count, ...chroma(hex) }));
      const chromatic = ranked
        .filter((c) => c.sat >= 0.25 && c.light > 0.15 && c.light < 0.95)
        .slice(0, 12);
      const neutrals = ranked
        .filter((c) => !(c.sat >= 0.25 && c.light > 0.15 && c.light < 0.95))
        .slice(0, 10);

      // Fonts.
      const familyCount = new Map<string, number>();
      const faces: FontFace[] = [];
      for (const c of css) {
        for (const m of c.text.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
          const first = m[1]!
            .split(",")
            .map((f) =>
              f
                .trim()
                .replace(/^['"]|['"]$/g, "")
                .replace(/\s*!important$/, ""),
            )
            .find(
              (f) =>
                f && !GENERIC_FONTS.has(f.toLowerCase()) && !/[()"'{}]|^var\b|\bFallback$/i.test(f),
            );
          if (first) familyCount.set(first, (familyCount.get(first) ?? 0) + 1);
        }
        for (const m of c.text.matchAll(/@font-face\s*{([^}]*)}/gi)) {
          const block = m[1]!;
          const family = /font-family\s*:\s*['"]?([^;'"]+)/i.exec(block)?.[1]?.trim();
          if (!family) continue;
          const urls = [...block.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)]
            .map((u) => absUrl(u[1]!, c.base))
            .filter((u): u is string => !!u && !u.startsWith("data:"));
          // Basic-Latin subsets first, so a split family (Google Fonts) keeps its Latin file per weight.
          const latin =
            /unicode-range\s*:[^;]*U\+0000/i.test(block) || !/unicode-range/i.test(block);
          faces[latin ? "unshift" : "push"]({
            family,
            weight: /font-weight\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim(),
            style: /font-style\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim(),
            urls,
          });
        }
      }
      const families = [...familyCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const fontFiles: {
        family: string;
        weight?: string;
        style?: string;
        url: string;
        file?: string;
        status: string;
      }[] = [];
      const seenFamilyWeight = new Set<string>();
      for (const f of faces) {
        const pick =
          f.urls.find((u) => /\.woff2(\?|$)/i.test(u)) ??
          f.urls.find((u) => /\.(ttf|otf)(\?|$)/i.test(u)) ??
          f.urls[0];
        if (!pick) continue;
        const key = `${f.family}|${f.weight ?? ""}|${f.style ?? ""}`;
        if (seenFamilyWeight.has(key)) continue;
        seenFamilyWeight.add(key);
        const open = openFontUrl(pick);
        const entry: (typeof fontFiles)[number] = {
          family: f.family,
          weight: f.weight,
          style: f.style,
          url: pick,
          status: open
            ? "downloaded (open-font host)"
            : "not downloaded: licence unknown (download only if the user owns/licenses it)",
        };
        const same = fontFiles.find((x) => x.url === pick && x.file);
        if (same) entry.file = same.file;
        else if (open && fontFiles.filter((x) => x.file).length < 16) {
          try {
            const r = await fetchBytes(pick, 5_000_000);
            const ext = (/\.(woff2|woff|ttf|otf)(\?|$)/i.exec(pick)?.[1] ?? "woff2").toLowerCase();
            const file = join(
              fontDir,
              `${slug(f.family)}-${slug(f.weight ?? "400") || "400"}${f.style && f.style !== "normal" ? `-${slug(f.style)}` : ""}.${ext}`,
            );
            writeFileSync(file, r.buf);
            entry.file = rel(file);
            sources.push({ url: pick, file: rel(file), kind: "font" });
          } catch (error) {
            entry.status = `download failed: ${String(error).slice(0, 100)}`;
          }
        }
        fontFiles.push(entry);
      }

      // Logos and icons.
      const logoUrls: { url: string; why: string }[] = [];
      const addLogo = (u: string | undefined, why: string) => {
        const a = u && absUrl(u, base);
        if (a && !logoUrls.some((l) => l.url === a)) logoUrls.push({ url: a, why });
      };
      for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
        const hay = `${attr(tag, "src") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""}`;
        if (/logo|brand/i.test(hay))
          addLogo(
            attr(tag, "src") ?? attr(tag, "data-src"),
            `img (${(attr(tag, "alt") ?? "").slice(0, 40) || "logo in name/class"})`,
          );
      }
      for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        const relv = (attr(tag, "rel") ?? "").toLowerCase();
        if (/apple-touch-icon|mask-icon|\bicon\b/.test(relv)) addLogo(attr(tag, "href"), relv);
      }
      for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        if (/^(og:image|twitter:image)$/i.test(attr(tag, "property") ?? attr(tag, "name") ?? ""))
          addLogo(attr(tag, "content"), "og:image (share image; may contain the logo)");
      }
      const logos: { url?: string; why: string; file?: string; bytes?: number }[] = [];
      for (const l of logoUrls.slice(0, 10)) {
        try {
          const r = await fetchBytes(l.url, 5_000_000);
          const ext = (
            /\.(svg|png|jpe?g|webp|gif|ico|avif)(\?|$)/i.exec(l.url)?.[1] ??
            (/svg/.test(r.type)
              ? "svg"
              : /png/.test(r.type)
                ? "png"
                : /jpe?g/.test(r.type)
                  ? "jpg"
                  : /webp/.test(r.type)
                    ? "webp"
                    : /icon/.test(r.type)
                      ? "ico"
                      : "bin")
          ).toLowerCase();
          const stem =
            slug(basename(new URL(l.url).pathname, extname(new URL(l.url).pathname))) || "logo";
          let file = join(logoDir, `${stem}.${ext}`);
          for (let n = 2; existsSync(file); n++) file = join(logoDir, `${stem}-${n}.${ext}`);
          writeFileSync(file, r.buf);
          logos.push({ url: l.url, why: l.why, file: rel(file), bytes: r.buf.length });
          sources.push({ url: l.url, file: rel(file), kind: "logo" });
        } catch (error) {
          logos.push({
            url: l.url,
            why: `${l.why}; download failed: ${String(error).slice(0, 80)}`,
          });
        }
      }
      let inlineSvg = 0;
      for (const m of html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
        const open = /<svg\b[^>]*>/i.exec(m[0])![0];
        const before = html.slice(Math.max(0, m.index - 300), m.index);
        const inHomeLink =
          /<a\b[^>]*(?:(?:class|id|aria-label)="[^"]*(?:logo|brand|home)[^"]*"|href="(?:\/|\.\/|https?:\/\/[^"\/]+\/?)")[^>]*>(?:\s*<(?!\/a\b)[^>]+>)*\s*$/i.test(
            before,
          );
        if (!/logo|brand/i.test(open) && !inHomeLink) continue;
        if (m[0].length > 200_000 || inlineSvg >= 3) continue;
        const svg = /xmlns=/.test(open)
          ? m[0]
          : m[0].replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        const file = join(logoDir, `inline-logo-${++inlineSvg}.svg`);
        writeFileSync(file, svg);
        logos.push({ why: "inline <svg> in a logo/home link", file: rel(file), bytes: svg.length });
      }

      // Copy.
      const metaContent = (key: string) => {
        const tag = (html.match(/<meta\b[^>]*>/gi) ?? []).find(
          (t) => (attr(t, "name") ?? attr(t, "property") ?? "").toLowerCase() === key,
        );
        return tag ? stripTags(attr(tag, "content") ?? "") : undefined;
      };
      const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
      const description = metaContent("description") ?? metaContent("og:description");
      const siteName = metaContent("og:site_name");
      const headings = [...html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)]
        .map((m) => `${m[1]!.toUpperCase()}: ${stripTags(m[2]!)}`)
        .filter((h) => h.length > 5 && h.length < 200);
      const uniqHeadings = [...new Set(headings)].slice(0, 15);
      const paras = [
        ...new Set(
          [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
            .map((m) => stripTags(m[1]!))
            .filter((p) => p.length >= 30 && p.length <= 240),
        ),
      ].slice(0, 6);

      // Screenshot.
      const shot = join(outDir, "screenshot.png");
      const shotErr = await screenshot(base, shot);
      if (shotErr) notes.push(shotErr);
      else sources.push({ url: base, file: rel(shot), kind: "screenshot" });
      const shotPrev = shotErr ? undefined : await preview(shot, 1024);

      // Write.
      const palette = {
        source: base,
        captured: new Date().toISOString(),
        theme_color: themeColor ?? null,
        chromatic: chromatic.map(({ hex, count }) => ({ hex, count })),
        neutrals: neutrals.map(({ hex, count }) => ({ hex, count })),
        ranked: ranked.slice(0, 40).map(({ hex, count }) => ({ hex, count })),
        css_variables: vars,
      };
      writeFileSync(join(outDir, "palette.json"), `${JSON.stringify(palette, null, 2)}\n`);
      writeFileSync(
        join(outDir, "sources.json"),
        `${JSON.stringify({ captured: palette.captured, note: "Third-party material; use for the user's own/client brand work only.", sources }, null, 2)}\n`,
      );
      const kit = [
        `# ${siteName || title || host} — brand capture`,
        `Source: ${base} · captured ${today()} · raw extraction, curate into ./brand/brand.md (brand-kit skill)`,
        "",
        "## Palette",
        `- theme-color: ${themeColor ?? "none"}`,
        `- Chromatic (likely accents, by CSS frequency): ${chromatic.map((c) => `${c.hex} (${c.count})`).join(", ") || "none found"}`,
        `- Neutrals: ${neutrals.map((c) => `${c.hex} (${c.count})`).join(", ") || "none found"}`,
        Object.keys(vars).length
          ? `- Colour variables: ${Object.entries(vars)
              .slice(0, 20)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`
          : "",
        "- CSS frequency over-weights framework greys; confirm accents against the screenshot.",
        "",
        "## Typography",
        ...(families.length
          ? families.map(([f, n]) => `- ${f} (${n} rules)`)
          : ["- no font-family declarations found"]),
        ...(fontFiles.length
          ? [
              "",
              "Font files:",
              ...fontFiles.map(
                (f) =>
                  `- ${f.family} ${f.weight ?? ""} ${f.style ?? ""}: ${f.file ?? f.url} — ${f.status}`,
              ),
            ]
          : []),
        "",
        "## Logos and icons",
        ...(logos.length
          ? logos.map(
              (l) =>
                `- ${l.file ?? l.url} — ${l.why}${l.bytes ? ` (${Math.round(l.bytes / 1024)} KB)` : ""}`,
            )
          : ["- none found; look at the screenshot and ask the user for logo files"]),
        "",
        "## Copy",
        `- Title: ${title || "-"}`,
        `- Description: ${description || "-"}`,
        ...uniqHeadings.map((h) => `- ${h}`),
        ...paras.map((p) => `- P: ${p}`),
        "",
        "## Files",
        `- Screenshot: ${shotErr ? `none (${shotErr})` : rel(shot)}`,
        "- palette.json, sources.json, assets/fonts/, assets/logos/",
        ...(notes.length ? ["", "## Notes", ...notes.map((n) => `- ${n}`)] : []),
        "",
      ]
        .filter((l) => l !== "")
        .join("\n")
        .replace(/\n(## )/g, "\n\n$1");
      writeFileSync(join(outDir, "kit.md"), `${kit}\n`);
      const summary = `Captured ${base} into ${rel(outDir)}/ (${fetched} stylesheets, ${counts.size} colours, ${families.length} font families, ${fontFiles.filter((f) => f.file).length} font files, ${logos.filter((l) => l.file).length} logo/icon files${shotErr ? ", no screenshot" : ", screenshot"}).\n\n${kit}`;
      const content: Content[] = [{ type: "text", text: summary }];
      if (shotPrev) content.push({ type: "image", data: shotPrev, mimeType: "image/jpeg" });
      return { content };
    },
  );

  server.registerTool(
    "brand_motion",
    {
      description:
        "Measure a brand's editing rhythm from one of its videos (local file, or an http(s) URL downloaded with yt-dlp at ≤720p): scene-cut detection (ffmpeg scdet) -> cut count, cuts per minute, shot-length stats (mean/median/min/max/p10/p90), average brightness and saturation (0-100), per-shot table; writes ./brand/<name>/motion.json and returns a contact sheet of up to 12 shots. Use it to match pacing when making videos in that brand's style.",
      inputSchema: {
        video: z.string(),
        name: z
          .string()
          .optional()
          .describe(
            "Brand folder under ./brand/ (default: the only existing one, else the video's file name)",
          ),
        threshold: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("scdet cut threshold 0-100 (default 10; lower finds softer cuts)"),
      },
    },
    async ({ video, name, threshold = 10 }) => {
      let src = abs(video);
      const brandRoot = join(project(), "brand");
      const existing = existsSync(brandRoot)
        ? readdirSync(brandRoot).filter((d) => statSync(join(brandRoot, d)).isDirectory())
        : [];
      const bname =
        slug(name ?? (existing.length === 1 ? existing[0]! : basename(video, extname(video)))) ||
        "brand";
      const outDir = join(brandRoot, bname);
      mkdirSync(outDir, { recursive: true });
      try {
        if (/^https?:\/\//i.test(video)) {
          const dl = join(outDir, "motion-source");
          mkdirSync(dl, { recursive: true });
          await run(
            "yt-dlp",
            [
              "--no-playlist",
              "-f",
              "bv*[height<=720]+ba/b[height<=720]/b",
              "--merge-output-format",
              "mp4",
              "-o",
              join(dl, "%(id)s.%(ext)s"),
              video,
            ],
            BIG,
          );
          const files = readdirSync(dl).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));
          if (!files.length) return fail("yt-dlp produced no video file.");
          src = join(
            dl,
            files.sort((a, b) => statSync(join(dl, b)).mtimeMs - statSync(join(dl, a)).mtimeMs)[0]!,
          );
        }
        if (!existsSync(src)) return fail(`File not found: ${src}`);
        const { stdout } = await run("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "format=duration:stream=avg_frame_rate,width,height",
          "-of",
          "json",
          src,
        ]);
        const info = JSON.parse(stdout) as {
          format?: { duration?: string };
          streams?: { avg_frame_rate?: string; width?: number; height?: number }[];
        };
        const duration = Number(info.format?.duration) || 0;
        if (!info.streams?.length || !duration) return fail("No video stream / duration found.");
        const dir = mkdtempSync(join(tmpdir(), "oh-motion-"));
        let frames: { t: number; y: number; s: number; cut: boolean }[] = [];
        try {
          const meta = join(dir, "m.txt");
          await run(
            "ffmpeg",
            [
              "-hide_banner",
              "-nostats",
              "-v",
              "error",
              "-i",
              src,
              "-an",
              "-vf",
              `scale=320:-2,format=yuv444p,signalstats,format=gbrp,scdet=threshold=${threshold},metadata=mode=print:file=${meta}`,
              "-f",
              "null",
              "-",
            ],
            BIG,
          );
          let cur: { t: number; y: number; s: number; cut: boolean } | undefined;
          for (const line of readFileSync(meta, "utf8").split("\n")) {
            const fm = /pts_time:([\d.eE+-]+)/.exec(line);
            if (line.startsWith("frame:") && fm) {
              cur = { t: Number(fm[1]), y: 0, s: 0, cut: false };
              frames.push(cur);
            } else if (cur) {
              if (line.startsWith("lavfi.signalstats.YAVG=")) cur.y = Number(line.split("=")[1]);
              else if (line.startsWith("lavfi.signalstats.SATAVG="))
                cur.s = Number(line.split("=")[1]);
              else if (line.startsWith("lavfi.scd.time=")) cur.cut = true;
            }
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
        frames = frames.filter((f) => Number.isFinite(f.t));
        const cuts = frames
          .filter((f) => f.cut && f.t > 0.05 && f.t < duration - 0.05)
          .map((f) => f.t);
        const bounds = [0, ...cuts, duration];
        const shots = bounds.slice(1).map((end, i) => {
          const start = bounds[i]!;
          const inShot = frames.filter((f) => f.t >= start && f.t < end);
          const avg = (k: "y" | "s") => inShot.reduce((a, f) => a + f[k], 0) / (inShot.length || 1);
          return {
            start: Math.round(start * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
            length: Math.round((end - start) * 1000) / 1000,
            brightness: Math.round((avg("y") / 255) * 1000) / 10,
            saturation: Math.round((avg("s") / 181) * 1000) / 10,
          };
        });
        const meanY = frames.reduce((a, f) => a + f.y, 0) / (frames.length || 1);
        const meanS = frames.reduce((a, f) => a + f.s, 0) / (frames.length || 1);
        const lengths = stats(shots.map((s) => s.length));
        const perMin = Math.round((cuts.length / duration) * 60 * 10) / 10;
        const pace =
          lengths.median < 1
            ? "very fast (music-video / promo cutting)"
            : lengths.median < 2.5
              ? "fast (trailer / social ad)"
              : lengths.median < 5
                ? "moderate (commercial / explainer)"
                : "slow (documentary / brand film, long takes)";
        const result = {
          source: rel(src),
          analysed: new Date().toISOString(),
          threshold,
          duration: Math.round(duration * 1000) / 1000,
          cuts: cuts.length,
          cuts_per_minute: perMin,
          shot_length_seconds: lengths,
          pace,
          brightness_avg: Math.round((meanY / 255) * 1000) / 10,
          saturation_avg: Math.round((meanS / 181) * 1000) / 10,
          shots,
        };
        const outJson = join(outDir, "motion.json");
        writeFileSync(outJson, `${JSON.stringify(result, null, 2)}\n`);
        const pickShots =
          shots.length <= 12
            ? shots
            : Array.from({ length: 12 }, (_, i) => shots[Math.floor((i * shots.length) / 12)]!);
        const sheetOut = join(outDir, "motion-sheet.jpg");
        let sheetData: string | undefined;
        try {
          await sheet(
            pickShots.map((s) => ({ src, t: Math.min(duration - 0.05, (s.start + s.end) / 2) })),
            sheetOut,
            320,
            4,
          );
          sheetData = readFileSync(sheetOut).toString("base64");
        } catch {
          // the contact sheet is optional
        }
        const lines = [
          `brand_motion ${rel(src)} -> ${rel(outJson)}`,
          `Duration ${result.duration}s, ${cuts.length} cuts (${perMin}/min), ${shots.length} shots. Pace: ${pace}.`,
          `Shot length s: mean ${lengths.mean}, median ${lengths.median}, min ${lengths.min}, max ${lengths.max}, p10 ${lengths.p10}, p90 ${lengths.p90}.`,
          `Average brightness ${result.brightness_avg}/100, saturation ${result.saturation_avg}/100.`,
          `Shots: ${shots
            .slice(0, 30)
            .map((s, i) => `${i + 1}) ${s.start}-${s.end}s`)
            .join(", ")}${shots.length > 30 ? " …" : ""}`,
          sheetData
            ? `Contact sheet ${rel(sheetOut)}: mid-frames of ${pickShots.length === shots.length ? "every shot" : "12 evenly spread shots"}.`
            : "",
        ].filter(Boolean);
        const content: Content[] = [{ type: "text", text: lines.join("\n") }];
        if (sheetData) content.push({ type: "image", data: sheetData, mimeType: "image/jpeg" });
        return { content };
      } catch (error) {
        return fail(`brand_motion failed: ${errText(error)}`);
      }
    },
  );
}

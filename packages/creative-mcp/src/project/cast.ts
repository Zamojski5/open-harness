// Cast cards as data: read/validate for generation (description + role-tagged refs, consent gate),
// likeness-check sheet/rubric/ledger. Used by project/tools.ts (cards, cast_check) and media/tools.ts
// (the `cast` argument of media_generate/media_estimate).

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const KINDS = ["character", "location", "prop"] as const;
export const ROLES = [
  "hero",
  "fullbody",
  "angle",
  "expression",
  "outfit",
  "plate",
  "style",
] as const;
export const ORIGINS = ["generated", "user-photo", "real-person", "licensed"] as const;
export const GATED = new Set<string>(["real-person", "licensed"]);
export type Role = (typeof ROLES)[number];

export interface CastRef {
  path: string;
  role: Role;
  source: string;
  note?: string;
}
export interface CastCard {
  id: string;
  kind: (typeof KINDS)[number];
  name: string;
  description: string;
  style: "photoreal" | "stylized";
  origin: (typeof ORIGINS)[number];
  status: "draft" | "ready";
  consent?: { confirmed: boolean; user_quote?: string; at?: string };
  refs: CastRef[];
  created: string;
  updated: string;
}

/** Shared tool error codes (envelope: "CODE: message" + one-line remedy). */
export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_REV"
  | "CONSENT_REQUIRED"
  | "COLLECTION_FAILED"
  | "CONFIRM_REQUIRED";
export const coded = (code: ErrorCode, message: string, remedy?: string) =>
  `${code}: ${message}${remedy ? `\nremedy: ${remedy}` : ""}`;

export const castDir = (projectPath: string, id: string) => join(projectPath, "cast", id);
export function readCardAt(projectPath: string, id: string): CastCard | undefined {
  try {
    return JSON.parse(
      readFileSync(join(castDir(projectPath, id), "card.json"), "utf8"),
    ) as CastCard;
  } catch {
    return undefined;
  }
}
/** Consent is recomputed from the record, never trusted from the stored status. */
export const consented = (c: CastCard) =>
  !GATED.has(c.origin) || !!(c.consent?.confirmed && c.consent.user_quote?.trim());

// Which refs carry identity, in priority order, per kind.
const IDENTITY_ROLES: Record<CastCard["kind"], Role[]> = {
  character: ["hero", "fullbody", "angle", "expression", "outfit"],
  location: ["plate", "hero", "angle", "style"],
  prop: ["hero", "angle", "fullbody", "style"],
};
const DESCRIPTION_MAX = 600;
const REFS_PER_CARD = 4;
const MAX_CARDS = 6;

export interface CastUse {
  cards: CastCard[];
  /** "Name: description" lines appended to the prompt */
  promptAddition: string;
  /** absolute ref paths, identity-priority order, hero first per card */
  refs: string[];
  /** provenance record */
  record: {
    id: string;
    name: string;
    kind: string;
    style: string;
    origin: string;
    status: string;
    descriptionChars: number;
    refs: { path: string; role: string }[];
  }[];
  notes: string[];
}

/** Validate cards for a generation and build the injection. Pure local checks: call before any spend. */
export function resolveCast(
  projectPath: string,
  ids: string[],
): CastUse | { error: { code: ErrorCode; message: string; remedy: string } } {
  const err = (code: ErrorCode, message: string, remedy: string) => ({
    error: { code, message, remedy },
  });
  const unique = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
  if (!unique.length || unique.length > MAX_CARDS)
    return err(
      "INVALID_INPUT",
      `cast takes 1-${MAX_CARDS} card ids (got ${unique.length}).`,
      "Pass ids from cast_list.",
    );
  const cards: CastCard[] = [];
  for (const id of unique) {
    const card = readCardAt(projectPath, id);
    if (!card)
      return err(
        "NOT_FOUND",
        `No cast card '${id}'.`,
        "Use cast_list, or create it with cast_create.",
      );
    cards.push(card);
  }
  for (const c of cards)
    if (!consented(c))
      return err(
        "CONSENT_REQUIRED",
        `Cast card '${c.id}' (${c.name}, origin ${c.origin}) is a draft: no confirmed consent/licence.`,
        "Ask the user; only after their explicit words use cast_update consent=true with user_quote. Never generate a real person's likeness without it.",
      );
  const refs: string[] = [];
  const record: CastUse["record"] = [];
  const notes: string[] = [];
  const lines: string[] = [];
  for (const c of cards) {
    const usable = c.refs.filter((r) => existsSync(resolve(projectPath, r.path)));
    if (!usable.length)
      return err(
        "INVALID_INPUT",
        `Cast card '${c.id}' has no usable reference images${c.refs.length ? " (files missing on disk)" : ""}.`,
        "Add a hero ref with cast_update add_refs (a generated or supplied image) before generating with this card.",
      );
    const order = IDENTITY_ROLES[c.kind];
    const ranked = [...usable].sort(
      (a, b) => (order.indexOf(a.role) + 1 || 99) - (order.indexOf(b.role) + 1 || 99),
    );
    const identity = ranked.filter((r) => order.includes(r.role));
    if (!identity.length)
      return err(
        "INVALID_INPUT",
        `Cast card '${c.id}' has refs but none with an identity role (${order.join(", ")}).`,
        "Add or re-tag a hero ref.",
      );
    const picked = identity.slice(0, REFS_PER_CARD);
    for (const r of picked) refs.push(resolve(projectPath, r.path));
    const desc =
      c.description.length > DESCRIPTION_MAX
        ? `${c.description.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
        : c.description;
    if (desc !== c.description) notes.push(`${c.id}: description cut to ${DESCRIPTION_MAX} chars`);
    lines.push(`${c.name}: ${desc}`);
    record.push({
      id: c.id,
      name: c.name,
      kind: c.kind,
      style: c.style,
      origin: c.origin,
      status: "ready",
      descriptionChars: desc.length,
      refs: picked.map((r) => ({ path: r.path, role: r.role })),
    });
    notes.push(
      `cast ${c.id}: description + ${picked.length} ref(s) (${picked.map((r) => r.role).join(", ")})`,
    );
  }
  return { cards, promptAddition: lines.join("\n"), refs, record, notes };
}

export const castToPrompt = (prompt: string | undefined, use: CastUse) =>
  prompt?.trim() ? `${prompt.trim()}\n\n${use.promptAddition}` : use.promptAddition;

// ---------------------------------------------------------------------------------------------
// Likeness check
// ---------------------------------------------------------------------------------------------
export const MATCH_AT = 0.75;
export const DRIFT_AT = 0.45;
export type Verdict = "match" | "drift" | "unsure";

/** Normalise a judge score: > 10 means /100, > 1 means /10. */
export function normaliseScore(n: number) {
  const s = n > 10 ? n / 100 : n > 1 ? n / 10 : n;
  return Math.min(1, Math.max(0, Math.round(s * 100) / 100));
}
export const verdictOf = (score: number): Verdict =>
  score >= MATCH_AT ? "match" : score <= DRIFT_AT ? "drift" : "unsure";

/** Contact sheet, cell x cell tiles, `cols` columns; a still or a frame at t. */
export async function sheet(
  items: { src: string; t?: number }[],
  out: string,
  cell: number,
  cols: number,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oh-sheet-"));
  try {
    let k = 0;
    for (const it of items) {
      await run("ffmpeg", [
        "-v",
        "error",
        ...(it.t !== undefined ? ["-ss", it.t.toFixed(3)] : []),
        "-i",
        it.src,
        "-frames:v",
        "1",
        "-vf",
        `scale=${cell}:${cell}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=0x202020,format=rgb24`,
        join(dir, `c${String(k++).padStart(3, "0")}.png`),
      ]);
    }
    const c = Math.min(cols, k);
    const rows = Math.ceil(k / c);
    mkdirSync(dirname(out), { recursive: true });
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-framerate",
      "1",
      "-i",
      join(dir, "c%03d.png"),
      "-vf",
      `tile=${c}x${rows}:padding=6:color=0xffffff`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      out,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 16x16 RGB thumbnail. */
async function thumb(src: string): Promise<Uint8Array> {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      src,
      "-frames:v",
      "1",
      "-vf",
      "scale=16:16:flags=area,format=rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 20 },
  );
  return stdout;
}

/**
 * Local sanity numbers only (colour/tone closeness to the nearest ref). This is NOT an identity score:
 * nothing offline can compare faces/bodies, so it never produces a verdict.
 */
export async function toneProxy(
  image: string,
  refs: string[],
): Promise<{ closestRef: string; colourCloseness: number; toneCloseness: number } | undefined> {
  try {
    const cand = await thumb(image);
    let best:
      | { closestRef: string; colourCloseness: number; toneCloseness: number; sum: number }
      | undefined;
    for (const r of refs) {
      const t = await thumb(r);
      const mean = (b: Uint8Array, ch: number) => {
        let s = 0;
        for (let i = ch; i < b.length; i += 3) s += b[i]!;
        return s / (b.length / 3);
      };
      const colourDist =
        [0, 1, 2].reduce((a, ch) => a + Math.abs(mean(cand, ch) - mean(t, ch)), 0) / (3 * 255);
      const hist = (b: Uint8Array) => {
        const h = new Array<number>(16).fill(0);
        for (let i = 0; i < b.length; i += 3)
          h[
            Math.min(
              15,
              Math.floor((0.2126 * b[i]! + 0.7152 * b[i + 1]! + 0.0722 * b[i + 2]!) / 16),
            )
          ]! += 1;
        return h.map((x) => x / (b.length / 3));
      };
      const hc = hist(cand);
      const ht = hist(t);
      const tone = hc.reduce((a, x, i) => a + Math.min(x, ht[i]!), 0);
      const colour = 1 - colourDist;
      const sum = colour + tone;
      if (!best || sum > best.sum)
        best = {
          closestRef: r,
          colourCloseness: Math.round(colour * 100) / 100,
          toneCloseness: Math.round(tone * 100) / 100,
          sum,
        };
    }
    return (
      best && {
        closestRef: best.closestRef,
        colourCloseness: best.colourCloseness,
        toneCloseness: best.toneCloseness,
      }
    );
  } catch {
    return undefined;
  }
}

export function rubric(card: CastCard) {
  const keep =
    card.style === "stylized"
      ? "the design language and silhouette (shape language, proportions, colour blocking, line/render style, signature props)"
      : card.kind === "character"
        ? "facial structure, apparent age, build, skin/hair/eye colouring, distinguishing marks"
        : card.kind === "location"
          ? "layout, architecture, materials, key landmarks, palette"
          : "shape, proportions, materials, markings, colour";
  return [
    `Likeness rubric for ${card.name} (${card.style} ${card.kind}). Judge ONLY: ${keep}.`,
    "Ignore per-shot variables: pose, expression, camera angle, lighting, backdrop, grade, wardrobe (unless the card fixes it).",
    `Give one score 0-1: >= ${MATCH_AT} match, <= ${DRIFT_AT} drift, in between unsure ("unsure" is only for a subject too small/hidden to judge: then pass too_small_to_judge).`,
    "Look at the sheet: references first (numbered left to right), the candidate is the LAST tile. Then call cast_check again with score + reason. Report honestly; on drift regenerate from the card (max 2 retake rounds).",
  ].join("\n");
}

export interface CheckEntry {
  at: string;
  image: string;
  score: number;
  verdict: Verdict;
  reason: string;
  scorer: string;
  jobId?: string;
}
export const ledgerPath = (projectPath: string, id: string) =>
  join(castDir(projectPath, id), "checks.jsonl");
export function appendCheck(projectPath: string, id: string, entry: CheckEntry) {
  mkdirSync(castDir(projectPath, id), { recursive: true });
  appendFileSync(ledgerPath(projectPath, id), `${JSON.stringify(entry)}\n`);
}
export function readChecks(projectPath: string, id: string): CheckEntry[] {
  try {
    return readFileSync(ledgerPath(projectPath, id), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CheckEntry);
  } catch {
    return [];
  }
}

/** Build the sheet (identity refs + candidate last) and the text brief for an unscored check. */
export async function likenessBrief(
  projectPath: string,
  card: CastCard,
  image: string,
): Promise<{ text: string; sheetPath?: string }> {
  const use = resolveCast(projectPath, [card.id]);
  if ("error" in use) return { text: coded(use.error.code, use.error.message, use.error.remedy) };
  const refs = use.refs.slice(0, 4);
  const out = join(castDir(projectPath, card.id), "check-sheet.jpg");
  let sheetPath: string | undefined;
  try {
    await sheet(
      [...refs, image].map((src) => ({ src })),
      out,
      360,
      Math.min(5, refs.length + 1),
    );
    sheetPath = out;
  } catch {
    // sheet is a convenience; the rubric still applies
  }
  const proxy = await toneProxy(image, refs);
  const drifts = readChecks(projectPath, card.id).filter((c) => c.verdict === "drift").length;
  return {
    text: [
      `Likeness check for '${card.id}': UNSCORED. No offline identity scorer exists and no paid vision call was made; YOU must score the sheet${sheetPath ? ` (${sheetPath})` : ""}.`,
      proxy
        ? `Sanity numbers (colour/tone only, NOT identity, no verdict): colour closeness ${proxy.colourCloseness}, tone closeness ${proxy.toneCloseness}.`
        : "",
      rubric(card),
      drifts ? `Earlier drift verdicts logged for this card: ${drifts}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    ...(sheetPath ? { sheetPath } : {}),
  };
}

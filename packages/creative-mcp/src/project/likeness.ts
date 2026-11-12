// Scored likeness check: independent VLM judge through fal (openrouter/router/vision), temperature 0,
// strict JSON, 2 calls averaged (3rd + median when they differ > 0.2). Optional local face-identity
// cosine for real-person cards (opt-in, see face_embed.py). Falls back to the unscored rubric when
// there is no fal key, the cap refuses, or the judge fails. Nothing is downloaded automatically.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadKeys } from "../media/providers.ts";
import * as pricing from "../media/pricing.ts";
import {
  appendCheck,
  DRIFT_AT,
  MATCH_AT,
  normaliseScore,
  resolveCast,
  verdictOf,
  type CastCard,
  type CheckEntry,
  type Verdict,
} from "./cast.ts";

const run = promisify(execFile);
export const JUDGE_ENDPOINT = "openrouter/router/vision";
export const judgeModel = () => process.env.OH_LIKENESS_MODEL || "anthropic/claude-sonnet-4.5";
/** per-call price used for the ledger / estimate (fal passes the OpenRouter price through; ~$0.01) */
export const JUDGE_CALL_USD = 0.01;
export const JUDGE_CALL_USD_MAX = 0.03;
export const judgeEnabled = () => process.env.OH_LIKENESS_JUDGE !== "off" && !!loadKeys().falApiKey;

export interface Aspect {
  score: number;
  reason: string;
}
export interface Judged {
  overall: number;
  verdict: Verdict;
  aspects: Record<string, Aspect>;
  reason: string;
  calls: number[];
  model: string;
  face?: { cosine?: number; error?: string; faces?: { refs: number; candidate: number } };
}

const aspectsFor = (card: CastCard) =>
  card.kind === "character"
    ? card.style === "stylized"
      ? ["design_silhouette", "face_features", "colour_blocking", "outfit", "props"]
      : ["face_identity", "hair", "skin_age", "outfit", "props"]
    : ["silhouette", "materials", "colour", "logo_details"];

const SYSTEM =
  "You are a strict, independent visual identity judge for a film production. You compare a candidate image with reference images of the same subject. Be sceptical: similar vibe is not the same subject. Reply with one JSON object and nothing else.";

function promptFor(card: CastCard, nRefs: number, aspects: string[]) {
  const target =
    card.style === "stylized"
      ? "the character design and silhouette"
      : card.kind === "character"
        ? "the person's identity (facial structure, age, build, colouring, distinguishing marks)"
        : "the object/place (shape, materials, colour, markings, details)";
  return [
    `Images 1-${nRefs} are references of "${card.name}" (${card.style} ${card.kind}). Image ${nRefs + 1} is the candidate.`,
    `Card description: ${card.description}`,
    `Judge whether the candidate shows the same subject: ${target}. Ignore pose, expression, camera, lighting, backdrop, grade and wardrobe unless the card fixes them.`,
    `Score each aspect 0-1 (1 = indistinguishable from the refs, 0.5 = same type but clearly different specifics, 0 = different subject; use "n/a" scoring 0.5 with reason "not visible" only if the aspect cannot be seen).`,
    `Reply as JSON: {"aspects":{${aspects.map((a) => `"${a}":{"score":0.0,"reason":"one line"}`).join(",")}},"overall":0.0,"reason":"one line"}`,
  ].join("\n");
}

/** JPEG <= 1024 px as a data URI (no upload). */
async function jpegDataUri(src: string): Promise<string> {
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
      "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
      "-q:v",
      "4",
      "-f",
      "mjpeg",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 16 << 20 },
  );
  return `data:image/jpeg;base64,${stdout.toString("base64")}`;
}

function parseJudge(
  raw: string,
  aspects: string[],
): { overall: number; aspects: Record<string, Aspect>; reason: string } | undefined {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as {
      aspects?: Record<string, { score?: unknown; reason?: unknown }>;
      overall?: unknown;
      reason?: unknown;
    };
    const out: Record<string, Aspect> = {};
    for (const a of aspects) {
      const e = j.aspects?.[a];
      const n = Number(e?.score);
      if (e && Number.isFinite(n))
        out[a] = { score: normaliseScore(n), reason: String(e.reason ?? "").slice(0, 200) };
    }
    const overall = Number(j.overall);
    if (!Number.isFinite(overall)) return undefined;
    return {
      overall: normaliseScore(overall),
      aspects: out,
      reason: String(j.reason ?? "").slice(0, 300),
    };
  } catch {
    return undefined;
  }
}

async function callJudge(images: string[], prompt: string, aspects: string[], signal: AbortSignal) {
  const res = await fetch(`https://fal.run/${JUDGE_ENDPOINT}`, {
    method: "POST",
    headers: { Authorization: `Key ${loadKeys().falApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      system_prompt: SYSTEM,
      model: judgeModel(),
      image_urls: images,
      temperature: 0,
      max_tokens: 900,
    }),
    signal,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${body.slice(0, 200)}`);
  const j = JSON.parse(body) as { output?: string };
  const parsed = parseJudge(String(j.output ?? ""), aspects);
  if (!parsed)
    throw new Error(
      `judge reply was not the requested JSON: ${String(j.output ?? "").slice(0, 160)}`,
    );
  return parsed;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;

async function faceSignal(refs: string[], image: string): Promise<Judged["face"] | undefined> {
  if (!process.env.OH_FACE_EMBED_MODEL) return undefined;
  try {
    const { stdout } = await run(
      "python3",
      [
        "-I",
        join(dirname(new URL(import.meta.url).pathname), "face_embed.py"),
        ...refs,
        "--",
        image,
      ],
      { timeout: 60_000, env: process.env },
    );
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Judged["face"];
  } catch (error) {
    return { error: String(error).slice(0, 160) };
  }
}

/** Judge one image (calls: 2 normally; third when they differ > 0.2). Throws on judge/cap failure (caller falls back). */
export async function judgeImage(
  projectPath: string,
  card: CastCard,
  image: string,
  opts: { calls?: number } = {},
): Promise<Judged> {
  const use = resolveCast(projectPath, [card.id]);
  if ("error" in use) throw new Error(use.error.message);
  const refs = use.refs.slice(0, 4);
  const aspects = aspectsFor(card);
  const images = await Promise.all([...refs, image].map(jpegDataUri));
  const prompt = promptFor(card, refs.length, aspects);
  const want = opts.calls ?? 2;
  const ledgerId = `likeness-${randomUUID().slice(0, 8)}`;
  const est: pricing.Estimate = {
    usd: JUDGE_CALL_USD * want,
    usdMax: JUDGE_CALL_USD_MAX * (want + (want > 1 ? 1 : 0)),
    payer: "your fal key",
    approximate: true,
    basis: `${JUDGE_ENDPOINT} ${judgeModel()}, ~$${JUDGE_CALL_USD}/call`,
  };
  pricing.reserve(ledgerId, est);
  const signal = AbortSignal.timeout(120_000);
  let results: Awaited<ReturnType<typeof callJudge>>[] = [];
  let made = 0;
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: want }, () => callJudge(images, prompt, aspects, signal)),
    );
    made = want;
    results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (!results.length)
      throw new Error((settled[0] as PromiseRejectedResult).reason?.message ?? "judge failed");
    if (results.length > 1 && Math.abs(results[0]!.overall - results[1]!.overall) > 0.2) {
      made++;
      try {
        results.push(await callJudge(images, prompt, aspects, signal));
      } catch {
        // two disagreeing calls: keep them, the spread is reported
      }
    }
  } finally {
    pricing.settle(ledgerId, made ? "spent" : "released", JUDGE_CALL_USD * made);
  }
  const overalls = results.map((r) => r.overall);
  const overall = results.length === 3 ? median(overalls) : mean(overalls);
  const merged: Record<string, Aspect> = {};
  for (const a of aspects) {
    const have = results.map((r) => r.aspects[a]).filter((x): x is Aspect => !!x);
    if (have.length) merged[a] = { score: mean(have.map((h) => h.score)), reason: have[0]!.reason };
  }
  const face = await faceSignal(refs, image);
  return {
    overall,
    verdict: verdictOf(overall),
    aspects: merged,
    reason: results[0]!.reason,
    calls: overalls,
    model: judgeModel(),
    ...(face ? { face } : {}),
  };
}

export function judgedText(card: CastCard, image: string, j: Judged) {
  const spread = Math.max(...j.calls) - Math.min(...j.calls);
  return [
    `Likeness ${j.verdict.toUpperCase()} for '${card.id}': overall ${j.overall} (match >= ${MATCH_AT}, drift <= ${DRIFT_AT}) - judge ${j.model} via fal, ${j.calls.length} call(s) [${j.calls.join(", ")}]${spread > 0.2 ? ", calls disagree: treat with caution" : ""}.`,
    ...Object.entries(j.aspects).map(([a, v]) => `  ${a}: ${v.score} - ${v.reason}`),
    `Reason: ${j.reason}`,
    j.face
      ? `Local face identity (opt-in): ${j.face.cosine !== undefined ? `cosine ${j.face.cosine} (${j.face.faces?.refs} ref face(s), ${j.face.faces?.candidate} candidate face(s))` : `unavailable (${j.face.error})`}.`
      : "",
    j.verdict === "drift"
      ? `Regenerate from the card (cast:["${card.id}"]) naming the failing aspects; max 2 retake rounds, then report honestly.`
      : j.verdict === "unsure"
        ? "Unsure: do not claim a match."
        : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function logJudged(
  projectPath: string,
  card: CastCard,
  image: string,
  rel: string,
  j: Judged,
  jobId?: string,
) {
  const entry: CheckEntry & Record<string, unknown> = {
    at: new Date().toISOString(),
    image: rel,
    score: j.overall,
    verdict: j.verdict,
    reason: j.reason,
    scorer: `vlm:${j.model}`,
    aspects: j.aspects,
    calls: j.calls,
    ...(j.face ? { face: j.face } : {}),
    ...(jobId ? { jobId } : {}),
  };
  appendCheck(projectPath, card.id, entry);
}

/** Video: judge 3 sampled frames (20/50/80 %, one call each); the result is the median, the worst frame is listed. */
export async function judgeVideo(
  projectPath: string,
  card: CastCard,
  video: string,
): Promise<{ judged: Judged; frames: { t: number; overall: number }[] }> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    video,
  ]);
  const duration = Number(stdout.trim()) || 1;
  const dir = mkdtempSync(join(tmpdir(), "oh-likeness-"));
  try {
    const frames: { t: number; overall: number; j: Judged }[] = [];
    for (const f of [0.2, 0.5, 0.8]) {
      const out = join(dir, `f${f}.jpg`);
      await run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-ss",
        (duration * f).toFixed(2),
        "-i",
        video,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        out,
      ]);
      const j = await judgeImage(projectPath, card, out, { calls: 1 });
      frames.push({ t: Math.round(duration * f * 100) / 100, overall: j.overall, j });
    }
    const overall = median(frames.map((x) => x.overall));
    const base = frames.find((x) => x.overall === overall)!.j;
    return {
      judged: {
        ...base,
        overall,
        verdict: verdictOf(overall),
        calls: frames.map((x) => x.overall),
      },
      frames: frames.map(({ t, overall: o }) => ({ t, overall: o })),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

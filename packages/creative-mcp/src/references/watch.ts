// Reference video tools: download a public video with a receipt (reference_download) and watch it
// properly (media_watch): measure first (cuts, shot lengths, loudness, contact sheet), let a
// video-understanding model describe it with sound, then cross-check the model's claims against the
// measurements and against the frames (OCR for on-screen text) so nothing is taken on trust.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { falUpload, loadKeys } from "../media/providers.ts";
import * as pricing from "../media/pricing.ts";
import {
  drawText,
  fitWidth,
  grid,
  mediaSize,
  readImage,
  writeJpeg,
  type Img,
} from "../quality/raster.ts";
import { measureAudio } from "../quality/review-extra.ts";
import { getOcr } from "../quality/vision.ts";

const run = promisify(execFile);
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const abs = (p: string) => resolve(process.cwd(), p);
const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};
const BIG = { maxBuffer: 256 * 1024 * 1024, timeout: 1_800_000 };
const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// ---------------------------------------------------------------------------------------------
// Models. Both are served by fal's openrouter/router/video and hear the soundtrack.
// ---------------------------------------------------------------------------------------------
const ENDPOINT = "openrouter/router/video";
const MODELS: Record<string, { id: string; usdPerMinute: number; reasoning?: boolean }> = {
  fast: { id: "google/gemini-2.5-flash", usdPerMinute: 0.015 },
  // Pro refuses to run with reasoning off, so it gets reasoning on (and token room for it).
  strong: { id: "google/gemini-2.5-pro", usdPerMinute: 0.08, reasoning: true },
};
const CHUNK_SECONDS = 150;
const CUT_TOLERANCE = 0.6;

// ---------------------------------------------------------------------------------------------
// Library: references/<board>/library.json holds one entry per downloaded clip.
// ---------------------------------------------------------------------------------------------
interface LibraryItem {
  id: string;
  file: string;
  receipt: Record<string, unknown>;
  watch?: string;
  [extra: string]: unknown;
}
interface Library {
  board: string;
  updated: string;
  items: LibraryItem[];
  [extra: string]: unknown;
}

const libraryFile = (board: string) => abs(join("references", board, "library.json"));

function readLibrary(board: string): Library {
  try {
    return JSON.parse(readFileSync(libraryFile(board), "utf8")) as Library;
  } catch {
    return { board, updated: "", items: [] };
  }
}

function writeLibrary(lib: Library) {
  lib.updated = new Date().toISOString();
  mkdirSync(dirname(libraryFile(lib.board)), { recursive: true });
  writeFileSync(libraryFile(lib.board), `${JSON.stringify(lib, null, 2)}\n`);
}

/** The board a clip lives in, when its path is references/<board>/clips/<file>. */
function boardOf(path: string): string | undefined {
  const parts = relative(abs("references"), path).split(sep);
  return parts.length >= 3 && parts[0] !== ".." && parts[1] === "clips" ? parts[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Measuring.
// ---------------------------------------------------------------------------------------------
interface Cut {
  t: number;
  score: number;
}
interface Measured {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  cuts: Cut[];
  shots: { start: number; end: number; length: number }[];
  shotLength: { mean: number; median: number; min: number; max: number };
  cutsPer10s: number;
  audio?: { lufs: number; lra: number; truePeak: number; quietShare: number };
}

async function probe(src: string) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,avg_frame_rate",
    "-of",
    "json",
    src,
  ]);
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; avg_frame_rate?: string }[];
  };
  const duration = Number(info.format?.duration) || 0;
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video || !duration) throw new Error("No video stream / duration found.");
  const [n, d] = (video.avg_frame_rate ?? "0/1").split("/").map(Number) as [number, number];
  return {
    duration,
    fps: d ? round(n / d, 2) : 0,
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
  };
}

async function detectCuts(src: string, duration: number, threshold = 10): Promise<Cut[]> {
  const dir = mkdtempSync(join(tmpdir(), "oh-watch-cuts-"));
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
        `scale=320:-2,scdet=threshold=${threshold},metadata=mode=print:file=${meta}`,
        "-f",
        "null",
        "-",
      ],
      BIG,
    );
    const cuts: Cut[] = [];
    let t = Number.NaN;
    let score = 0;
    for (const line of readFileSync(meta, "utf8").split("\n")) {
      const fm = /pts_time:([\d.eE+-]+)/.exec(line);
      if (line.startsWith("frame:") && fm) t = Number(fm[1]);
      else if (line.startsWith("lavfi.scd.score=")) score = Number(line.split("=")[1]);
      else if (line.startsWith("lavfi.scd.time=") && Number.isFinite(t))
        if (t > 0.05 && t < duration - 0.05) cuts.push({ t: round(t, 2), score: round(score, 1) });
    }
    return cuts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function measure(src: string): Promise<Measured> {
  const p = await probe(src);
  const size = await mediaSize(src);
  const cuts = await detectCuts(src, p.duration);
  const bounds = [0, ...cuts.map((c) => c.t), p.duration];
  const shots = bounds.slice(1).map((end, i) => ({
    start: bounds[i]!,
    end,
    length: round(end - bounds[i]!, 2),
  }));
  const lens = shots.map((s) => s.length).sort((a, b) => a - b);
  const median =
    lens.length % 2
      ? lens[(lens.length - 1) / 2]!
      : (lens[lens.length / 2 - 1]! + lens[lens.length / 2]!) / 2;
  let audio: Measured["audio"];
  if (p.hasAudio) {
    try {
      const a = await measureAudio(src);
      const quiet = a.M.filter((m) => m.m < -50).length / (a.M.length || 1);
      audio = {
        lufs: round(a.I),
        lra: round(a.LRA),
        truePeak: round(a.TP),
        quietShare: round(quiet, 2),
      };
    } catch {
      // loudness is optional
    }
  }
  return {
    duration: round(p.duration, 2),
    width: size.w,
    height: size.h,
    fps: p.fps,
    hasAudio: p.hasAudio,
    cuts,
    shots,
    shotLength: {
      mean: round(lens.reduce((a, b) => a + b, 0) / lens.length, 2),
      median: round(median, 2),
      min: lens[0]!,
      max: lens.at(-1)!,
    },
    cutsPer10s: round((cuts.length / p.duration) * 10),
    audio,
  };
}

// ---------------------------------------------------------------------------------------------
// Frames and sheets.
// ---------------------------------------------------------------------------------------------
async function frameAt(src: string, t: number, out: string, width = 640): Promise<string> {
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-ss",
    String(Math.max(0, t)),
    "-i",
    src,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    "3",
    out,
  ]);
  return out;
}

async function labelledSheet(
  src: string,
  cells: { t: number; label: string }[],
  out: string,
  cols: number,
  cw: number,
): Promise<string> {
  const size = fitWidth(await mediaSize(src), cw);
  const imgs: (Img | undefined)[] = await Promise.all(
    cells.map(async (c) => {
      try {
        const img = await readImage(src, size.w, size.h, ["-ss", String(Math.max(0, c.t))]);
        drawText(img, 2, 2, c.label, [255, 255, 255], 2);
        return img;
      } catch {
        return undefined;
      }
    }),
  );
  return writeJpeg(grid(imgs, cols, size.w, size.h, 4, [0, 0, 0]), out, 4);
}

// ---------------------------------------------------------------------------------------------
// The model call (fal queue, openrouter/router/video).
// ---------------------------------------------------------------------------------------------
interface ModelReply {
  output: string;
  costUsd: number | null;
}

async function askModel(
  key: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ModelReply> {
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  const submit = await fetch(`https://queue.fal.run/${ENDPOINT}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!submit.ok)
    throw new Error(`fal submit HTTP ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const sub = (await submit.json()) as { status_url: string; response_url: string };
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await (await fetch(sub.status_url, { headers, signal })).json()) as {
      status?: string;
      error?: string;
    };
    if (st.status === "COMPLETED") break;
    if (st.status === "FAILED" || st.error)
      throw new Error(`model call failed: ${JSON.stringify(st).slice(0, 300)}`);
  }
  const resRaw = await fetch(sub.response_url, { headers, signal });
  const res = (await resRaw.json()) as {
    output?: string;
    usage?: { cost?: number };
    detail?: unknown;
  };
  if (typeof res.output !== "string")
    throw new Error(`model returned no output: ${JSON.stringify(res).slice(0, 300)}`);
  return {
    output: res.output,
    costUsd: typeof res.usage?.cost === "number" ? res.usage.cost : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Prompt and breakdown schema.
// ---------------------------------------------------------------------------------------------
interface Shot {
  start: number;
  end: number;
  visual?: string;
  on_screen_text?: string;
  camera?: string;
  transition?: string;
  audio?: string;
}
interface Breakdown {
  hook?: string;
  structure?: string;
  format_type?: string;
  pacing?: string;
  craft?: string[];
  shots: Shot[];
  claims?: { t: number; claim: string }[];
  answer?: string;
}

const SYSTEM_PROMPT =
  "You are a senior commercial editor and motion designer analysing a video for another creative who cannot watch it. You hear the soundtrack. Be exact and literal: quote on-screen text and spoken words verbatim, and write 'unclear' instead of guessing. Never invent cuts, words or details. Answer with one JSON object only, no prose around it.";

function buildPrompt(opts: {
  m: Measured;
  question?: string;
  focus?: string;
  part?: { index: number; total: number; offset: number };
}): string {
  const { m, question, focus, part } = opts;
  const cutList = m.cuts.length ? m.cuts.map((c) => c.t.toFixed(2)).join(", ") : "none";
  return [
    part
      ? `This is part ${part.index + 1} of ${part.total} of a longer video (it starts at ${part.offset} s in the original). Timestamps below are relative to THIS clip, starting at 0.`
      : "Watch the whole video with sound.",
    `Measured facts (ffmpeg, trust these over your impression): duration ${m.duration} s, ${m.width}x${m.height}, ${m.fps} fps, ${m.hasAudio ? "has audio" : "NO audio track"}.`,
    `Measured hard cuts (scene detection) at seconds: ${cutList}. A shot boundary you report should normally sit on one of these. If you see a transition that is not in the list, label it a dissolve, whip, match cut or continuous camera move, do not call it a cut. If the list is "none" the video is one continuous take or uses only soft transitions.`,
    focus ? `Pay special attention to: ${focus}.` : "",
    "Return JSON with exactly these keys:",
    `{
  "hook": "what happens in the first 3 s (visual, text, sound) and why it does or does not stop the scroll",
  "structure": "the narrative arc in one or two sentences (e.g. problem -> product -> proof -> CTA)",
  "format_type": "one of: problem-solution, app demo, people story, UGC/testimonial, POV, list, before/after, brand film, product beauty shot, motion-graphics explainer, other (say which)",
  "pacing": "shots per 10 s, rhythm, how it relates to the music/voice",
  "craft": ["3-6 concrete craft details a top motion designer would notice: type, easing, camera, colour, sound design"],
  "shots": [ { "start": 0.0, "end": 2.4, "visual": "...", "on_screen_text": "verbatim, or empty string", "camera": "camera and motion", "transition": "how it enters from the previous shot (cut, dissolve, whip, match cut, continuous...)", "audio": "voice-over verbatim, SFX, music behaviour at that moment" } ],
  "claims": [ { "t": 1.2, "claim": "a specific visual or text claim you want someone to verify by looking at the frame at this second" } ],
  "answer": ${question ? '"answer to the question below"' : '""'}
}`,
    "Shots must cover the whole clip without gaps, in order. Give 6-12 claims about the most important visual or text moments.",
    question ? `Question to answer in "answer": ${question}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseBreakdown(raw: string): Breakdown | undefined {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const j = JSON.parse(cleaned.slice(start, end + 1)) as Breakdown;
    if (!Array.isArray(j.shots)) return undefined;
    j.shots = j.shots
      .map((s) => ({ ...s, start: Number(s.start), end: Number(s.end) }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
    j.claims = (j.claims ?? [])
      .map((c) => ({ t: Number(c.t), claim: String(c.claim ?? "") }))
      .filter((c) => Number.isFinite(c.t));
    return j;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Cross-check.
// ---------------------------------------------------------------------------------------------
const SOFT =
  /dissolv|fade|whip|morph|match|zoom|continuous|swipe|wipe|slide|push|flash|glitch|mask|overlap/i;
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  // one edit away
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (s: string, k: number) => s.slice(k);
  return (
    rest(a, i + 1) === rest(b, i + 1) ||
    rest(a, i + 1) === rest(b, i) ||
    rest(a, i) === rest(b, i + 1)
  );
}

interface Check {
  verdict: "verified" | "disputed" | "unverified";
  note: string;
}

function checkCut(
  shot: Shot,
  index: number,
  m: Measured,
  claimedBounds: number[],
): Check | undefined {
  if (index === 0) return undefined;
  const nearest = m.cuts.reduce<Cut | undefined>(
    (best, c) => (!best || Math.abs(c.t - shot.start) < Math.abs(best.t - shot.start) ? c : best),
    undefined,
  );
  const dist = nearest ? Math.abs(nearest.t - shot.start) : Infinity;
  void claimedBounds;
  if (dist <= CUT_TOLERANCE)
    return {
      verdict: "verified",
      note: `cut at ${shot.start}s matches measured cut ${nearest!.t}s`,
    };
  const soft = SOFT.test(shot.transition ?? "");
  if (soft)
    return {
      verdict: "unverified",
      note: `claimed "${shot.transition}" at ${shot.start}s: no hard cut measured there (expected for a soft transition; look at the frames)`,
    };
  return {
    verdict: "disputed",
    note: `claimed cut at ${shot.start}s but no measured cut within ${CUT_TOLERANCE}s${nearest ? ` (nearest ${nearest.t}s)` : ""}: likely continuous motion, a soft transition or an invented boundary`,
  };
}

async function checkTexts(
  src: string,
  shots: Shot[],
  m: Measured,
  dir: string,
): Promise<{ checks: Map<number, Check>; ocr: string }> {
  const checks = new Map<number, Check>();
  const withText = shots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => words(s.on_screen_text ?? "").length > 0);
  if (!withText.length) return { checks, ocr: "none claimed" };
  const ocr = await getOcr();
  if (!ocr) {
    for (const { i } of withText)
      checks.set(i, {
        verdict: "unverified",
        note: "no OCR available (needs macOS Vision or tesseract)",
      });
    return { checks, ocr: "unavailable" };
  }
  const perShot = withText.length > 20 ? 2 : 4;
  const files: { file: string; i: number }[] = [];
  for (const { s, i } of withText) {
    const end = Math.min(s.end, m.duration - 0.05);
    const span = Math.max(0.1, end - s.start);
    for (let k = 0; k < perShot; k++) {
      const t = s.start + (span * (k + 0.5)) / perShot;
      const file = join(dir, `ocr-${i}-${k}.jpg`);
      try {
        await frameAt(src, t, file, 960);
        files.push({ file, i });
      } catch {
        // skip an undecodable time
      }
    }
  }
  const read = await ocr.read(files.map((f) => f.file));
  for (const { s, i } of withText) {
    const seen = new Set<string>();
    for (const f of files.filter((x) => x.i === i))
      for (const box of read.get(f.file) ?? []) for (const w of words(box.text)) seen.add(w);
    const claimed = [...new Set(words(s.on_screen_text ?? ""))];
    const found = claimed.filter((w) => seen.has(w) || [...seen].some((x) => near(w, x)));
    const missing = claimed.filter((w) => !found.includes(w));
    const ratio = found.length / claimed.length;
    if (!seen.size)
      checks.set(i, {
        verdict: "unverified",
        note: "OCR read no text in this shot (stylised or animated text can be missed; look at the frames)",
      });
    else if (ratio >= 0.8 && !missing.length)
      checks.set(i, {
        verdict: "verified",
        note: `on-screen text confirmed by OCR (${found.length}/${claimed.length} words)`,
      });
    else if (ratio >= 0.6)
      checks.set(i, {
        verdict: "verified",
        note: `on-screen text mostly confirmed by OCR; not seen: ${missing.join(", ")}`,
      });
    else
      checks.set(i, {
        verdict: "disputed",
        note: `OCR did not find ${missing.map((w) => `"${w}"`).join(", ")} (${found.length}/${claimed.length} words matched); the model may have misread or invented text. OCR saw: ${[...seen].slice(0, 12).join(" ") || "nothing"}`,
      });
  }
  return { checks, ocr: ocr.name };
}

function checkSummaryClaims(b: Breakdown, m: Measured): string[] {
  const flags: string[] = [];
  const pacingText = `${b.pacing ?? ""} ${(b.craft ?? []).join(" ")} ${b.hook ?? ""}`;
  if (
    /(quick|rapid|fast|rhythmic|staccato|frenetic)[- ]*(cuts?|cutting|edit)|many cuts/i.test(
      pacingText,
    ) &&
    m.shotLength.median > 2.5
  )
    flags.push(
      `DISPUTED pacing: the model describes fast cutting but the measured median shot length is ${m.shotLength.median}s (${m.cuts.length} hard cuts, ${m.cutsPer10s} per 10 s). Likely continuous motion or on-screen animation, not editing.`,
    );
  const claimedCuts = Math.max(0, b.shots.length - 1);
  if (Math.abs(claimedCuts - m.cuts.length) > Math.max(2, m.cuts.length * 0.4))
    flags.push(
      `DISPUTED shot count: model lists ${b.shots.length} shots (${claimedCuts} boundaries), measurement found ${m.cuts.length} hard cuts (${m.shots.length} shots). Soft transitions explain a gap only if the model labelled them as such.`,
    );
  const last = b.shots.at(-1);
  if (last && Math.abs(last.end - m.duration) > 1.5)
    flags.push(
      `DISPUTED timeline: the model's last shot ends at ${last.end}s but the video is ${m.duration}s long.`,
    );
  const claimedBounds = b.shots.slice(1).map((s) => s.start);
  const unclaimed = m.cuts.filter(
    (c) => !claimedBounds.some((t) => Math.abs(t - c.t) <= CUT_TOLERANCE),
  );
  if (unclaimed.length)
    flags.push(
      `Measured cuts the breakdown does not list as shot boundaries (${unclaimed.length}): ${unclaimed
        .slice(0, 12)
        .map((c) => `${c.t}s`)
        .join(", ")}. Check whether the model merged shots.`,
    );
  if (
    !m.hasAudio &&
    b.shots.some(
      (s) =>
        /voice|music|narrat|sfx|sound/i.test(s.audio ?? "") &&
        !/none|silent|no audio|no sound/i.test(s.audio ?? ""),
    )
  )
    flags.push("DISPUTED audio: the file has no audio track but the breakdown describes sound.");
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Chunking: long videos are cut into parts (proxy re-encode), each watched separately.
// ---------------------------------------------------------------------------------------------
async function proxy(
  src: string,
  start: number,
  length: number | undefined,
  out: string,
  hasAudio: boolean,
) {
  await run(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-ss",
      String(start),
      ...(length ? ["-t", String(length)] : []),
      "-i",
      src,
      "-vf",
      "scale='min(720,iw)':-2",
      "-c:v",
      "libx264",
      "-crf",
      "27",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "96k"] : ["-an"]),
      out,
    ],
    BIG,
  );
}

// ---------------------------------------------------------------------------------------------
// Tools.
// ---------------------------------------------------------------------------------------------
export function registerWatchTools(server: McpServer) {
  server.registerTool(
    "reference_download",
    {
      description:
        "Download a public video (TikTok, YouTube, Instagram, X, Vimeo, ad-library pages that yt-dlp supports) at <=720p into references/<board>/clips/ and record a receipt in references/<board>/library.json: url, uploader, upload date, duration, views/likes/comments when the platform shows them, download time. Add the performance signals you found elsewhere (ad run time, rank, engagement) to the same library entry yourself. Then run media_watch on the file.",
      inputSchema: {
        url: z.string().url(),
        board: z.string().describe("Reference board / campaign name; becomes references/<board>/"),
      },
    },
    async ({ url, board }) => {
      const b = slug(board);
      if (!b) return fail("board must contain letters or digits.");
      const dir = abs(join("references", b, "clips"));
      mkdirSync(dir, { recursive: true });
      try {
        const { stdout } = await run(
          "yt-dlp",
          [
            "--no-playlist",
            "--no-warnings",
            "-f",
            "bv*[height<=720]+ba/b[height<=720]/b",
            "--merge-output-format",
            "mp4",
            "-o",
            join(dir, "%(id)s.%(ext)s"),
            "--dump-single-json",
            "--no-simulate",
            url,
          ],
          BIG,
        );
        const info = JSON.parse(stdout) as Record<string, any>;
        const id = String(info.id ?? randomUUID().slice(0, 8));
        const requested = info.requested_downloads?.[0]?.filepath as string | undefined;
        const file =
          requested && existsSync(requested)
            ? requested
            : readdirSync(dir)
                .filter((f) => f.startsWith(id) && /\.(mp4|mkv|webm|mov)$/i.test(f))
                .map((f) => join(dir, f))[0];
        if (!file) return fail("yt-dlp finished but no video file was found.");
        const d = String(info.upload_date ?? "");
        const receipt = {
          url: info.webpage_url ?? url,
          requested_url: url,
          platform: info.extractor_key ?? info.extractor,
          title: info.title,
          uploader: info.uploader ?? info.channel ?? info.uploader_id,
          upload_date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null,
          duration: info.duration ?? null,
          views: info.view_count ?? null,
          likes: info.like_count ?? null,
          comments: info.comment_count ?? null,
          reposts: info.repost_count ?? null,
          description: typeof info.description === "string" ? info.description.slice(0, 500) : null,
          downloaded_at: new Date().toISOString(),
          resolution: info.width && info.height ? `${info.width}x${info.height}` : null,
        };
        const lib = readLibrary(b);
        const entry: LibraryItem = { id, file: rel(file), receipt };
        const at = lib.items.findIndex((i) => i.id === id);
        if (at >= 0) lib.items[at] = { ...lib.items[at], ...entry };
        else lib.items.push(entry);
        writeLibrary(lib);
        const signal = ["views", "likes", "comments", "reposts"]
          .filter((k) => receipt[k as keyof typeof receipt] != null)
          .map((k) => `${k} ${receipt[k as keyof typeof receipt]}`)
          .join(", ");
        return text(
          [
            `Downloaded ${rel(file)} (${round(statSync(file).size / 1e6)} MB, ${receipt.resolution ?? "?"}, ${receipt.duration ?? "?"}s).`,
            `Receipt in ${rel(libraryFile(b))}: ${receipt.platform ?? "?"} / ${receipt.uploader ?? "?"} / ${receipt.upload_date ?? "date unknown"}${signal ? ` / ${signal}` : " / no public performance numbers"}.`,
            "Next: media_watch on this file; add any performance signal you find (ad run time, rank, engagement) to the library entry.",
          ].join("\n"),
        );
      } catch (error) {
        return fail(
          `reference_download failed: ${errText(error).slice(0, 600)}. Login-gated or geo-blocked pages often fail; try another URL for the same ad, or ask the user for the file.`,
        );
      }
    },
  );

  server.registerTool(
    "media_watch",
    {
      description:
        "Watch a video properly, with sound. First measures it (scene cuts, shot lengths, duration, loudness, contact sheet of every shot), then gives a video model the measured cut list and asks for a timestamped shot-by-shot breakdown (visuals, verbatim on-screen text, camera/motion, transitions, voice-over/SFX/music) plus hook (first 3 s), structure, format type, pacing and craft details. Then it cross-checks the model against the evidence: claimed cuts vs measured cuts, on-screen text vs OCR of the frames, pacing words vs measured shot length; every shot gets a verified / disputed / unverified note, and frames at the claimed timestamps are returned for you to LOOK at. Never trust a breakdown without looking at those frames. Costs real money on your fal key (about $0.01 per minute with the default model) and goes through the spend ledger. Works on your own pieces too: run it with the same question on ours and on the references to compare.",
      inputSchema: {
        path: z.string().describe("Local video file (e.g. from reference_download)"),
        question: z
          .string()
          .optional()
          .describe("An extra question the model should answer about the video"),
        model: z
          .string()
          .optional()
          .describe(
            'Model: "fast" (default, google/gemini-2.5-flash), "strong" (google/gemini-2.5-pro, ~5x the price, for hard or important references), or an OpenRouter video-capable model id',
          ),
        focus: z
          .string()
          .optional()
          .describe("What to look at most closely, e.g. 'hook, typography, sound design'"),
      },
    },
    async ({ path, question, model, focus }) => {
      const src = abs(path);
      if (!existsSync(src)) return fail(`File not found: ${src}`);
      const key = loadKeys().falApiKey;
      if (!key)
        return fail(
          "No fal key. Ask the user and store it with media_set_key (fal), or set FAL_KEY.",
        );
      const chosen = MODELS[model ?? "fast"] ?? {
        id: model!,
        usdPerMinute: 0.1,
        reasoning: /pro|thinking|reason/i.test(model!),
      };
      const board = boardOf(src);
      const name = slug(basename(src, extname(src))) || "video";
      const outDir = board
        ? abs(join("references", board, "watch", name))
        : abs(join("references", "_watch", name));
      mkdirSync(join(outDir, "frames"), { recursive: true });
      const work = mkdtempSync(join(tmpdir(), "oh-watch-"));
      try {
        // 1. Measure.
        const m = await measure(src);
        await writeFile(join(outDir, "measured.json"), m);

        // 2. Ask (chunked when long). Reserve the worst case in the spend ledger first.
        const parts = Math.max(1, Math.ceil(m.duration / CHUNK_SECONDS));
        const perPart = m.duration / parts;
        const est: pricing.Estimate = {
          usd: round(
            (m.duration / 60) * chosen.usdPerMinute + (chosen.reasoning ? 0.03 : 0.002) * parts,
            4,
          ),
          usdMax: round(
            (m.duration / 60) * chosen.usdPerMinute * 3 + (chosen.reasoning ? 0.08 : 0.01) * parts,
            4,
          ),
          payer: "your fal key",
          approximate: true,
          basis: `${ENDPOINT} ${chosen.id}, about $${chosen.usdPerMinute}/min of video`,
        };
        const ledgerId = `watch-${randomUUID().slice(0, 8)}`;
        pricing.reserve(ledgerId, est);
        let spent: number | null = 0;
        let calls = 0;
        const breakdowns: { b: Breakdown; offset: number; raw: string }[] = [];
        const signal = AbortSignal.timeout(600_000);
        try {
          for (let i = 0; i < parts; i++) {
            const offset = i * perPart;
            let file = src;
            let pm = m;
            if (parts > 1 || statSync(src).size > 40e6) {
              file = join(work, `part-${i}.mp4`);
              await proxy(src, offset, parts > 1 ? perPart : undefined, file, m.hasAudio);
            }
            if (parts > 1) {
              const cuts = m.cuts
                .filter((c) => c.t > offset && c.t < offset + perPart)
                .map((c) => ({ ...c, t: round(c.t - offset, 2) }));
              pm = { ...m, duration: round(perPart, 2), cuts };
            }
            const url = await falUpload(file, key, signal);
            calls++;
            const reply = await askModel(
              key,
              {
                model: chosen.id,
                video_urls: [url],
                system_prompt: SYSTEM_PROMPT,
                prompt: buildPrompt({
                  m: pm,
                  question,
                  focus,
                  part:
                    parts > 1 ? { index: i, total: parts, offset: round(offset, 1) } : undefined,
                }),
                temperature: 0,
                max_tokens: chosen.reasoning ? 24000 : 8000,
                ...(chosen.reasoning ? { reasoning: true } : {}),
              },
              signal,
            );
            spent = spent === null || reply.costUsd === null ? null : spent + reply.costUsd;
            const parsed = parseBreakdown(reply.output);
            if (!parsed) {
              await writeFile(join(outDir, "raw.txt"), reply.output);
              return fail(
                `The model's answer was not valid JSON (saved to ${rel(join(outDir, "raw.txt"))}), so it cannot be cross-checked. First 600 chars:\n${reply.output.slice(0, 600)}`,
              );
            }
            breakdowns.push({ b: parsed, offset, raw: reply.output });
          }
        } finally {
          pricing.settle(ledgerId, calls ? "spent" : "released", spent ?? est.usd);
        }

        // Merge parts onto the original timeline.
        const first = breakdowns[0]!.b;
        const merged: Breakdown = {
          hook: first.hook,
          format_type: first.format_type,
          structure: breakdowns
            .map(({ b }, i) => (parts > 1 ? `[part ${i + 1}] ` : "") + (b.structure ?? ""))
            .join(" "),
          pacing: breakdowns
            .map(({ b }, i) => (parts > 1 ? `[part ${i + 1}] ` : "") + (b.pacing ?? ""))
            .join(" "),
          craft: breakdowns.flatMap(({ b }) => b.craft ?? []),
          shots: breakdowns.flatMap(({ b, offset }) =>
            b.shots.map((s) => ({
              ...s,
              start: round(s.start + offset, 2),
              end: round(s.end + offset, 2),
            })),
          ),
          claims: breakdowns.flatMap(({ b, offset }) =>
            (b.claims ?? []).map((c) => ({ ...c, t: round(c.t + offset, 2) })),
          ),
          answer: breakdowns
            .map(({ b }) => b.answer)
            .filter(Boolean)
            .join("\n"),
        };

        // 3. Cross-check.
        const cutChecks = merged.shots.map((s, i) => checkCut(s, i, m, []));
        const { checks: textChecks, ocr } = await checkTexts(src, merged.shots, m, work);
        const summaryFlags = checkSummaryClaims(merged, m);

        // 4. Evidence frames: one per claim (plus hook frames), a sheet of them, a sheet of all shots.
        const claims = (merged.claims ?? [])
          .filter((c) => c.t >= 0 && c.t <= m.duration)
          .slice(0, 12);
        const evidence: { t: number; label: string; claim: string; file: string }[] = [];
        for (const [i, c] of claims.entries()) {
          const file = join(
            outDir,
            "frames",
            `claim-${String(i + 1).padStart(2, "0")}-${c.t.toFixed(1)}s.jpg`,
          );
          try {
            await frameAt(src, Math.min(c.t, m.duration - 0.05), file);
            evidence.push({ t: c.t, label: `C${i + 1} ${c.t.toFixed(1)}S`, claim: c.claim, file });
          } catch {
            // skip an undecodable time
          }
        }
        const portrait = m.height > m.width;
        const evidenceSheet = evidence.length
          ? await labelledSheet(
              src,
              evidence.map((e) => ({ t: e.t, label: e.label })),
              join(outDir, "claims-sheet.jpg"),
              portrait ? 6 : 3,
              portrait ? 220 : 480,
            )
          : undefined;
        const shotPick =
          m.shots.length <= 24
            ? m.shots
            : Array.from({ length: 24 }, (_, i) => m.shots[Math.floor((i * m.shots.length) / 24)]!);
        const shotSheet = await labelledSheet(
          src,
          shotPick.map((s) => ({
            t: Math.min(m.duration - 0.05, (s.start + s.end) / 2),
            label: `${s.start.toFixed(1)}S`,
          })),
          join(outDir, "shots-sheet.jpg"),
          portrait ? 8 : 4,
          portrait ? 180 : 320,
        );

        // 5. Report.
        const all = merged.shots.map((s, i) => {
          const c = [cutChecks[i], textChecks.get(i)].filter((x): x is Check => Boolean(x));
          return { s, checks: c };
        });
        const count = (v: Check["verdict"]) =>
          all.reduce((n, x) => n + x.checks.filter((c) => c.verdict === v).length, 0);
        const verified = count("verified");
        const disputed = count("disputed");
        const unverified = count("unverified");
        const lines: string[] = [
          `media_watch ${rel(src)} -> ${rel(outDir)}/ | model ${chosen.id} | cost ${spent === null ? "unknown (est. $" + est.usd + ")" : "$" + round(spent, 4)}${parts > 1 ? ` | ${parts} parts` : ""}`,
          "",
          "## Measured (trust these)",
          `- ${m.duration}s, ${m.width}x${m.height}, ${m.fps} fps. ${m.cuts.length} hard cuts (${m.cutsPer10s} per 10 s), ${m.shots.length} shots, shot length median ${m.shotLength.median}s (min ${m.shotLength.min}, max ${m.shotLength.max}). Soft transitions and whip pans are not detected as cuts.`,
          m.audio
            ? `- Audio: ${m.audio.lufs} LUFS integrated, LRA ${m.audio.lra}, true peak ${m.audio.truePeak} dBFS, ${Math.round(m.audio.quietShare * 100)}% of the time near silence.`
            : `- Audio: ${m.hasAudio ? "could not be measured" : "none"}.`,
          `- Measured cuts at: ${m.cuts.map((c) => `${c.t}s`).join(", ") || "none (one continuous shot or only soft transitions)"}.`,
          "",
          "## Cross-check summary",
          `- Per-shot checks: ${verified} verified, ${disputed} disputed, ${unverified} unverified. OCR: ${ocr}.`,
          ...(summaryFlags.length
            ? summaryFlags.map((f) => `- ${f}`)
            : ["- No whole-video contradictions found."]),
          "",
          "## Model's reading (a claim is only as good as its check)",
          `- Hook (first 3 s): ${merged.hook ?? "-"}`,
          `- Format type: ${merged.format_type ?? "-"}`,
          `- Structure: ${merged.structure ?? "-"}`,
          `- Pacing: ${merged.pacing ?? "-"}`,
          ...(merged.craft?.length
            ? ["- Craft details:", ...merged.craft.map((c) => `  - ${c}`)]
            : []),
          ...(merged.answer ? ["", `## Answer to your question`, merged.answer] : []),
          "",
          "## Shot by shot",
          ...all
            .flatMap(({ s, checks }, i) => [
              `${i + 1}. ${s.start}-${s.end}s | ${s.visual ?? ""}`,
              s.on_screen_text ? `   text: "${s.on_screen_text}"` : "",
              `   camera: ${s.camera ?? "-"} | transition in: ${s.transition ?? "-"}`,
              `   audio: ${s.audio ?? "-"}`,
              ...checks.map((c) => `   [${c.verdict.toUpperCase()}] ${c.note}`),
            ])
            .filter(Boolean),
          "",
          "## Frames to look at (claim -> frame)",
          ...evidence.map((e) => `- ${e.label}: ${e.claim} -> ${rel(e.file)}`),
          "",
          `Files: ${rel(join(outDir, "breakdown.json"))}, measured.json, shots-sheet.jpg (mid-frame of each shot), claims-sheet.jpg (frames at the claimed seconds). LOOK at the claims sheet before you cite anything, and check every DISPUTED line.`,
        ];
        const report = lines.join("\n");
        await writeFile(join(outDir, "breakdown.json"), {
          source: rel(src),
          model: chosen.id,
          watched: new Date().toISOString(),
          costUsd: spent,
          measured: m,
          breakdown: merged,
          checks: all.map(({ s, checks }, i) => ({
            shot: i + 1,
            start: s.start,
            end: s.end,
            checks,
          })),
          summaryFlags,
        });
        writeFileSync(join(outDir, "report.md"), `${report}\n`);
        if (board) {
          const lib = readLibrary(board);
          const item = lib.items.find((it) => resolve(abs(it.file)) === src);
          if (item) {
            item.watch = rel(join(outDir, "breakdown.json"));
            writeLibrary(lib);
          }
        }
        const content: Content[] = [{ type: "text", text: report }];
        content.push({ type: "image", data: shotSheet, mimeType: "image/jpeg" });
        if (evidenceSheet)
          content.push({ type: "image", data: evidenceSheet, mimeType: "image/jpeg" });
        return { content };
      } catch (error) {
        return fail(`media_watch failed: ${errText(error)}`);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
}

async function writeFile(file: string, data: unknown) {
  writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
}

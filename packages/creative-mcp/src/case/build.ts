// case_study_build: gather the logs, compute the numbers, write <project>/delivery/case-study/
// (numbers.json, CASE.md, case-study.html/.pdf, case-study.mp4). Everything is local.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { computeCase, fmtDuration, NOT_RECORDED, type CaseNumbers, type Range } from "./metrics.ts";
import {
  caseMarkdown,
  END_LINE,
  momentText,
  numberCards,
  redact,
  redactDeep,
  SPEC_LINE,
  storyMoments,
  type PresentOptions,
} from "./present.ts";
import {
  beforeAfterImage,
  cardHtml,
  fitDurations,
  hasChrome,
  hasFfmpeg,
  htmlToPdf,
  htmlToPng,
  pageHtml,
  pdfPages,
  probeVideo,
  renderVideo,
  type Segment,
  type VideoCard,
} from "./render.ts";
import {
  approvalMoments,
  defaultPaths,
  readDeliverables,
  readGoals,
  readJobs,
  readLedgerFile,
  readMoments,
  readTakes,
  readThreads,
  readThreadsAny,
  stateDbCandidates,
  type SourcePaths,
} from "./sources.ts";

export interface BuildOptions {
  project: string;
  title?: string | undefined;
  brief?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  threadIds?: string[] | undefined;
  agencyEstimateHours?: number | undefined;
  confidential?: boolean | undefined;
  relativeOnly?: boolean | undefined;
  clientNames?: string[] | undefined;
  spec?: boolean | undefined;
  /** none | 4x5 (1080×1350) | both (+ 1920×1080) */
  video?: "none" | "4x5" | "both" | undefined;
  pdf?: boolean | undefined;
  music?: string | undefined;
  paths?: Partial<SourcePaths> | undefined;
  /** threads left out (the thread building the case study, so its own turn/messages don't count) */
  excludeThreadIds?: string[] | undefined;
  now?: number | undefined;
}

export interface BuildResult {
  dir: string;
  files: string[];
  numbers: CaseNumbers;
  warnings: string[];
  video?: { file: string; seconds: number; width: number; height: number }[] | undefined;
}

const FRAME_RE = /\.(jpe?g|png)$/i;

/** Every file case_study_build writes into delivery/case-study/ (removed before a rebuild). */
const OUTPUT_FILES = [
  "numbers.json",
  "CASE.md",
  "case-study.html",
  "case-study.pdf",
  "case-study.mp4",
  "case-study-16x9.mp4",
  "before-after.jpg",
];

/** Process frames inside the range, evenly sampled down to at most `max`. */
export function timelapseFrames(project: string, range: Range | undefined, max = 360): string[] {
  const dir = NodePath.join(project, ".open-herness", "process-frames");
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((n) => FRAME_RE.test(n));
  } catch {
    return [];
  }
  const files = names
    .map((n) => ({ n, at: Number(n.match(/^(\d{10,})/)?.[1] ?? NaN) }))
    .filter((f) => Number.isFinite(f.at))
    .filter(
      (f) =>
        (range?.from === undefined || f.at >= range.from) &&
        (range?.to === undefined || f.at <= range.to),
    )
    .sort((a, b) => a.at - b.at)
    .map((f) => NodePath.join(dir, f.n));
  if (files.length <= max) return files;
  const step = files.length / max;
  return Array.from({ length: max }, (_, i) => files[Math.floor(i * step)]!);
}

const parseTime = (s?: string) => {
  if (!s) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new Error(`Not a date/time: ${s}`);
  return t;
};

export async function buildCaseStudy(o: BuildOptions): Promise<BuildResult> {
  const project = NodePath.resolve(o.project);
  const warnings: string[] = [];
  const paths = { ...defaultPaths(), ...o.paths };
  const range: Range | undefined =
    o.from || o.to ? { from: parseTime(o.from), to: parseTime(o.to) } : undefined;

  // 1. Gather
  const query = { project, threadIds: o.threadIds };
  const read = paths.stateDb
    ? readThreads(paths.stateDb, query)
    : readThreadsAny(stateDbCandidates(), query);
  const skip = new Set((o.excludeThreadIds ?? []).filter((id) => !o.threadIds?.includes(id)));
  const kept = read.threads.filter((t) => !skip.has(t.threadId));
  const threads =
    kept.length === read.threads.length || read.unavailable
      ? read
      : kept.length
        ? { ...read, threads: kept }
        : {
            ...read,
            threads: [],
            unavailable: "no threads besides the one building the case study",
          };
  if (threads.unavailable)
    warnings.push(`Thread data: ${threads.unavailable}. Time metrics are "not recorded".`);
  const jobs = readJobs(paths.jobsDir);
  const root = project.replace(/\/+$/, "");
  const threadIds = new Set<string>([
    ...threads.threads.map((t) => t.threadId),
    ...(o.threadIds ?? []),
    ...jobs
      .filter((j) => j.projectPath === root || j.projectPath.startsWith(`${root}/`))
      .flatMap((j) => [j.threadId, j.chatId].filter((x): x is string => !!x)),
  ]);
  const takes = readTakes(project);
  const numbers = computeCase(
    {
      project,
      ...(range ? { range } : {}),
      ...(o.threadIds?.length ? { threadIds: o.threadIds } : {}),
      jobs: { file: paths.jobsDir, records: jobs },
      ledger: { file: paths.ledgerFile, lines: readLedgerFile(paths.ledgerFile) },
      threads,
      takes,
      goals: {
        dir: paths.goalsDir,
        records: readGoals(
          paths.goalsDir,
          project,
          o.threadIds?.length ? new Set(o.threadIds) : threadIds,
        ),
      },
      moments: {
        file: NodePath.join(project, ".open-herness", "key-moments.jsonl"),
        records: [...readMoments(project), ...approvalMoments(threads)],
      },
      deliverables: readDeliverables(project, takes),
      ...(o.agencyEstimateHours ? { agencyEstimateHours: o.agencyEstimateHours } : {}),
    },
    o.now,
  );

  // 2. Words
  const firstMsg = threads.threads
    .flatMap((t) => t.userMessages)
    .filter((m) => m.text && (!range?.from || m.at >= range.from))
    .sort((a, b) => a.at - b.at)[0];
  const brief = plainContextLinks(o.brief ?? firstMsg?.text ?? "").trim();
  const briefSource = o.brief
    ? "Brief as edited by the agent/user."
    : firstMsg
      ? `First user message (${new Date(firstMsg.at).toISOString().slice(0, 10)}, server log ${firstMsg.id}).`
      : "Brief not recorded (no user message found); pass `brief`.";
  const folder = NodePath.basename(project);
  const names = [...(o.clientNames ?? []), ...(o.confidential ? [folder] : [])];
  const opts: PresentOptions = {
    title: o.title ?? (o.confidential ? "Client project" : folder),
    brief: brief.length > 700 ? `${brief.slice(0, 697)}…` : brief,
    briefSource,
    confidential: !!o.confidential,
    relativeOnly: !!o.relativeOnly,
    clientNames: names,
    spec: !!o.spec,
  };
  const r = (s: string) => redact(s, opts);

  if (o.confidential && !o.clientNames?.some((n) => n.trim().length > 1))
    warnings.push(
      "Confidential without clientNames: only the project folder name is redacted. Pass the client, brand and product names.",
    );
  if (o.confidential && hasBrandKit(project))
    warnings.push(
      "This project has a brand kit in brand/: its name rides along with every turn (<oh_brand name=…>). Make sure that name is in clientNames.",
    );

  // 3. Output folder. A rebuild replaces every file this tool writes, so nothing stale (an old
  // 16:9 cut, an unblurred before/after, absolute numbers) survives next to the new version.
  const dir = NodePath.join(project, "delivery", "case-study");
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const name of OUTPUT_FILES) NodeFS.rmSync(NodePath.join(dir, name), { force: true });
  const auditDir = NodePath.join(project, ".open-herness", "case-study");
  NodeFS.rmSync(NodePath.join(auditDir, "numbers.json"), { force: true });
  const files: string[] = [];
  const relOut = (p: string) => NodePath.relative(project, p);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-case-"));
  try {
    const frames = o.video === "none" ? [] : timelapseFrames(project, range);

    // 4. Before / after (first vs picked take)
    let beforeAfter: string | undefined;
    const picked = takes.takes.find((t) => t.id === takes.picked) ?? takes.takes.at(-1);
    const first = takes.takes[0];
    const abs = (f: string) => (NodePath.isAbsolute(f) ? f : NodePath.join(project, f));
    if (
      first &&
      picked &&
      first.id !== picked.id &&
      NodeFS.existsSync(abs(first.file)) &&
      NodeFS.existsSync(abs(picked.file))
    ) {
      if (hasFfmpeg()) {
        try {
          // confidential: the readable takes never land in delivery/ (the video blurs its copy)
          const out = NodePath.join(o.confidential ? scratch : dir, "before-after.jpg");
          await beforeAfterImage(abs(first.file), abs(picked.file), out);
          beforeAfter = out;
          if (!o.confidential) files.push(relOut(out));
        } catch (error) {
          warnings.push(`Before/after image failed: ${String(error).slice(0, 200)}`);
        }
      } else warnings.push("ffmpeg not found: no before/after image.");
    }
    const showBA = beforeAfter && !o.confidential ? beforeAfter : undefined;

    // 5. numbers.json + CASE.md. Relative-only: numbers.json holds the absolute $ and hours, so the
    // audit copy goes to .open-herness/case-study/ instead of delivery/.
    if (frames.length >= 2 && !o.confidential)
      warnings.push(
        "The process timelapse shows the recorded frames unblurred. Frames recorded by older builds of Record process include the sidebar (other projects' and threads' names) and any project opened while recording. Check a contact sheet, or rebuild with confidential: true (blurs them) or video: none.",
      );
    if (o.relativeOnly) NodeFS.mkdirSync(auditDir, { recursive: true });
    const numbersFile = NodePath.join(o.relativeOnly ? auditDir : dir, "numbers.json");
    const flags = {
      confidential: !!o.confidential,
      relativeOnly: !!o.relativeOnly,
      spec: !!o.spec,
    };
    NodeFS.writeFileSync(
      numbersFile,
      `${JSON.stringify(redactDeep({ ...numbers, flags, warnings }, opts, project), null, 2)}\n`,
    );
    if (!o.relativeOnly) files.unshift(relOut(numbersFile));
    const planned = [
      "delivery/case-study/case-study.pdf",
      ...(o.video !== "none" ? ["delivery/case-study/case-study.mp4"] : []),
    ];
    const caseFile = NodePath.join(dir, "CASE.md");
    NodeFS.writeFileSync(
      caseFile,
      caseMarkdown(numbers, opts, {
        ...(showBA ? { beforeAfter: NodePath.basename(showBA) } : {}),
        files: [
          ...(o.relativeOnly ? [] : ["numbers.json"]),
          ...planned.map((p) => NodePath.basename(p)),
        ],
      }),
    );
    files.unshift(relOut(caseFile));

    // 6. PDF
    const cards = numberCards(numbers, opts);
    const ds = numbers.deliverables.value;
    const htmlFile = NodePath.join(dir, "case-study.html");
    NodeFS.writeFileSync(
      htmlFile,
      pageHtml({
        title: r(opts.title),
        brief: r(opts.brief) || "Brief not recorded.",
        cards,
        deliverables:
          ds === NOT_RECORDED
            ? []
            : ds.map(
                (d) =>
                  `${r(NodePath.basename(d.file))} · ${[d.format.toUpperCase(), d.width ? `${d.width}×${d.height}` : "", d.durationSeconds ? `${d.durationSeconds}s` : ""].filter(Boolean).join(" ")}`,
              ),
        methodNotes: [
          o.relativeOnly
            ? "All numbers from Open Herness's local logs; sources per number in the audit copy of numbers.json (kept by the author)."
            : "All numbers from Open Herness's local logs; sources per number in numbers.json.",
          'Missing data shows as "not recorded", never estimated.',
          ...(numbers.agencyEstimate ? ["Agency time is the user's own estimate."] : []),
        ],
        ...(showBA ? { beforeAfter: NodePath.basename(showBA) } : {}),
        spec: !!o.spec,
        confidential: !!o.confidential,
        dateLine:
          numbers.time.wallClock.value !== NOT_RECORDED && !o.relativeOnly
            ? `${new Date(numbers.time.wallClock.value.startAt).toISOString().slice(0, 10)} → ${new Date(numbers.time.wallClock.value.endAt).toISOString().slice(0, 10)}`
            : o.relativeOnly
              ? "relative numbers"
              : new Date(numbers.generatedAt).toISOString().slice(0, 10),
      }),
    );
    files.push(relOut(htmlFile));
    if (o.pdf !== false) {
      if (hasChrome()) {
        const pdf = NodePath.join(dir, "case-study.pdf");
        try {
          await htmlToPdf(htmlFile, pdf);
          const pages = pdfPages(pdf);
          if (pages !== 1)
            warnings.push(`The PDF has ${pages} pages (expected 1); shorten the brief.`);
          files.push(relOut(pdf));
        } catch (error) {
          warnings.push(`PDF failed: ${String(error).slice(0, 200)}`);
        }
      } else warnings.push("Google Chrome not found: no PDF (case-study.html is there).");
    }

    // 7. Video
    const video: BuildResult["video"] = [];
    const formats: [number, number, string][] =
      o.video === "none"
        ? []
        : o.video === "both"
          ? [
              [1080, 1350, "case-study.mp4"],
              [1920, 1080, "case-study-16x9.mp4"],
            ]
          : [[1080, 1350, "case-study.mp4"]];
    if (formats.length && (!hasChrome() || !hasFfmpeg()))
      warnings.push("Video skipped: needs Google Chrome (cards) and ffmpeg.");
    else
      for (const [w, h, name] of formats) {
        try {
          const out = NodePath.join(dir, name);
          const v = await buildVideo({
            project,
            numbers,
            opts,
            cards,
            range,
            beforeAfter,
            w,
            h,
            out,
            music: o.music,
          });
          const p = probeVideo(out);
          video.push({
            file: relOut(out),
            seconds: p?.seconds ?? v.seconds,
            width: p?.width ?? w,
            height: p?.height ?? h,
          });
          files.push(relOut(out));
          if (v.note) warnings.push(v.note);
        } catch (error) {
          warnings.push(
            `Video ${name} failed: ${String((error as { stderr?: string }).stderr ?? error).slice(-300)}`,
          );
        }
      }
    return { dir, files, numbers, warnings, ...(video.length ? { video } : {}) };
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

async function buildVideo(a: {
  project: string;
  numbers: CaseNumbers;
  opts: PresentOptions;
  cards: ReturnType<typeof numberCards>;
  range?: Range | undefined;
  beforeAfter?: string | undefined;
  w: number;
  h: number;
  out: string;
  music?: string | undefined;
}): Promise<{ seconds: number; note?: string }> {
  const { numbers, opts, w, h } = a;
  const r = (s: string) => redact(s, opts);
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-case-cards-"));
  try {
    const planned: {
      card?: VideoCard;
      frames?: string[];
      image?: string;
      blur?: boolean;
      seconds: number;
    }[] = [];
    const timeLine =
      numbers.time.wallClock.value !== NOT_RECORDED && !opts.relativeOnly
        ? `${fmtDuration(numbers.time.wallClock.value.ms)} from first to last recorded activity`
        : undefined;
    planned.push({
      card: {
        kind: "title",
        kicker: opts.confidential ? "case study · confidential" : "case study",
        big: r(opts.title),
        ...(timeLine ? { note: timeLine } : {}),
        ...(opts.spec ? { label: SPEC_LINE } : {}),
      },
      seconds: 4,
    });
    const frames = timelapseFrames(a.project, a.range);
    if (frames.length >= 2) {
      planned.push({
        card: {
          kind: "label",
          kicker: "process",
          big: "the work",
          note: `${frames.length} frames of the Open Herness window, recorded while working`,
        },
        seconds: 2,
      });
      planned.push({
        frames,
        seconds: Math.min(14, Math.max(4, frames.length / 8)),
        blur: !!opts.confidential,
      });
    }
    for (const m of storyMoments(numbers.moments, 4)) {
      const t = momentText(m);
      planned.push({
        card: { kind: "moment", kicker: "key moment", big: t.big, label: r(t.label) },
        seconds: 3,
      });
    }
    if (a.beforeAfter) {
      planned.push({
        card: { kind: "label", kicker: "before → after", big: "first take → final" },
        seconds: 2,
      });
      planned.push({ image: a.beforeAfter, seconds: 5, blur: !!opts.confidential });
    }
    for (const c of a.cards.filter((c) => c.recorded).slice(0, 6))
      planned.push({
        card: {
          kind: "number",
          kicker: "the numbers",
          big: c.big,
          label: c.label,
          note: c.note,
          dark: true,
        },
        seconds: 3.5,
      });
    planned.push({ card: { kind: "end", big: END_LINE, dark: true }, seconds: 4 });

    const secs = fitDurations(planned.map((p) => p.seconds));
    const segments: Segment[] = [];
    for (const [i, p] of planned.entries()) {
      const seconds = secs[i]!;
      if (p.card) {
        const html = NodePath.join(tmp, `c${i}.html`);
        const png = NodePath.join(tmp, `c${i}.png`);
        NodeFS.writeFileSync(html, cardHtml(p.card, w, h));
        await htmlToPng(html, png, w, h);
        segments.push({ type: "image", file: png, seconds, fit: "cover" });
      } else if (p.frames)
        segments.push({ type: "frames", files: p.frames, seconds, blur: p.blur });
      else if (p.image)
        segments.push({ type: "image", file: p.image, seconds, blur: p.blur, fit: "contain" });
    }
    const v = await renderVideo(segments, a.out, w, h, a.music);
    return {
      seconds: v.seconds,
      ...(frames.length < 2
        ? {
            note: "No process frames recorded (turn on Record process in the desktop app); the video has no timelapse.",
          }
        : {}),
    };
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Composer chips are stored in the message text as `[Label](t3-context://v1/<kind>/<id>)` (files,
 * threads, "@" apps). In a brief they read as their label.
 */
export function plainContextLinks(text: string): string {
  return text.replace(/\[([^\]\n]*)\]\(t3-context:[^)\s]*\)/g, "$1");
}

/** Same markers the per-turn brand block reads: brand/NONE switches it off. */
function hasBrandKit(project: string): boolean {
  const dir = NodePath.join(project, "brand");
  try {
    if (NodeFS.existsSync(NodePath.join(dir, "NONE"))) return false;
    if (NodeFS.existsSync(NodePath.join(dir, "brand.md"))) return true;
    if (NodeFS.existsSync(NodePath.join(dir, "ACTIVE"))) return true;
    return NodeFS.readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && !e.name.startsWith("."),
    );
  } catch {
    return false;
  }
}

import * as DateTime from "effect/DateTime";

/**
 * Live generation status from creative-mcp tool results: status, ETA wording, time format and
 * slow threshold. The data comes from the text that creative-mcp `describe(job)` writes (packages/creative-mcp/src/media/jobs.ts), parsed here.
 */

export type GenerationJobState =
  | "waiting"
  | "preparing"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "cancelled";

const TERMINAL = new Set<GenerationJobState>(["completed", "failed", "uncertain", "cancelled"]);

export interface GenerationJobSnapshot {
  readonly id: string;
  readonly state: GenerationJobState;
  readonly model: string;
  readonly elapsedSeconds: number;
  readonly typicalSeconds: number | null;
  readonly p90Seconds: number | null;
  readonly detail: string | null;
  readonly outputs: ReadonlyArray<string>;
  /** When the tool result was produced (ms). */
  readonly observedAtMs: number;
}

// Tolerant of spacing and the separator glyph, so a wording tweak in describe() doesn't switch the
// cards off silently; a contract test feeds real describe() output through this parser.
const HEADER = /^\s*job\s+(\S+)\s+\[(\w+)\]\s+(\S+)(?:\s+(?:→|->)\s+\S+)?\s+[·|-]\s+(\d+)\s*s\b/;
const TYPICAL = /typicalSeconds\s*=\s*(\d+)/;
const P90 = /p90\s*=?\s*(\d+)\s*s?/;
const ELAPSED = /elapsed\s*=?\s*(\d+)\s*s/;
const KNOWN_LINE =
  /^(cost|cast|adjustments|retry of|warning|error|hint|alternative|code|attempts|draft|taking much longer)\b/i;

/** Pulls the text out of a tool output (string, MCP content array, or `{content}`). */
export function toolOutputText(output: unknown): string | null {
  if (typeof output === "string") return output;
  const content = Array.isArray(output)
    ? output
    : typeof output === "object" && output !== null && Array.isArray(Reflect.get(output, "content"))
      ? (Reflect.get(output, "content") as unknown[])
      : null;
  if (content === null) return null;
  const texts = content.flatMap((part) =>
    typeof part === "object" &&
    part !== null &&
    Reflect.get(part, "type") === "text" &&
    typeof Reflect.get(part, "text") === "string"
      ? [Reflect.get(part, "text") as string]
      : [],
  );
  return texts.length > 0 ? texts.join("\n") : null;
}

/** Every `job … [state] …` block in a creative-mcp result. */
export function parseGenerationJobs(text: string, observedAtMs: number): GenerationJobSnapshot[] {
  const jobs: GenerationJobSnapshot[] = [];
  let current:
    | {
        -readonly [K in keyof GenerationJobSnapshot]: GenerationJobSnapshot[K];
      }
    | null = null;
  const outputs: string[] = [];
  const flush = () => {
    if (current) jobs.push({ ...current, outputs: [...outputs] });
    current = null;
    outputs.length = 0;
  };
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      current = {
        id: header[1]!,
        state: header[2]!.toLowerCase() as GenerationJobState,
        model: header[3]!,
        elapsedSeconds: Number(header[4]),
        typicalSeconds: null,
        p90Seconds: null,
        detail: null,
        outputs: [],
        observedAtMs,
      };
      continue;
    }
    if (current === null) continue;
    const body = line.trim();
    // A block runs until the next `job` header: blank lines and unindented continuation lines
    // (a multi-line provider phase) stay inside it.
    if (body === "" || /^still running/i.test(body)) continue;
    const typical = TYPICAL.exec(body);
    if (typical) {
      current.typicalSeconds = Number(typical[1]);
      const p90 = P90.exec(body.slice(typical.index + typical[0].length));
      if (p90) current.p90Seconds = Number(p90[1]);
      const elapsed = ELAPSED.exec(body);
      if (elapsed) current.elapsedSeconds = Number(elapsed[1]);
    } else if (/^(→|->)\s/.test(body)) {
      outputs.push(body.replace(/^(→|->)\s+/, ""));
    } else if (current.typicalSeconds === null && !KNOWN_LINE.test(body)) {
      current.detail = current.detail === null ? body : `${current.detail} ${body}`;
    }
  }
  flush();
  return jobs;
}

export function isPendingGenerationJob(job: GenerationJobSnapshot): boolean {
  return !TERMINAL.has(job.state);
}

/** Latest snapshot per job id, in first-seen order. */
export function latestGenerationJobs(
  snapshots: ReadonlyArray<GenerationJobSnapshot>,
): GenerationJobSnapshot[] {
  const byId = new Map<string, GenerationJobSnapshot>();
  for (const snapshot of snapshots) byId.set(snapshot.id, snapshot);
  return [...byId.values()];
}

/** Durations as "under a min", "N min", "N hr", "H hr M min". */
export function formatGenerationDuration(seconds: number, rounding: "floor" | "round"): string {
  if (seconds < 60) return "under a min";
  const minutes = rounding === "floor" ? Math.floor(seconds / 60) : Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Provider phase text older than this reads as "last known". */
const PROVIDER_DETAIL_FRESH_MS = 60_000;

export interface GenerationStatusView {
  readonly status: string;
  readonly eta: string | null;
  readonly slow: boolean;
  readonly elapsedSeconds: number;
}

/**
 * The card's lines at `nowMs`. Elapsed keeps counting from the last observation. The slow line
 * shows once elapsed passes `slowAfter` (p90 × 1.5, or typical × 3 without p90) and
 * hides again once the job counts as stalled (past max(2 × typical, slowAfter)), when the agent
 * is told to stop and ask.
 */
export function generationStatusView(
  job: GenerationJobSnapshot,
  nowMs: number,
): GenerationStatusView {
  const elapsedSeconds = job.elapsedSeconds + Math.max(0, (nowMs - job.observedAtMs) / 1000);
  const waiting = job.state === "waiting" || job.state === "preparing" || job.state === "queued";
  const phase = waiting ? "Waiting in line" : "Generating";
  const stale = nowMs - job.observedAtMs > PROVIDER_DETAIL_FRESH_MS;
  const detail = job.detail ? (stale ? `Last known: ${job.detail}` : job.detail) : null;
  const status = [
    detail ? `${phase} · ${detail}` : phase,
    `${formatGenerationDuration(elapsedSeconds, "floor")} so far`,
  ].join(" · ");
  const typical = job.typicalSeconds;
  const p90 = job.p90Seconds;
  // creative-mcp does not say whether the typical time is learned or seeded, so it is worded as
  // an estimate.
  const eta =
    typical === null
      ? null
      : `${typical < 60 ? "Estimated at under a min" : `Estimated at about ${formatGenerationDuration(typical, "round")}`}${
          p90 !== null ? ` · most finish within ${formatGenerationDuration(p90, "round")}` : ""
        }`;
  const { slowAfter, stallAt } = generationSlowWindow(typical, p90);
  // Elapsed counts from submission, so a job still waiting in line is never called slow.
  const slow =
    !waiting &&
    slowAfter !== null &&
    stallAt !== null &&
    elapsedSeconds > slowAfter &&
    elapsedSeconds <= stallAt;
  return { status, eta, slow, elapsedSeconds };
}

/**
 * Slow window: slow after p90 × 1.5 (or typical × 3 without p90); for an estimated
 * (not learned) duration the stall point is typical × 10. creative-mcp never says whether its
 * timing is learned, and most are seeded, so the estimate rule applies.
 */
export function generationSlowWindow(
  typical: number | null,
  p90: number | null,
): { readonly slowAfter: number | null; readonly stallAt: number | null } {
  const slowAfter = p90 !== null ? p90 * 1.5 : typical !== null ? typical * 3 : null;
  if (slowAfter === null || typical === null) return { slowAfter, stallAt: null };
  return { slowAfter, stallAt: Math.max(typical * 10, slowAfter) };
}

/**
 * A snapshot nobody re-polled (agent stopped, app restarted) stops counting as pending after
 * max(p90 × 3, 30 min) from its observation, so a lost job can't tick forever.
 */
export function isStaleGenerationSnapshot(job: GenerationJobSnapshot, nowMs: number): boolean {
  const horizonMs = Math.max((job.p90Seconds ?? job.typicalSeconds ?? 0) * 3 * 1000, 30 * 60_000);
  return nowMs - job.observedAtMs > horizonMs;
}

const CREATIVE_JOB_TOOL =
  /^mcp__open-herness-creative__(media_generate|media_generate_batch|media_finish_draft|media_upscale|jobs_status|jobs_wait|jobs_retry|jobs_cancel)$/;

export function isGenerationJobTool(toolName: string | null | undefined): boolean {
  return toolName !== null && toolName !== undefined && CREATIVE_JOB_TOOL.test(toolName);
}

interface ScannedToolItem {
  readonly type: string;
  readonly toolName?: string | null;
  readonly status: string;
  readonly output?: unknown;
  readonly completedAt: DateTime.Utc | null;
}

/**
 * Job snapshots from the last `limit` creative-mcp job results, oldest first. Walks the items
 * from the end and stops early. Failed results count too: a failed or cancelled job ends there.
 */
export function recentGenerationSnapshots(
  items: ReadonlyArray<ScannedToolItem>,
  limit: number,
): GenerationJobSnapshot[] {
  const picked: ScannedToolItem[] = [];
  for (let index = items.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const item = items[index]!;
    if (item.type !== "dynamic_tool" || !isGenerationJobTool(item.toolName)) continue;
    if ((item.status !== "completed" && item.status !== "failed") || item.completedAt === null)
      continue;
    picked.push(item);
  }
  return picked.toReversed().flatMap((item) => {
    const text = toolOutputText(item.output);
    return text === null || item.completedAt === null
      ? []
      : parseGenerationJobs(text, DateTime.toEpochMillis(item.completedAt));
  });
}

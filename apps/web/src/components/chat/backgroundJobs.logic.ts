/**
 * Background job panel helpers: the latest output line of a task, the timer format, and the
 * panel layout (Running, then Finished with Clear, two-press stop).
 */

/** Only the tail of the output is read. */
const LAST_LINE_CHAR_CAP = 4096;

const ANSI_PATTERN =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * The last line of command output: ANSI and control characters removed, one trailing empty line
 * dropped, not trimmed. Null for binary output (contains NUL) or no output.
 */
export function lastOutputLine(output: string | null | undefined): string | null {
  if (!output) return null;
  let tail = output.length > LAST_LINE_CHAR_CAP ? output.slice(-LAST_LINE_CHAR_CAP) : output;
  if (tail.includes("\u0000")) return null;
  if (tail.length < output.length) {
    // The cut may land mid-line; drop the partial first line.
    const firstBreak = tail.search(/[\r\n]/);
    if (firstBreak !== -1) tail = tail.slice(firstBreak + 1);
  }
  const clean = tail.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
  const lines = clean.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const last = lines.at(-1) ?? "";
  return last === "" ? null : last;
}

/** `Ns`, `Mm SSs`, `Hh MMm`. */
export function formatJobElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export interface FinishedJob {
  readonly taskId: string;
  readonly label: string;
  readonly kind: string;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number;
}

export interface TrackedJob {
  readonly taskId: string;
  readonly label: string;
  readonly kind: string;
  readonly startedAtMs: number | null;
}

/**
 * Moves jobs that left the running list into the finished history (newest first). Returns the
 * same arrays when nothing changed.
 */
export function advanceJobHistory(
  previous: ReadonlyArray<TrackedJob>,
  running: ReadonlyArray<TrackedJob>,
  finished: ReadonlyArray<FinishedJob>,
  nowMs: number,
  limit = 20,
): { readonly running: ReadonlyArray<TrackedJob>; readonly finished: ReadonlyArray<FinishedJob> } {
  const runningIds = new Set(running.map((job) => job.taskId));
  const ended = previous.filter((job) => !runningIds.has(job.taskId));
  if (ended.length === 0) return { running, finished };
  const next = [
    ...ended.map((job) => ({ ...job, finishedAtMs: nowMs })),
    ...finished.filter((job) => !runningIds.has(job.taskId)),
  ].slice(0, limit);
  return { running, finished: next };
}

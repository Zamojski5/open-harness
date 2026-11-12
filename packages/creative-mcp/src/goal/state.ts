// Quality goals: one per thread, held by the Stop hook until the bar is met or a limit is hit.
// Shared by the creative MCP tools (set, review, end) and the server's Stop hook through one file.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const GOAL_LIMITS = {
  defaultTarget: 8,
  defaultHours: 8,
  maxHours: 24,
  reviewsKept: 40,
  plateauReviews: 3,
  holdsWithoutReview: 2,
  goalsKept: 256,
  expiryGraceMs: 3_600_000,
  /** Bounds subscription use per goal beyond the time budget. */
  maxReviews: 12,
  maxHolds: 24,
  /** Ours: a review must beat the earlier best by this much to count as improving. */
  minImprovement: 0.5,
} as const;

export type GoalStatus = "active" | "met" | "out_of_budget" | "plateau" | "ended";
export type GoalLimit = "time" | "spend" | "plateau" | "reviews" | "holds";

export interface GoalReview {
  at: number;
  score: number;
  meetsBar: boolean;
  gaps: string[];
  work: string[];
}

export interface QualityGoal {
  threadId: string;
  objective: string;
  criteria: string[];
  references: string[];
  target: number;
  startedAt: number;
  deadlineAt: number;
  spendLimitUsd?: number;
  status: GoalStatus;
  reviews: GoalReview[];
  holdsSinceReview: number;
  endReason?: string;
  wrapUpToldAt?: number;
  holdsTurnId?: string;
  /** Holds over the goal's whole life (holdsSinceReview resets per turn and per review). */
  holdsTotal?: number;
}

export interface GoalContext {
  now: number;
  spentUsd: number;
  runningJobs: number;
}

export type StopDecision =
  | { kind: "allow" }
  | { kind: "continue"; reason: string }
  | { kind: "wrap_up"; reason: string };

const ohHome = () =>
  process.env.OPEN_HERNESS_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");

/** One file per thread, so threads never overwrite each other's goals. */
export function goalsDir(): string {
  return NodePath.join(ohHome(), "quality-goals");
}

const segment = (threadId: string) =>
  threadId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "_";
/** The file that holds the thread's goal. */
export const goalPath = (threadId: string) =>
  NodePath.join(goalsDir(), `${segment(threadId)}.json`);

const isReview = (value: unknown): value is GoalReview => {
  const r = value as GoalReview;
  return (
    !!r &&
    typeof r.at === "number" &&
    typeof r.score === "number" &&
    typeof r.meetsBar === "boolean" &&
    Array.isArray(r.gaps) &&
    Array.isArray(r.work)
  );
};

/** A goal record, with malformed reviews dropped one by one. */
function decodeGoal(value: unknown): QualityGoal | undefined {
  const g = value as QualityGoal;
  if (
    !g ||
    typeof g.threadId !== "string" ||
    typeof g.objective !== "string" ||
    !Array.isArray(g.criteria) ||
    !Array.isArray(g.references) ||
    typeof g.target !== "number" ||
    typeof g.startedAt !== "number" ||
    typeof g.deadlineAt !== "number" ||
    !["active", "met", "out_of_budget", "plateau", "ended"].includes(g.status)
  )
    return undefined;
  return {
    ...g,
    reviews: Array.isArray(g.reviews) ? g.reviews.filter(isReview) : [],
    holdsSinceReview: Number.isFinite(g.holdsSinceReview) ? g.holdsSinceReview : 0,
  };
}

/** Earlier goals of the thread, one JSON per line (case studies report every goal, not just the last). */
export const goalHistoryPath = (threadId: string) =>
  NodePath.join(goalsDir(), `${segment(threadId)}.history.jsonl`);

/** Keep the goal being replaced (best effort: history must never block a new goal). */
function archiveGoal(goal: QualityGoal) {
  try {
    NodeFS.mkdirSync(goalsDir(), { recursive: true });
    NodeFS.appendFileSync(goalHistoryPath(goal.threadId), `${JSON.stringify(goal)}\n`);
  } catch {
    // best effort
  }
}

/** Atomic write (a .partial file renamed over the old one); false when it could not be written. */
function writeGoal(goal: QualityGoal): boolean {
  const file = goalPath(goal.threadId);
  const partial = `${file}.${process.pid}.partial`;
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(partial, JSON.stringify(goal, null, 1));
    NodeFS.renameSync(partial, file);
    return true;
  } catch {
    NodeFS.rmSync(partial, { force: true });
    return false;
  }
}

/** The thread's goal; an active goal past its deadline plus 1 h grace is closed on read. */
export function getGoal(threadId: string, now = Date.now()): QualityGoal | undefined {
  let goal: QualityGoal | undefined;
  try {
    goal = decodeGoal(JSON.parse(NodeFS.readFileSync(goalPath(threadId), "utf8")));
  } catch {
    return undefined;
  }
  if (goal?.status === "active" && now > goal.deadlineAt + GOAL_LIMITS.expiryGraceMs) {
    goal = {
      ...goal,
      status: "out_of_budget",
      endReason: "The time budget ran out while nobody was in the conversation.",
    };
    writeGoal(goal);
  }
  return goal;
}

/** Every saved goal, newest first (for tests and housekeeping). */
export function loadGoals(now = Date.now()): QualityGoal[] {
  let names: string[];
  try {
    names = NodeFS.readdirSync(goalsDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => name.slice(0, -".json".length))
    .flatMap((name) => {
      const goal = getGoal(name, now);
      return goal ? [goal] : [];
    });
}

/** Saves the goal and keeps at most goalsKept goal files (oldest by modification time go). */
export function touchGoal(goal: QualityGoal, _now = Date.now()): QualityGoal {
  writeGoal(goal);
  try {
    const dir = goalsDir();
    const files = NodeFS.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, mtimeMs: NodeFS.statSync(NodePath.join(dir, name)).mtimeMs }));
    if (files.length > GOAL_LIMITS.goalsKept)
      for (const file of files
        .toSorted((x, y) => x.mtimeMs - y.mtimeMs)
        .slice(0, files.length - GOAL_LIMITS.goalsKept))
        NodeFS.rmSync(NodePath.join(dir, file.name), { force: true });
  } catch {
    // housekeeping only
  }
  return goal;
}

/**
 * Applies `change` to the goal as saved now, only while it is still the same open goal (same
 * start, still active). A goal someone ended or replaced in the meantime is never brought back.
 */
function updateOpenGoal(
  threadId: string,
  startedAt: number,
  change: (goal: QualityGoal) => QualityGoal,
  now: number,
): QualityGoal | undefined {
  const current = getGoal(threadId, now);
  if (!current || current.status !== "active" || current.startedAt !== startedAt) return undefined;
  return touchGoal(change(current), now);
}

/** Closes the thread's goal (goal_end, or the user's /goal clear). */
export function endGoal(
  threadId: string,
  status: Exclude<GoalStatus, "active">,
  reason: string,
  now = Date.now(),
): QualityGoal | undefined {
  const goal = getGoal(threadId, now);
  if (!goal || (goal.status !== "active" && goal.status !== "met")) return undefined;
  return touchGoal({ ...goal, status, endReason: reason }, now);
}

export interface SetGoalInput {
  threadId: string;
  objective: string;
  criteria: string[];
  references: string[];
  target?: number;
  hours?: number;
  spendLimitUsd?: number;
}

/** A new goal (or a reset of the thread's goal): new budget, new deadline, holds cleared. */
export function setGoal(input: SetGoalInput, now = Date.now()): QualityGoal {
  const previous = getGoal(input.threadId, now);
  if (previous) archiveGoal(previous);
  const hours = Math.min(GOAL_LIMITS.maxHours, input.hours ?? GOAL_LIMITS.defaultHours);
  return touchGoal(
    {
      threadId: input.threadId,
      objective: input.objective,
      criteria: input.criteria,
      references: input.references,
      target: input.target ?? GOAL_LIMITS.defaultTarget,
      startedAt: now,
      deadlineAt: now + hours * 3_600_000,
      ...(input.spendLimitUsd === undefined ? {} : { spendLimitUsd: input.spendLimitUsd }),
      status: "active",
      reviews: previous?.reviews ?? [],
      holdsSinceReview: 0,
    },
    now,
  );
}

/** Reviews of the goal as last set; older ones judged another bar or budget. */
export function currentReviews(goal: QualityGoal): GoalReview[] {
  return goal.reviews.filter((review) => review.at >= goal.startedAt);
}

export function recordReview(
  threadId: string,
  review: GoalReview,
  now = Date.now(),
): QualityGoal | undefined {
  const goal = getGoal(threadId, now);
  if (!goal || (goal.status !== "active" && goal.status !== "met")) return undefined;
  const met = review.meetsBar && review.score >= goal.target;
  return touchGoal(
    {
      ...goal,
      reviews: [...goal.reviews, review].slice(-GOAL_LIMITS.reviewsKept),
      holdsSinceReview: 0,
      ...(met && goal.status === "active" ? { status: "met" as const } : {}),
    },
    now,
  );
}

export function plateaued(goal: QualityGoal): boolean {
  const current = currentReviews(goal);
  const recent = current.slice(-GOAL_LIMITS.plateauReviews);
  const earlier = current.slice(0, -GOAL_LIMITS.plateauReviews);
  if (recent.length < GOAL_LIMITS.plateauReviews || earlier.length === 0) return false;
  const best = Math.max(...earlier.map((review) => review.score));
  return recent.every((review) => review.score < best + GOAL_LIMITS.minImprovement);
}

function budgetReached(goal: QualityGoal, context: GoalContext): GoalLimit | undefined {
  if (context.now >= goal.deadlineAt) return "time";
  if (
    goal.spendLimitUsd !== undefined &&
    (goal.spendLimitUsd === 0 ? context.spentUsd > 0 : context.spentUsd >= goal.spendLimitUsd)
  )
    return "spend";
  return undefined;
}

/** The limit that ends iterating now, if any: time, then spend, then a score plateau. */
export function goalLimit(goal: QualityGoal, context: GoalContext): GoalLimit | undefined {
  return (
    budgetReached(goal, context) ??
    (plateaued(goal) ? "plateau" : undefined) ??
    (currentReviews(goal).length >= GOAL_LIMITS.maxReviews ? "reviews" : undefined) ??
    ((goal.holdsTotal ?? 0) >= GOAL_LIMITS.maxHolds ? "holds" : undefined)
  );
}

const latestOf = (goal: QualityGoal) => currentReviews(goal).at(-1);

function continueReason(goal: QualityGoal): string {
  const latest = latestOf(goal);
  const head = `Quality goal still open: "${goal.objective}" (bar: ${goal.target}/10).`;
  const body = latest
    ? [
        `The last review scored ${latest.score}/10. Fix the gaps that matter most, show the new version, then run goal_review on it again.`,
        ...latest.gaps.slice(0, 6).map((gap) => `- ${gap}`),
      ].join("\n")
    : "Nothing has been reviewed yet. Keep working, show the result, then score it with goal_review. Finishing the technical steps does not mean the goal is met.";
  return [
    head,
    body,
    'If the user asked you to stop, call goal_end with status "ended" and quote their words. If a decision only the user can make blocks you, ask them with the question tool.',
  ].join("\n");
}

function wrapUpReason(goal: QualityGoal, limit: GoalLimit): string {
  const latest = latestOf(goal);
  const why = {
    time: "the time budget is used up",
    spend: `the spend cap of $${goal.spendLimitUsd} is reached`,
    plateau: `the last ${GOAL_LIMITS.plateauReviews} reviews did not beat the earlier best score by ${GOAL_LIMITS.minImprovement} or more`,
    reviews: `${GOAL_LIMITS.maxReviews} reviews have been used on this goal`,
    holds: "the turn has been held the maximum number of times for this goal",
  }[limit];
  return [
    `Stop iterating on "${goal.objective}": ${why}.`,
    `Show the strongest version, give its latest score${latest ? ` (${latest.score}/10)` : ""} against the bar of ${goal.target}/10, say what still falls short and what would close the gap, then call goal_end with status "${limit === "plateau" ? "plateau" : "out_of_budget"}".`,
  ].join("\n");
}

/** One line for tool results while a limit applies. */
export function wrapUpNote(goal: QualityGoal, context: GoalContext): string | undefined {
  const limit = goalLimit(goal, context);
  return limit === undefined ? undefined : wrapUpReason(goal, limit);
}

/**
 * Stop-hook decision, in order: no active goal or running media jobs let the turn end; a limit
 * blocks once with a wrap-up instruction and then lets go; two holds without a new review let
 * go; otherwise the turn is held with what is still missing.
 */
export function decideStop(goal: QualityGoal | undefined, context: GoalContext): StopDecision {
  if (!goal || goal.status !== "active") return { kind: "allow" };
  if (context.runningJobs > 0) return { kind: "allow" };
  const limit = goalLimit(goal, context);
  if (limit !== undefined) {
    if (goal.wrapUpToldAt !== undefined) return { kind: "allow" };
    return { kind: "wrap_up", reason: wrapUpReason(goal, limit) };
  }
  if (goal.holdsSinceReview >= GOAL_LIMITS.holdsWithoutReview) return { kind: "allow" };
  return { kind: "continue", reason: continueReason(goal) };
}

/** Applies the Stop hook to the saved goal and records what it did. Returns the block reason. */
export function stopHold(
  threadId: string,
  turnId: string | undefined,
  context: Omit<GoalContext, "now">,
  now = Date.now(),
): string | undefined {
  const saved = getGoal(threadId, now);
  if (!saved || saved.status !== "active") return undefined;
  const goal =
    turnId !== undefined && turnId !== saved.holdsTurnId
      ? { ...saved, holdsTurnId: turnId, holdsSinceReview: 0 }
      : saved;
  const decision = decideStop(goal, { ...context, now });
  // Re-read before writing: a goal ended or replaced meanwhile is left as it is.
  const saved2 = updateOpenGoal(
    threadId,
    saved.startedAt,
    (current) => {
      const base =
        turnId !== undefined && turnId !== current.holdsTurnId
          ? { ...current, holdsTurnId: turnId, holdsSinceReview: 0 }
          : current;
      if (decision.kind === "allow") return base;
      return decision.kind === "wrap_up"
        ? { ...base, wrapUpToldAt: now, holdsTotal: (base.holdsTotal ?? 0) + 1 }
        : {
            ...base,
            holdsSinceReview: base.holdsSinceReview + 1,
            holdsTotal: (base.holdsTotal ?? 0) + 1,
          };
    },
    now,
  );
  if (decision.kind === "allow" || saved2 === undefined) return undefined;
  return decision.reason;
}

export interface GoalSummary {
  status: GoalStatus;
  objective: string;
  target: number;
  minutesLeft: number;
  spendLimitUsd?: number;
  spentUsd: number;
  latestScore?: number;
  bestScore?: number;
  reviews: number;
  stopIterating?: string;
}

export function summarize(goal: QualityGoal, context: GoalContext): GoalSummary {
  const current = currentReviews(goal);
  const note = goal.status === "active" ? wrapUpNote(goal, context) : undefined;
  return {
    status: goal.status,
    objective: goal.objective,
    target: goal.target,
    minutesLeft: Math.max(0, Math.round((goal.deadlineAt - context.now) / 60_000)),
    ...(goal.spendLimitUsd === undefined ? {} : { spendLimitUsd: goal.spendLimitUsd }),
    spentUsd: Math.round(context.spentUsd * 100) / 100,
    ...(current.length
      ? {
          latestScore: current.at(-1)!.score,
          bestScore: Math.max(...current.map((review) => review.score)),
        }
      : {}),
    reviews: current.length,
    ...(note ? { stopIterating: note } : {}),
  };
}

/** Running media jobs and estimated spend of this thread since the goal started. */
export function jobsFor(
  threadId: string,
  since: number,
  now = Date.now(),
): { runningJobs: number; spentUsd: number } {
  const dir = NodePath.join(NodeOS.homedir(), ".open-herness", "media", "jobs");
  const jobsDir = process.env.OH_MEDIA_JOBS_DIR || dir;
  let files: string[];
  try {
    files = NodeFS.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { runningJobs: 0, spentUsd: 0 };
  }
  const settled = new Set(["completed", "failed", "cancelled", "uncertain"]);
  let runningJobs = 0;
  let spentUsd = 0;
  for (const file of files) {
    let job: {
      threadId?: string;
      state?: string;
      createdAt?: number;
      startedAt?: number;
      submittedAt?: number;
      finishedAt?: number;
      estimate?: { usd?: number | null; usdMax?: number | null };
    };
    try {
      job = JSON.parse(NodeFS.readFileSync(NodePath.join(jobsDir, file), "utf8"));
    } catch {
      continue;
    }
    if (job.threadId !== threadId) continue;
    const updated = job.finishedAt ?? job.submittedAt ?? job.startedAt ?? job.createdAt ?? 0;
    if (!settled.has(job.state ?? "") && now - updated < 86_400_000) runningJobs += 1;
    if ((job.createdAt ?? 0) < since) continue;
    // A failed job the provider never accepted and a cancelled job that never started cost nothing.
    if (job.state === "failed" && job.submittedAt === undefined) continue;
    if (job.state === "cancelled" && job.startedAt === undefined) continue;
    spentUsd += job.estimate?.usd ?? job.estimate?.usdMax ?? 0;
  }
  return { runningJobs, spentUsd };
}

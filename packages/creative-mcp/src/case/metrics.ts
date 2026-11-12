// Case-study metrics: pure functions over what Open Herness already logs (spend ledger v2, media
// jobs, the take ledger, quality goals, thread/turn activity, key moments). Every number carries
// its sources (log file + entry ids). Missing data is reported as "not recorded", never guessed.

import { groupOf, quoteRoute, routeOf } from "../media/catalog.ts";
import type { LedgerLine } from "../media/ledger.ts";
import type { GenerateRequest } from "../media/providers.ts";

export const NOT_RECORDED = "not recorded" as const;
export type Maybe<T> = T | typeof NOT_RECORDED;

/** Where a number came from: a log file and the entries in it. */
export interface Source {
  file: string;
  ids: string[];
  note?: string | undefined;
}

export interface Metric<T> {
  value: Maybe<T>;
  sources: Source[];
  method?: string | undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// Inputs (what the readers in sources.ts hand over)

/** The subset of a media job record (~/.open-herness/media/jobs/<id>.json) the metrics read. */
export interface JobRecord {
  id: string;
  projectPath: string;
  threadId?: string | undefined;
  chatId?: string | undefined;
  model: string;
  kind: string;
  title?: string | undefined;
  state: string;
  request: GenerateRequest;
  served?: { provider: string; model: string; endpoint: string } | undefined;
  outputs?: string[] | undefined;
  estimate?: { usd: number | null; usdMax: number | null } | undefined;
  chargeUsd?: number | undefined;
  reservationKey?: string | undefined;
  draft?: { id: string; provider: string; model: string; seconds: number } | undefined;
  createdAt: number;
  finishedAt?: number | undefined;
}

export interface TurnRecord {
  turnId: string;
  startedAt: number;
  /** undefined = still running or never closed (not counted as active time) */
  endedAt?: number | undefined;
}

export interface ApprovalRecord {
  id: string;
  requestedAt: number;
  resolvedAt?: number | undefined;
  decision?: string | undefined;
}

export interface ThreadRecord {
  threadId: string;
  title?: string | undefined;
  createdAt?: number | undefined;
  turns: TurnRecord[];
  /** timestamps of the user's messages */
  userMessages: { id: string; at: number; text?: string }[];
  approvals: ApprovalRecord[];
  toolCalls?: number | undefined;
}

export interface ThreadsInput {
  /** where the thread data came from (e.g. the server's state.sqlite); undefined = unavailable */
  file?: string | undefined;
  /** why thread data is missing, when it is */
  unavailable?: string | undefined;
  threads: ThreadRecord[];
}

export interface TakeRecord {
  id: string;
  file: string;
  note?: string | undefined;
  score?: number | undefined;
  added: string;
}

export interface TakesInput {
  file: string;
  picked?: string | undefined;
  takes: TakeRecord[];
}

export interface GoalReviewRecord {
  at: number;
  score: number;
  meetsBar: boolean;
  work: string[];
}

export interface GoalRecord {
  file: string;
  threadId: string;
  objective: string;
  target: number;
  startedAt: number;
  status: string;
  endReason?: string | undefined;
  reviews: GoalReviewRecord[];
}

export interface KeyMoment {
  at: number;
  kind: "score_change" | "take_picked" | "approval_accepted" | "deliverable_presented";
  label: string;
  /** e.g. { from: 6, to: 8 } for a score change, { take: "t3", file } for a pick */
  data?: Record<string, unknown> | undefined;
  source?: string | undefined;
}

export interface DeliverableRecord {
  file: string;
  format: string;
  width?: number | undefined;
  height?: number | undefined;
  durationSeconds?: number | undefined;
  bytes?: number | undefined;
}

export interface Range {
  from?: number | undefined;
  to?: number | undefined;
}

export interface CaseInputs {
  project: string;
  range?: Range | undefined;
  /** only these threads (undefined = all threads of the project) */
  threadIds?: string[] | undefined;
  jobs: { file: string; records: JobRecord[] };
  ledger: { file: string; lines: LedgerLine[] };
  threads: ThreadsInput;
  takes: TakesInput;
  goals: { dir: string; records: GoalRecord[] };
  moments: { file: string; records: KeyMoment[] };
  deliverables: { dir: string; records: DeliverableRecord[] };
  /** the user's own estimate of how long an agency would need (hours); shown only when given */
  agencyEstimateHours?: number | undefined;
}

// Time

const inRange = (at: number, range?: Range) =>
  (range?.from === undefined || at >= range.from) && (range?.to === undefined || at <= range.to);

/** Turns clipped to the range; open turns are dropped (their end is not recorded). */
function closedTurns(threads: ThreadRecord[], range?: Range) {
  const out: { threadId: string; turnId: string; start: number; end: number }[] = [];
  for (const t of threads)
    for (const turn of t.turns) {
      if (turn.endedAt === undefined || turn.endedAt < turn.startedAt) continue;
      const start = Math.max(turn.startedAt, range?.from ?? -Infinity);
      const end = Math.min(turn.endedAt, range?.to ?? Infinity);
      if (end > start) out.push({ threadId: t.threadId, turnId: turn.turnId, start, end });
    }
  return out;
}

/** Max number of threads with a turn running at the same instant, and when that was. */
export function maxConcurrency(turns: { threadId: string; start: number; end: number }[]): {
  max: number;
  at?: number | undefined;
  threads: string[];
} {
  const events: { at: number; d: 1 | -1; threadId: string }[] = [];
  for (const t of turns) {
    events.push({ at: t.start, d: 1, threadId: t.threadId });
    events.push({ at: t.end, d: -1, threadId: t.threadId });
  }
  // ends before starts at the same instant: back-to-back turns do not overlap
  events.sort((a, b) => a.at - b.at || a.d - b.d);
  const open = new Map<string, number>();
  let best = { max: 0, at: undefined as number | undefined, threads: [] as string[] };
  for (const e of events) {
    open.set(e.threadId, (open.get(e.threadId) ?? 0) + e.d);
    if (!open.get(e.threadId)) open.delete(e.threadId);
    if (open.size > best.max) best = { max: open.size, at: e.at, threads: [...open.keys()] };
  }
  return best;
}

/** Length of the union of intervals (wall time during which at least one agent worked). */
export function unionMs(intervals: { start: number; end: number }[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: { start: number; end: number } | undefined;
  for (const i of sorted) {
    if (!cur || i.start > cur.end) {
      if (cur) total += cur.end - cur.start;
      cur = { ...i };
    } else cur.end = Math.max(cur.end, i.end);
  }
  if (cur) total += cur.end - cur.start;
  return total;
}

export interface TimeMetrics {
  wallClock: Metric<{ startAt: number; endAt: number; ms: number }>;
  activeAgent: Metric<{ ms: number; turns: number; unionMs: number }>;
  threads: Metric<{ count: number; titles: string[] }>;
  maxConcurrency: Metric<{ threads: number; at?: number; ids: string[] }>;
  openTurnsSkipped: number;
}

export function timeMetrics(input: CaseInputs): TimeMetrics {
  const { threads, range } = input;
  const file = threads.file ?? "server state";
  const none = <T>(why: string): Metric<T> => ({
    value: NOT_RECORDED,
    sources: [{ file, ids: [], note: why }],
  });
  if (threads.unavailable || !threads.file) {
    const why = threads.unavailable ?? "thread data unavailable";
    return {
      wallClock: none(why),
      activeAgent: none(why),
      threads: none(why),
      maxConcurrency: none(why),
      openTurnsSkipped: 0,
    };
  }
  const turns = closedTurns(threads.threads, range);
  // with a range, only threads that had a turn or a user message in it
  const list = range
    ? threads.threads.filter(
        (t) =>
          turns.some((x) => x.threadId === t.threadId) ||
          t.userMessages.some((m) => inRange(m.at, range)) ||
          t.turns.some((x) => x.endedAt === undefined && inRange(x.startedAt, range)),
      )
    : threads.threads;
  const openTurnsSkipped = list.reduce(
    (n, t) =>
      n + t.turns.filter((x) => x.endedAt === undefined && inRange(x.startedAt, range)).length,
    0,
  );
  let first = Infinity;
  let last = -Infinity;
  const stamp = (at: number) => {
    if (at < first) first = at;
    if (at > last) last = at;
  };
  for (const t of turns) {
    stamp(t.start);
    stamp(t.end);
  }
  for (const t of list) for (const m of t.userMessages) if (inRange(m.at, range)) stamp(m.at);
  const turnIds = turns.map((t) => `${t.threadId}/${t.turnId}`);
  const conc = maxConcurrency(turns);
  return {
    wallClock: Number.isFinite(first)
      ? {
          value: { startAt: first, endAt: last, ms: last - first },
          sources: [{ file, ids: turnIds.slice(0, 50), note: "first to last turn/user message" }],
          method: "From the first recorded turn start or user message to the last turn end.",
        }
      : none("no turns or messages in range"),
    activeAgent: turns.length
      ? {
          value: {
            ms: turns.reduce((s, t) => s + (t.end - t.start), 0),
            turns: turns.length,
            unionMs: unionMs(turns),
          },
          sources: [{ file, ids: turnIds }],
          method:
            "Sum of closed turn durations (start → completion, including any wait for approvals inside a turn) across threads; unionMs counts overlapping turns once. Turns without a reliable end are skipped and counted: still running, or interrupted (stopped by the user, or found dead after a restart, when the server stamps the end at the moment it noticed, possibly days later; the two cannot be told apart, so both are left out).",
        }
      : none("no closed turns in range"),
    threads: {
      value: { count: list.length, titles: list.map((t) => t.title ?? t.threadId) },
      sources: [{ file, ids: list.map((t) => t.threadId) }],
    },
    maxConcurrency: turns.length
      ? {
          value: { threads: conc.max, ...(conc.at ? { at: conc.at } : {}), ids: conc.threads },
          sources: [{ file, ids: turnIds }],
          method: "Sweep over turn start/end times: most threads with a turn running at once.",
        }
      : none("no closed turns in range"),
    openTurnsSkipped,
  };
}

// Human time

export interface HumanMetrics {
  userMessages: Metric<number>;
  approvalWait: Metric<{ ms: number; approvals: number; unresolved: number }>;
}

export function humanMetrics(input: CaseInputs): HumanMetrics {
  const { threads, range } = input;
  const file = threads.file ?? "server state";
  if (threads.unavailable || !threads.file) {
    const why = threads.unavailable ?? "thread data unavailable";
    return {
      userMessages: { value: NOT_RECORDED, sources: [{ file, ids: [], note: why }] },
      approvalWait: { value: NOT_RECORDED, sources: [{ file, ids: [], note: why }] },
    };
  }
  const msgs = threads.threads.flatMap((t) => t.userMessages.filter((m) => inRange(m.at, range)));
  const approvals = threads.threads.flatMap((t) =>
    t.approvals.filter((a) => inRange(a.requestedAt, range)),
  );
  const resolved = approvals.filter(
    (a) => a.resolvedAt !== undefined && a.resolvedAt >= a.requestedAt,
  );
  return {
    userMessages: {
      value: msgs.length,
      sources: [{ file, ids: msgs.map((m) => m.id) }],
    },
    approvalWait: approvals.length
      ? {
          value: {
            ms: resolved.reduce((s, a) => s + (a.resolvedAt! - a.requestedAt), 0),
            approvals: resolved.length,
            unresolved: approvals.length - resolved.length,
          },
          sources: [{ file, ids: approvals.map((a) => a.id) }],
          method:
            "Sum over approval requests of (resolved − requested). Unresolved requests are counted separately, not as time.",
        }
      : {
          value: NOT_RECORDED,
          sources: [{ file, ids: [], note: "no approval requests recorded in range" }],
        },
  };
}

// Generation spend

export type JobRole = "draft" | "finish" | "standard";
export const roleOf = (job: JobRecord): JobRole =>
  job.request.finishDraft
    ? "finish"
    : job.request.parameters?.draft === true
      ? "draft"
      : "standard";

/** The latest ledger line for a job (keyed by job id, or the batch slot it took over). */
function ledgerFor(job: JobRecord, latest: Map<string, LedgerLine>): LedgerLine | undefined {
  return latest.get(job.id) ?? (job.reservationKey ? latest.get(job.reservationKey) : undefined);
}

/** What the ledger counts for a line: released = 0, spent = charge (else worst case). */
function countedUsd(l: LedgerLine): number | null {
  if (l.state === "released") return 0;
  if (l.state === "spent") return l.chargeUsd ?? l.maxUsd ?? l.estimateUsd;
  return l.maxUsd ?? l.estimateUsd;
}

export interface JobSpend {
  jobId: string;
  model: string;
  route: string;
  role: JobRole;
  /** USD the ledger counts for it; NOT_RECORDED = no ledger line, or a line with no price */
  usd: Maybe<number>;
  /** true when usd is the reserved worst case, not a reported charge */
  worstCase: boolean;
  basis: string;
}

export interface SpendBucket {
  key: string;
  usd: number;
  jobs: number;
  notRecorded: number;
}

export interface CounterfactualRow {
  draftJob: string;
  route: string;
  seconds: number | null;
  fullQualityUsd: Maybe<number>;
  rate: string;
}

export interface SpendMetrics {
  jobs: JobSpend[];
  total: Metric<{
    usd: number;
    jobsCounted: number;
    jobsNotRecorded: number;
    /** jobs counted at the reserved worst case because no charge was reported */
    jobsWorstCase: number;
  }>;
  byRoute: SpendBucket[];
  byRole: SpendBucket[];
  withoutDrafts: Metric<{
    actualUsd: number;
    counterfactualUsd: number;
    /** negative = drafting cost more than rendering every take at full quality */
    savedUsd: number;
    /** draft/finish jobs whose actual cost is the reserved worst case (no reported charge) */
    worstCaseJobs: number;
    rows: CounterfactualRow[];
  }>;
  cheapestRoute: Metric<{
    defaultUsd: number;
    servedUsd: number;
    savedUsd: number;
    rows: {
      jobId: string;
      defaultRoute: string;
      servedRoute: string;
      defaultUsd: number;
      servedUsd: number;
    }[];
  }>;
}

const routeName = (job: JobRecord) =>
  job.served ? `${job.served.provider}:${job.served.model}` : job.model;

function bucket(rows: JobSpend[], key: (r: JobSpend) => string): SpendBucket[] {
  const map = new Map<string, SpendBucket>();
  for (const r of rows) {
    const k = key(r);
    const b = map.get(k) ?? { key: k, usd: 0, jobs: 0, notRecorded: 0 };
    b.jobs += 1;
    if (r.usd === NOT_RECORDED) b.notRecorded += 1;
    else b.usd = round3(b.usd + r.usd);
    map.set(k, b);
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd);
}

/** The request a draft take would have been without drafts: same take at the finish resolution. */
function fullQualityRequest(req: GenerateRequest): GenerateRequest {
  const parameters = { ...req.parameters, resolution: "1080p" };
  delete parameters.draft;
  return { ...req, parameters };
}

export function spendMetrics(input: CaseInputs, jobs: JobRecord[]): SpendMetrics {
  const ledgerFile = input.ledger.file;
  const jobsFile = input.jobs.file;
  const latest = new Map<string, LedgerLine>();
  for (const l of input.ledger.lines) latest.set(l.key, l);
  const spendRow = (job: JobRecord): JobSpend => {
    const line = ledgerFor(job, latest);
    const usd = line ? countedUsd(line) : null;
    const measured =
      line?.state === "spent" &&
      line.chargeUsd !== undefined &&
      (line.chargeSource === "provider" || line.chargeSource === "measured");
    return {
      jobId: job.id,
      model: job.model,
      route: routeName(job),
      role: roleOf(job),
      usd: usd === null ? NOT_RECORDED : round3(usd),
      worstCase: usd !== null && line?.state !== "released" && !measured,
      basis: !line
        ? "no ledger line for this job"
        : usd === null
          ? `ledger line ${line.key} has no price`
          : line.state === "spent"
            ? `ledger ${line.key}: ${line.chargeSource === "provider" || line.chargeSource === "measured" ? `${line.chargeSource} charge` : "worst case kept (no reported charge)"}`
            : line.state === "released"
              ? `ledger ${line.key}: released (not charged)`
              : `ledger ${line.key}: reserved worst case (job not settled)`,
    };
  };
  const rows: JobSpend[] = jobs.map(spendRow);
  const counted = rows.filter((r) => r.usd !== NOT_RECORDED);
  const notRecorded = rows.length - counted.length;
  const totalUsd = round3(counted.reduce((s, r) => s + (r.usd as number), 0));
  const worstCase = counted.filter((r) => r.worstCase).length;
  const ledgerIds = jobs.map((j) => ledgerFor(j, latest)?.key).filter((k): k is string => !!k);

  // Without drafts: every draft take generated at full quality (1080p, same route) instead.
  const drafts = jobs.filter((j) => roleOf(j) === "draft");
  const finishes = jobs.filter((j) => roleOf(j) === "finish");
  const cfRows: CounterfactualRow[] = drafts.map((d) => {
    const group = groupOf(d.served?.model ?? d.model) ?? groupOf(d.model);
    const route = routeOf(d.served?.model ?? d.model) ?? routeOf(d.model);
    if (!group || !route)
      return {
        draftJob: d.id,
        route: routeName(d),
        seconds: null,
        fullQualityUsd: NOT_RECORDED,
        rate: "model not in the price catalog",
      };
    const q = quoteRoute(route, group, fullQualityRequest(d.request));
    const seconds = d.draft?.seconds ?? null;
    return {
      draftJob: d.id,
      route: `${route.provider}:${route.model}`,
      seconds,
      fullQualityUsd: q.usd === null ? NOT_RECORDED : q.usd,
      rate: `${q.rate} (catalog checked ${q.checked}, ${q.source})`,
    };
  });
  // the finishes of the drafts in scope, so both sides cover the same takes; a finish made after
  // the range end (or from another thread) still belongs to its draft's cost
  const draftIds = new Set(drafts.map((d) => d.id));
  const scoped = new Set(jobs.map((j) => j.id));
  const allFinishes = [
    ...finishes,
    ...input.jobs.records.filter((j) => !scoped.has(j.id) && roleOf(j) === "finish"),
  ];
  const flow = [
    ...drafts,
    ...allFinishes.filter((f) => draftIds.has(f.request.finishDraft!.ofJob)),
  ];
  const flowRows = flow.map((j) => rows.find((r) => r.jobId === j.id) ?? spendRow(j));
  const flowMissing = flowRows.some((r) => r.usd === NOT_RECORDED);
  const cfMissing = cfRows.some((r) => r.fullQualityUsd === NOT_RECORDED);
  const actualFlow = round3(flowRows.reduce((s, r) => s + (r.usd === NOT_RECORDED ? 0 : r.usd), 0));
  const cfTotal = round3(
    cfRows.reduce((s, r) => s + (r.fullQualityUsd === NOT_RECORDED ? 0 : r.fullQualityUsd), 0),
  );
  const withoutDrafts: SpendMetrics["withoutDrafts"] = !drafts.length
    ? {
        value: NOT_RECORDED,
        sources: [{ file: jobsFile, ids: [], note: "no draft takes in this project" }],
      }
    : flowMissing || cfMissing
      ? {
          value: NOT_RECORDED,
          sources: [
            {
              file: jobsFile,
              ids: drafts.map((d) => d.id),
              note: flowMissing
                ? "a draft or finish job has no recorded charge in the ledger"
                : "a draft's model has no full-quality price in the catalog",
            },
          ],
          method: COUNTERFACTUAL_METHOD,
        }
      : {
          value: {
            actualUsd: actualFlow,
            counterfactualUsd: cfTotal,
            savedUsd: round3(cfTotal - actualFlow),
            worstCaseJobs: flowRows.filter((r) => r.worstCase).length,
            rows: cfRows,
          },
          sources: [
            { file: jobsFile, ids: flow.map((j) => j.id) },
            { file: ledgerFile, ids: flowRows.map((r) => r.jobId) },
            {
              file: "packages/creative-mcp/src/media/catalog.ts",
              ids: [...new Set(cfRows.map((r) => r.route))],
            },
          ],
          method: COUNTERFACTUAL_METHOD,
        };

  // Cheapest route: list price on the route the agent asked for vs the route that served it.
  const routeRows: {
    jobId: string;
    defaultRoute: string;
    servedRoute: string;
    defaultUsd: number;
    servedUsd: number;
  }[] = [];
  let routeUnknown = 0;
  for (const job of jobs) {
    const group = groupOf(job.model);
    const asked = routeOf(job.request.model ?? job.model);
    const served = job.served ? routeOf(job.served.model) : asked;
    if (!group || !asked || !served) continue;
    const req = job.request;
    const a = quoteRoute(asked, group, { ...req, model: asked.model });
    const s = quoteRoute(served, group, { ...req, model: served.model });
    if (a.usd === null || s.usd === null) {
      routeUnknown += 1;
      continue;
    }
    routeRows.push({
      jobId: job.id,
      defaultRoute: `${asked.provider}:${asked.model}`,
      servedRoute: `${served.provider}:${served.model}`,
      defaultUsd: a.usd,
      servedUsd: s.usd,
    });
  }
  const defUsd = round3(routeRows.reduce((s, r) => s + r.defaultUsd, 0));
  const servedUsd = round3(routeRows.reduce((s, r) => s + r.servedUsd, 0));
  const cheapestRoute: SpendMetrics["cheapestRoute"] = routeRows.length
    ? {
        value: {
          defaultUsd: defUsd,
          servedUsd,
          savedUsd: round3(defUsd - servedUsd),
          rows: routeRows,
        },
        sources: [
          { file: jobsFile, ids: routeRows.map((r) => r.jobId) },
          {
            file: "packages/creative-mcp/src/media/catalog.ts",
            ids: [...new Set(routeRows.flatMap((r) => [r.defaultRoute, r.servedRoute]))],
          },
        ],
        method: `${ROUTE_METHOD}${routeUnknown ? ` ${routeUnknown} job(s) skipped: no list price on one of the routes.` : ""}`,
      }
    : {
        value: NOT_RECORDED,
        sources: [
          {
            file: jobsFile,
            ids: [],
            note: "no jobs on a model sold by several routes (price catalog)",
          },
        ],
      };

  return {
    jobs: rows,
    total: rows.length
      ? {
          value: {
            usd: totalUsd,
            jobsCounted: counted.length,
            jobsNotRecorded: notRecorded,
            jobsWorstCase: worstCase,
          },
          sources: [
            { file: jobsFile, ids: jobs.map((j) => j.id) },
            { file: ledgerFile, ids: ledgerIds },
          ],
          method:
            "Sum of what the spend ledger counts per job: the provider's reported charge, else the reserved worst case (an upper bound, counted in jobsWorstCase); released jobs count $0. Jobs without a ledger line are listed as not recorded, not added.",
        }
      : {
          value: NOT_RECORDED,
          sources: [{ file: jobsFile, ids: [], note: "no generation jobs for this project" }],
        },
    byRoute: bucket(rows, (r) => r.route),
    byRole: bucket(rows, (r) => r.role),
    withoutDrafts,
    cheapestRoute,
  };
}

export const COUNTERFACTUAL_METHOD =
  "Without drafts, every draft take would have been generated at full quality straight away. Counterfactual = Σ over draft jobs of the catalog list price for the same request on the same route at 1080p without draft mode. Actual = what the ledger counts for the drafts plus their finishes (a job without a reported charge counts at its reserved worst case, which can only shrink the saving). Saved = counterfactual − actual; negative means drafting cost more.";
export const ROUTE_METHOD =
  "For jobs on a model sold by several routes: catalog list price of the request on the route the agent asked for (default) vs on the route that served it (cheapest-route policy). List prices, not charges, so both sides use the same basis.";

// Iterations

export interface GoalIteration {
  threadId: string;
  objective: string;
  target: number;
  status: string;
  reviews: number;
  first?: number | undefined;
  last?: number | undefined;
  best?: number | undefined;
  startedAt: number;
  endedAt?: number | undefined;
  source: Source;
}

export interface IterationMetrics {
  takes: Metric<{
    total: number;
    picked?: string | undefined;
    perDeliverable: {
      group: string;
      takes: number;
      picked: boolean;
      firstScore?: number | undefined;
      lastScore?: number | undefined;
    }[];
  }>;
  goals: Metric<GoalIteration[]>;
  reviews: Metric<number>;
}

/** A take's deliverable: its folder plus file stem without the take/version suffix. */
export function deliverableOf(file: string): string {
  const parts = file.split("/");
  const name = parts.pop() ?? file;
  const stem = name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_ .]*(take|v|ver|version|t|r|round)?[-_ .]?\d+$/i, "")
    .replace(/[-_ .]+$/, "");
  return [...parts, stem || name].join("/");
}

export function iterationMetrics(input: CaseInputs): IterationMetrics {
  const { takes, goals, range } = input;
  const inTakes = takes.takes.filter((t) => inRange(Date.parse(t.added), range));
  const groups = new Map<string, TakeRecord[]>();
  for (const t of inTakes) {
    const g = deliverableOf(t.file);
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const perDeliverable = [...groups.entries()].map(([group, list]) => {
    const scored = list.filter((t) => t.score !== undefined);
    return {
      group,
      takes: list.length,
      picked: list.some((t) => t.id === takes.picked),
      ...(scored.length ? { firstScore: scored[0]!.score, lastScore: scored.at(-1)!.score } : {}),
    };
  });
  const gs: GoalIteration[] = goals.records.map((g) => {
    const reviews = g.reviews.filter((r) => inRange(r.at, range)).sort((a, b) => a.at - b.at);
    return {
      threadId: g.threadId,
      objective: g.objective,
      target: g.target,
      status: g.status,
      reviews: reviews.length,
      ...(reviews.length
        ? {
            first: reviews[0]!.score,
            last: reviews.at(-1)!.score,
            best: Math.max(...reviews.map((r) => r.score)),
            endedAt: reviews.at(-1)!.at,
          }
        : {}),
      startedAt: g.startedAt,
      source: { file: g.file, ids: reviews.map((r) => String(r.at)) },
    };
  });
  const reviewCount = gs.reduce((s, g) => s + g.reviews, 0);
  return {
    takes: inTakes.length
      ? {
          value: {
            total: inTakes.length,
            ...(takes.picked ? { picked: takes.picked } : {}),
            perDeliverable,
          },
          sources: [{ file: takes.file, ids: inTakes.map((t) => t.id) }],
          method:
            "Takes from the take ledger, grouped per deliverable by folder + file name without its take/version number.",
        }
      : { value: NOT_RECORDED, sources: [{ file: takes.file, ids: [], note: "no takes logged" }] },
    goals: gs.length
      ? {
          value: gs,
          sources: gs.map((g) => g.source),
          method:
            "Quality goals of the project's threads; first → last independent review score per goal ; each goal counts only the reviews made while it was its thread's goal. Goals replaced before goal history was kept (<thread>.history.jsonl) are not recorded.",
        }
      : {
          value: NOT_RECORDED,
          sources: [
            { file: goals.dir, ids: [], note: "no quality goals for this project's threads" },
          ],
        },
    reviews: gs.length
      ? { value: reviewCount, sources: gs.map((g) => g.source) }
      : { value: NOT_RECORDED, sources: [{ file: goals.dir, ids: [] }] },
  };
}

// Everything

export interface CaseNumbers {
  version: 1;
  project: string;
  generatedAt: number;
  range?: Range | undefined;
  threadIds?: string[] | undefined;
  time: TimeMetrics;
  human: HumanMetrics;
  spend: SpendMetrics;
  iterations: IterationMetrics;
  deliverables: Metric<DeliverableRecord[]>;
  moments: KeyMoment[];
  agencyEstimate?: { hours: number; label: "user's estimate" } | undefined;
}

/** Jobs of the project (and of the chosen threads), inside the range. */
export function projectJobs(input: CaseInputs): JobRecord[] {
  const root = input.project.replace(/\/+$/, "");
  const threads = input.threadIds && new Set(input.threadIds);
  return input.jobs.records.filter(
    (j) =>
      (j.projectPath === root || j.projectPath.startsWith(`${root}/`)) &&
      inRange(j.createdAt, input.range) &&
      (!threads || threads.has(j.threadId ?? j.chatId ?? "")),
  );
}

export function computeCase(input: CaseInputs, now = Date.now()): CaseNumbers {
  const jobs = projectJobs(input);
  return {
    version: 1,
    project: input.project,
    generatedAt: now,
    ...(input.range ? { range: input.range } : {}),
    ...(input.threadIds ? { threadIds: input.threadIds } : {}),
    time: timeMetrics(input),
    human: humanMetrics(input),
    spend: spendMetrics(input, jobs),
    iterations: iterationMetrics(input),
    deliverables: input.deliverables.records.length
      ? {
          value: input.deliverables.records,
          sources: [
            { file: input.deliverables.dir, ids: input.deliverables.records.map((d) => d.file) },
          ],
          method: "Files in the delivery folder, probed with ffprobe for format and dimensions.",
        }
      : {
          value: NOT_RECORDED,
          sources: [
            { file: input.deliverables.dir, ids: [], note: "no files in the delivery folder" },
          ],
        },
    moments: input.moments.records
      .filter((m) => inRange(m.at, input.range))
      .sort((a, b) => a.at - b.at),
    ...(input.agencyEstimateHours !== undefined && input.agencyEstimateHours > 0
      ? { agencyEstimate: { hours: input.agencyEstimateHours, label: "user's estimate" as const } }
      : {}),
  };
}

// Formatting helpers shared by CASE.md, the PDF and the video

export const fmtUsd = (v: Maybe<number>) =>
  v === NOT_RECORDED ? NOT_RECORDED : `$${round2(v).toFixed(2)}`;

export function fmtDuration(ms: Maybe<number>): string {
  if (ms === NOT_RECORDED) return NOT_RECORDED;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

export const val = <T, R>(m: Metric<T>, f: (v: T) => R): R | typeof NOT_RECORDED =>
  m.value === NOT_RECORDED ? NOT_RECORDED : f(m.value);

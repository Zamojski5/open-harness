// Readers that turn Open Herness's logs into case-study inputs. Every path is explicit (resolved
// once by the tool), so tests hand over fixture folders and never touch the live state.
// The server's database is never opened in place: it is copied to a temp folder first.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LedgerLine } from "../media/ledger.ts";
import type {
  ApprovalRecord,
  DeliverableRecord,
  GoalRecord,
  JobRecord,
  KeyMoment,
  TakesInput,
  ThreadRecord,
  ThreadsInput,
} from "./metrics.ts";

export interface SourcePaths {
  jobsDir: string;
  ledgerFile: string;
  goalsDir: string;
  /** server statev2.sqlite; undefined = search the usual places (stateDbCandidates) */
  stateDb?: string | undefined;
}

/** Where OH keeps its state, honouring the same env vars as the code that writes it. */
export function defaultPaths(env = process.env): SourcePaths {
  const ohHome = env.OH_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");
  const goalsHome = env.OPEN_HERNESS_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");
  return {
    jobsDir: env.OH_MEDIA_JOBS_DIR || NodePath.join(ohHome, "media", "jobs"),
    ledgerFile: NodePath.join(ohHome, "media", "ledger.jsonl"),
    goalsDir: NodePath.join(goalsHome, "quality-goals"),
  };
}

/**
 * Server databases that may hold the project, most recently written first: OH_STATE_DB, then
 * $T3CODE_HOME (or ~/.t3) userdata/ and dev/, then every ~/.t3/<instance>/userdata (the app's dev
 * and test instances each keep their own; the MCP server is not told which one started it).
 */
export function stateDbCandidates(env = process.env): string[] {
  if (env.OH_STATE_DB) return [env.OH_STATE_DB];
  const base = env.T3CODE_HOME || NodePath.join(NodeOS.homedir(), ".t3");
  const found = ["userdata/statev2.sqlite", "dev/statev2.sqlite"].map((rel) =>
    NodePath.join(base, rel),
  );
  if (!env.T3CODE_HOME) {
    try {
      for (const d of NodeFS.readdirSync(base, { withFileTypes: true }))
        if (d.isDirectory()) found.push(NodePath.join(base, d.name, "userdata", "statev2.sqlite"));
    } catch {
      // no ~/.t3
    }
  }
  const mtime = (p: string) => {
    try {
      return Math.max(
        NodeFS.statSync(p).mtimeMs,
        NodeFS.existsSync(`${p}-wal`) ? NodeFS.statSync(`${p}-wal`).mtimeMs : 0,
      );
    } catch {
      return -1;
    }
  };
  return [...new Set(found)].filter((p) => mtime(p) >= 0).sort((a, b) => mtime(b) - mtime(a));
}

export function findStateDb(env = process.env): string | undefined {
  return stateDbCandidates(env)[0];
}

/** Threads of the project from the first candidate database that has any. */
export function readThreadsAny(candidates: string[], q: ThreadQuery): ThreadsInput {
  let first: ThreadsInput | undefined;
  for (const db of candidates) {
    const t = readThreads(db, q);
    if (t.threads.length) return t;
    first ??= t;
  }
  return first ?? readThreads(undefined, q);
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};

export function readJobs(dir: string): JobRecord[] {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: JobRecord[] = [];
  for (const n of names) {
    const j = readJson<JobRecord>(NodePath.join(dir, n));
    if (j && typeof j.id === "string" && typeof j.projectPath === "string" && j.request)
      out.push(j);
  }
  return out;
}

export function readLedgerFile(file: string): LedgerLine[] {
  let text = "";
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerLine);
    } catch {
      // torn line
    }
  }
  return out;
}

export function readTakes(project: string): TakesInput {
  const file = NodePath.join(project, "takes", "ledger.json");
  const l = readJson<{ picked?: string; takes?: TakesInput["takes"] }>(file);
  return { file, ...(l?.picked ? { picked: l.picked } : {}), takes: l?.takes ?? [] };
}

const under = (root: string, p: string) => p === root || p.startsWith(`${root}/`);

interface RawGoal {
  threadId?: string | undefined;
  objective?: string | undefined;
  target?: number | undefined;
  startedAt?: number | undefined;
  status?: string | undefined;
  endReason?: string | undefined;
  references?: string[] | undefined;
  reviews?: { at: number; score: number; meetsBar: boolean; work?: string[] }[] | undefined;
}

/**
 * Goals of the project: its threads' goals, or goals whose work/references live in the project.
 * A thread's goal file holds its latest goal; goals it replaced are in <thread>.history.jsonl.
 * A new goal carries the old reviews along, so each goal keeps only the reviews made while it was
 * the thread's goal (from its start to the next goal's start).
 */
export function readGoals(dir: string, project: string, threadIds: Set<string>): GoalRecord[] {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const root = project.replace(/\/+$/, "");
  const out: GoalRecord[] = [];
  for (const n of names) {
    const file = NodePath.join(dir, n);
    const latest = readJson<RawGoal>(file);
    if (!latest || typeof latest.threadId !== "string" || typeof latest.startedAt !== "number")
      continue;
    const historyFile = file.replace(/\.json$/, ".history.jsonl");
    const history: RawGoal[] = [];
    try {
      for (const line of NodeFS.readFileSync(historyFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const g = JSON.parse(line) as RawGoal;
          if (g.threadId === latest.threadId && typeof g.startedAt === "number") history.push(g);
        } catch {
          // torn line
        }
      }
    } catch {
      // no earlier goals kept
    }
    const goals = [...history, latest]
      .filter((g, i, all) => all.findIndex((x) => x.startedAt === g.startedAt) === i)
      .sort((a, b) => a.startedAt! - b.startedAt!);
    for (const [i, g] of goals.entries()) {
      const until = goals[i + 1]?.startedAt ?? Infinity;
      const own = i === goals.length - 1 ? latest : g;
      const reviews = (own.reviews ?? []).filter(
        (r) =>
          typeof r?.at === "number" &&
          typeof r?.score === "number" &&
          r.at >= g.startedAt! &&
          r.at < until,
      );
      const paths = [...(g.references ?? []), ...reviews.flatMap((r) => r.work ?? [])];
      if (!threadIds.has(latest.threadId) && !paths.some((p) => under(root, p))) continue;
      out.push({
        file: own === latest ? file : historyFile,
        threadId: latest.threadId,
        objective: g.objective ?? "",
        target: g.target ?? 8,
        startedAt: g.startedAt!,
        status: g.status ?? "unknown",
        ...(g.endReason ? { endReason: g.endReason } : {}),
        reviews: reviews.map((r) => ({
          at: r.at,
          score: r.score,
          meetsBar: !!r.meetsBar,
          work: r.work ?? [],
        })),
      });
    }
  }
  return out;
}

export const momentsFile = (project: string) =>
  NodePath.join(project, ".open-herness", "key-moments.jsonl");

export function readMoments(project: string): KeyMoment[] {
  let text = "";
  try {
    text = NodeFS.readFileSync(momentsFile(project), "utf8");
  } catch {
    return [];
  }
  const out: KeyMoment[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as KeyMoment;
      if (typeof m.at === "number" && typeof m.kind === "string") out.push(m);
    } catch {
      // torn line
    }
  }
  return out;
}

/** Append a key moment for the case-study video. Never throws (logging must not break a tool). */
export function logMoment(project: string, moment: Omit<KeyMoment, "at"> & { at?: number }) {
  try {
    const file = momentsFile(project);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...moment })}\n`);
  } catch {
    // best effort
  }
}

/** "Final reviewed for delivery", once per project file (media_review runs for Claude and Codex). */
export function logPresentedOnce(project: string, file: string) {
  const rel = NodePath.isAbsolute(file) ? NodePath.relative(project, file) : file;
  if (readMoments(project).some((m) => m.kind === "deliverable_presented" && m.data?.file === rel))
    return;
  logMoment(project, {
    kind: "deliverable_presented",
    label: "final reviewed for delivery",
    data: { file: rel },
    source: "media_review",
  });
}

/**
 * Key moments from finished creative tool calls (in the MCP server, so Claude and Codex threads
 * both log them): a take picked with takes_log, a final reviewed with media_review.
 */
export function recordToolMoment(
  project: string,
  tool: string,
  input: unknown,
  result: { isError?: boolean | undefined } | undefined,
) {
  if (result?.isError) return;
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === "takes_log" && args.action === "pick" && typeof args.file === "string")
    logMoment(project, {
      kind: "take_picked",
      label: "take picked",
      data: { take: args.file },
      source: "takes_log",
    });
  else if (tool === "media_review" && typeof args.path === "string")
    logPresentedOnce(project, NodePath.resolve(project, args.path));
}

// Server database (read-only copy)

const sqlEscape = (s: string) => `'${s.replace(/'/g, "''")}'`;

function sqliteJson(db: string, sql: string): Record<string, unknown>[] {
  const out = NodeChildProcess.execFileSync("sqlite3", ["-readonly", "-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? (JSON.parse(out) as Record<string, unknown>[]) : [];
}

const ms = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

export interface ThreadQuery {
  project: string;
  threadIds?: string[] | undefined;
}

/**
 * Threads, runs (turns), user messages, approvals and tool-call counts of a project from the
 * server's statev2.sqlite. The database (with its -wal/-shm) is copied to a temp folder and the
 * copy is read, so the live file is never opened or written.
 */
export function readThreads(stateDb: string | undefined, q: ThreadQuery): ThreadsInput {
  if (!stateDb) return { unavailable: "server database (statev2.sqlite) not found", threads: [] };
  if (!NodeFS.existsSync(stateDb))
    return { file: stateDb, unavailable: `server database not found: ${stateDb}`, threads: [] };
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-case-db-"));
  try {
    const copy = NodePath.join(tmp, "state.sqlite");
    NodeFS.copyFileSync(stateDb, copy);
    for (const ext of ["-wal", "-shm"])
      if (NodeFS.existsSync(stateDb + ext)) NodeFS.copyFileSync(stateDb + ext, copy + ext);
    const root = q.project.replace(/\/+$/, "");
    const threadFilter = q.threadIds?.length
      ? ` AND t.thread_id IN (${q.threadIds.map(sqlEscape).join(",")})`
      : "";
    const threadsSql = `SELECT t.thread_id, t.title, t.created_at FROM projection_projects p
      JOIN orchestration_v2_projection_threads t ON t.project_id = p.project_id AND t.deleted_at IS NULL
      WHERE (p.workspace_root = ${sqlEscape(root)} OR json_extract(t.payload_json,'$.worktreePath') = ${sqlEscape(root)})
        AND p.deleted_at IS NULL
        AND COALESCE(json_extract(t.payload_json,'$.lineage.relationshipToParent'),'') <> 'subagent'${threadFilter}`;
    const threadRows = sqliteJson(copy, threadsSql);
    if (!threadRows.length)
      return {
        file: stateDb,
        unavailable: `no threads recorded for ${root} in the server database`,
        threads: [],
      };
    const ids = threadRows.map((r) => sqlEscape(String(r.thread_id))).join(",");
    const runs = sqliteJson(
      copy,
      `SELECT thread_id, run_id, status, requested_at, completed_at,
        COALESCE(json_extract(payload_json,'$.workStartedAt'), json_extract(payload_json,'$.startedAt'), requested_at) AS started_at
       FROM orchestration_v2_projection_runs WHERE thread_id IN (${ids})`,
    );
    const msgs = sqliteJson(
      copy,
      `SELECT thread_id, message_id, created_at, substr(json_extract(payload_json,'$.text'),1,2000) AS text
       FROM orchestration_v2_projection_messages WHERE role='user' AND thread_id IN (${ids})
         AND COALESCE(json_extract(payload_json,'$.createdBy'),'user') = 'user' ORDER BY created_at`,
    );
    const reqs = sqliteJson(
      copy,
      `SELECT thread_id, runtime_request_id, kind, status, created_at, resolved_at,
        json_extract(payload_json,'$.decision') AS decision
       FROM orchestration_v2_projection_runtime_requests WHERE thread_id IN (${ids})
       AND kind NOT IN ('user_input','auth_refresh')`,
    );
    const tools = sqliteJson(
      copy,
      `SELECT thread_id, count(*) AS n FROM orchestration_v2_projection_turn_items
       WHERE thread_id IN (${ids}) AND type IN ('command_execution','file_change','file_search','web_search','dynamic_tool','subagent')
       GROUP BY thread_id`,
    );
    const threads: ThreadRecord[] = threadRows.map((r) => {
      const id = String(r.thread_id);
      const approvals: ApprovalRecord[] = reqs
        .filter((x) => x.thread_id === id)
        .flatMap((x) => {
          const requestedAt = ms(x.created_at);
          if (requestedAt === undefined) return [];
          const resolvedAt = ms(x.resolved_at);
          return [
            {
              id: String(x.runtime_request_id),
              requestedAt,
              ...(resolvedAt !== undefined ? { resolvedAt } : {}),
              ...(typeof x.decision === "string" ? { decision: x.decision } : {}),
            },
          ];
        });
      return {
        threadId: id,
        ...(typeof r.title === "string" ? { title: r.title } : {}),
        ...(ms(r.created_at) !== undefined ? { createdAt: ms(r.created_at) } : {}),
        turns: runs
          .filter((x) => x.thread_id === id)
          .flatMap((x) => {
            const startedAt = ms(x.started_at);
            if (startedAt === undefined) return [];
            // An interrupted run (user stop, or found dead after a restart) may carry the moment the
            // server noticed as completedAt, days after work stopped: its end counts as not recorded.
            const endedAt = x.status === "interrupted" ? undefined : ms(x.completed_at);
            return [
              {
                turnId: String(x.run_id),
                startedAt,
                ...(endedAt !== undefined ? { endedAt } : {}),
              },
            ];
          }),
        userMessages: msgs
          .filter((x) => x.thread_id === id)
          .flatMap((x) => {
            const at = ms(x.created_at);
            return at === undefined
              ? []
              : [
                  {
                    id: String(x.message_id),
                    at,
                    ...(typeof x.text === "string" ? { text: x.text } : {}),
                  },
                ];
          }),
        approvals,
        toolCalls: Number(tools.find((x) => x.thread_id === id)?.n ?? 0),
      };
    });
    return { file: stateDb, threads };
  } catch (error) {
    return {
      file: stateDb,
      unavailable: `server database could not be read: ${String(error).slice(0, 300)}`,
      threads: [],
    };
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Approval accepts as key moments (derived from the server's runtime requests). */
export function approvalMoments(threads: ThreadsInput): KeyMoment[] {
  return threads.threads.flatMap((t) =>
    t.approvals
      .filter((a) => a.resolvedAt !== undefined && /^accept/i.test(a.decision ?? ""))
      .map((a) => ({
        at: a.resolvedAt!,
        kind: "approval_accepted" as const,
        label: "Approval accepted",
        data: { requestId: a.id, threadId: t.threadId, decision: a.decision },
        source: threads.file,
      })),
  );
}

// Deliverables

const MEDIA =
  /\.(mp4|mov|webm|m4v|png|jpe?g|webp|gif|tiff?|wav|mp3|m4a|aac|flac|pdf|psd|blend|glb|gltf|svg)$/i;

export function probeFile(file: string): Omit<DeliverableRecord, "file"> {
  const ext = NodePath.extname(file).slice(1).toLowerCase();
  const bytes = (() => {
    try {
      return NodeFS.statSync(file).size;
    } catch {
      return undefined;
    }
  })();
  const base = { format: ext, ...(bytes !== undefined ? { bytes } : {}) };
  if (!/^(mp4|mov|webm|m4v|png|jpe?g|webp|gif|tiff?|wav|mp3|m4a|aac|flac)$/.test(ext)) return base;
  try {
    const out = NodeChildProcess.execFileSync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
      { encoding: "utf8", timeout: 30_000 },
    );
    const info = JSON.parse(out) as {
      streams?: { codec_type?: string; width?: number; height?: number }[] | undefined;
      format?: { duration?: string } | undefined;
    };
    const v = info.streams?.find((s) => s.codec_type === "video");
    const dur = Number(info.format?.duration);
    const still = /^(png|jpe?g|webp|tiff?)$/.test(ext);
    return {
      ...base,
      ...(v?.width ? { width: v.width, height: v.height } : {}),
      ...(!still && Number.isFinite(dur) && dur > 0
        ? { durationSeconds: Math.round(dur * 100) / 100 }
        : {}),
    };
  } catch {
    return base;
  }
}

/** Files in <project>/delivery (not the case study itself), relative to the project. */
export function readDeliverables(
  project: string,
  takes: TakesInput,
): {
  dir: string;
  records: DeliverableRecord[];
} {
  const dir = NodePath.join(project, "delivery");
  const out: DeliverableRecord[] = [];
  const walk = (d: string, depth: number) => {
    let entries: NodeFS.Dirent[] = [];
    try {
      entries = NodeFS.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = NodePath.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "case-study" || e.name.startsWith(".")) continue;
        if (depth < 3) walk(p, depth + 1);
      } else if (MEDIA.test(e.name)) {
        out.push({ file: NodePath.relative(project, p), ...probeFile(p) });
      }
    }
  };
  walk(dir, 0);
  if (!out.length && takes.picked) {
    const t = takes.takes.find((x) => x.id === takes.picked);
    if (t) {
      const p = NodePath.isAbsolute(t.file) ? t.file : NodePath.join(project, t.file);
      if (NodeFS.existsSync(p))
        return {
          dir: takes.file,
          records: [{ file: NodePath.relative(project, p), ...probeFile(p) }],
        };
    }
  }
  return { dir, records: out.sort((a, b) => a.file.localeCompare(b.file)) };
}

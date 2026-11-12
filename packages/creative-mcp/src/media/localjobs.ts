// Detached, tracked local jobs so agents never have to poll in the foreground.
//   jobs_run   : run any local command as a detached process (pid, log, exit code persisted)
//   jobs_watch : poll a command on an interval until a regex matches (until / fail / exit_done)
// Records live in ~/.open-herness/jobs-local/<id>.json (+ <id>.log, <id>.exit). A run job survives
// agent interruption and app restarts because a tiny sh wrapper writes the exit code itself; watch
// jobs are driven by the MCP server and re-armed from disk when it starts.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const dir = () => {
  const d = process.env.OH_LOCAL_JOBS_DIR || join(homedir(), ".open-herness", "jobs-local");
  mkdirSync(d, { recursive: true });
  return d;
};
const TAIL = 4096;

export interface LocalJob {
  id: string;
  kind: "command" | "watch";
  title: string;
  state: "running" | "completed" | "failed" | "cancelled" | "timeout";
  startedAt: string;
  finishedAt?: string;
  cwd: string;
  // command
  argv?: string[];
  pid?: number;
  log?: string;
  exitCode?: number | null;
  reason?: string;
  // watch
  command?: string;
  interval?: number;
  until?: string[];
  failOn?: string[];
  field?: string;
  exitDone?: boolean;
  deadline?: string;
  polls?: number;
  lastOutput?: string;
  lastPollAt?: string;
  matched?: string;
}

const file = (id: string) => join(dir(), `${id}.json`);
const save = (j: LocalJob) => {
  const tmp = `${file(j.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2));
  renameSync(tmp, file(j.id));
};
const load = (id: string): LocalJob | undefined => {
  try {
    return JSON.parse(readFileSync(file(id), "utf8"));
  } catch {
    return undefined;
  }
};
const newId = () => `job-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

function tail(path: string | undefined, bytes = TAIL): string {
  if (!path || !existsSync(path)) return "";
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// ---------------------------------------------------------------------------------------------
// jobs_run
// ---------------------------------------------------------------------------------------------
export function runJob(title: string, argv: string[], cwd?: string): LocalJob {
  const id = newId();
  const log = join(dir(), `${id}.log`);
  const exitFile = join(dir(), `${id}.exit`);
  const workdir = resolve(process.cwd(), cwd ?? ".");
  const fd = openSync(log, "a");
  // The wrapper records "<code> <epoch>" when the command ends, whatever the agent/app is doing.
  const wrapper =
    'ef="$1"; shift; "$@"; c=$?; printf "%s %s" "$c" "$(date +%s)" > "$ef.tmp" && mv "$ef.tmp" "$ef"; exit $c';
  const child = spawn("/bin/sh", ["-c", wrapper, "sh", exitFile, ...argv], {
    cwd: workdir,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  closeSync(fd);
  const job: LocalJob = {
    id,
    kind: "command",
    title,
    state: "running",
    startedAt: new Date().toISOString(),
    cwd: workdir,
    argv,
    pid: child.pid,
    log,
  };
  save(job);
  return job;
}

/** Refresh a command job from the exit file / pid. */
function refreshCommand(j: LocalJob): LocalJob {
  if (j.kind !== "command" || j.state !== "running") return j;
  const ef = join(dir(), `${j.id}.exit`);
  if (existsSync(ef)) {
    const [code, epoch] = readFileSync(ef, "utf8").trim().split(" ").map(Number);
    j.exitCode = code;
    j.state = code === 0 ? "completed" : "failed";
    j.finishedAt = new Date((epoch || Date.now() / 1000) * 1000).toISOString();
    if (code !== 0) j.reason = `exit code ${code}`;
    save(j);
  } else if (!j.pid || !alive(j.pid)) {
    j.state = "failed";
    j.exitCode = null;
    j.reason = "process vanished without an exit code (killed or machine restarted)";
    j.finishedAt = new Date().toISOString();
    save(j);
  }
  return j;
}

// ---------------------------------------------------------------------------------------------
// jobs_watch
// ---------------------------------------------------------------------------------------------
const timers = new Map<string, NodeJS.Timeout>();

function execShell(command: string, cwd: string): Promise<{ out: string; code: number }> {
  return new Promise((done) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (e, stdout, stderr) => {
        const code = e
          ? typeof (e as { code?: unknown }).code === "number"
            ? (e as { code: number }).code
            : 1
          : 0;
        done({ out: `${stdout}${stderr}`.trim(), code });
      },
    );
  });
}
function pick(output: string, field?: string): string {
  if (!field) return output;
  try {
    let v: unknown = JSON.parse(output);
    for (const k of field.split(".")) v = (v as Record<string, unknown>)?.[k];
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return "";
  }
}
function finish(j: LocalJob, state: LocalJob["state"], reason: string, matched?: string) {
  j.state = state;
  j.reason = reason;
  j.matched = matched;
  j.finishedAt = new Date().toISOString();
  save(j);
  const t = timers.get(j.id);
  if (t) clearTimeout(t);
  timers.delete(j.id);
}
async function pollOnce(id: string) {
  const j = load(id);
  if (!j || j.kind !== "watch" || j.state !== "running") return;
  const { out, code } = await execShell(j.command!, j.cwd);
  const cur = load(id);
  if (!cur || cur.state !== "running") return; // cancelled meanwhile
  cur.polls = (cur.polls ?? 0) + 1;
  cur.lastPollAt = new Date().toISOString();
  cur.lastOutput = out.slice(-TAIL);
  const hay = pick(out, cur.field);
  const hit = (pats?: string[]) => (pats ?? []).find((p) => new RegExp(p, "i").test(hay));
  const f = hit(cur.failOn);
  const u = hit(cur.until);
  if (f) return finish(cur, "failed", `matched fail pattern /${f}/`, f);
  if (u) return finish(cur, "completed", `matched /${u}/`, u);
  if (cur.exitDone && code === 0) return finish(cur, "completed", "command exited 0");
  if (cur.deadline && Date.now() > Date.parse(cur.deadline))
    return finish(cur, "timeout", "timeout reached");
  save(cur);
  arm(cur);
}
function arm(j: LocalJob, firstDelayMs?: number) {
  if (timers.has(j.id)) clearTimeout(timers.get(j.id)!);
  const t = setTimeout(() => void pollOnce(j.id), firstDelayMs ?? (j.interval ?? 60) * 1000);
  timers.set(j.id, t);
}
export function watchJob(a: {
  title: string;
  command: string;
  interval?: number;
  until?: string[];
  fail?: string[];
  field?: string;
  exit_done?: boolean;
  timeout?: number;
  cwd?: string;
}): LocalJob {
  for (const p of [...(a.until ?? []), ...(a.fail ?? [])]) new RegExp(p, "i"); // throws on a bad pattern
  if (!a.until?.length && !a.fail?.length && !a.exit_done)
    throw new Error("give at least one of until, fail or exit_done");
  const j: LocalJob = {
    id: newId(),
    kind: "watch",
    title: a.title,
    state: "running",
    startedAt: new Date().toISOString(),
    cwd: resolve(process.cwd(), a.cwd ?? "."),
    command: a.command,
    interval: a.interval ?? 60,
    until: a.until,
    failOn: a.fail,
    field: a.field,
    exitDone: a.exit_done,
    deadline: new Date(Date.now() + (a.timeout ?? 86400) * 1000).toISOString(),
    polls: 0,
  };
  save(j);
  arm(j, 0);
  return j;
}
/** Re-arm every running watch job found on disk (server start). */
export function rearmWatches() {
  try {
    for (const f of readdirSync(dir())) {
      if (!f.endsWith(".json")) continue;
      const j = load(f.slice(0, -5));
      if (j?.kind === "watch" && j.state === "running" && !timers.has(j.id)) {
        if (j.deadline && Date.now() > Date.parse(j.deadline))
          finish(j, "timeout", "timeout reached while the server was down");
        else arm(j, 1000);
      }
    }
  } catch {
    /* nothing to re-arm */
  }
}

// ---------------------------------------------------------------------------------------------
// status / wait / cancel
// ---------------------------------------------------------------------------------------------
export function status(id: string) {
  const j0 = load(id);
  if (!j0) return undefined;
  const j = refreshCommand(j0);
  const elapsed =
    ((j.finishedAt ? Date.parse(j.finishedAt) : Date.now()) - Date.parse(j.startedAt)) / 1000;
  return {
    ...j,
    elapsedSeconds: Math.round(elapsed),
    output: j.kind === "command" ? tail(j.log) : (j.lastOutput ?? ""),
  };
}
export function listJobs(activeOnly: boolean, limit: number) {
  const out: LocalJob[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const j = load(f.slice(0, -5));
    if (j) out.push(refreshCommand(j));
  }
  return out
    .filter((j) => !activeOnly || j.state === "running")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}
export function cancel(id: string): string {
  const j = load(id);
  if (!j) return "not found";
  refreshCommand(j);
  if (j.state !== "running") return `already ${j.state}`;
  if (j.kind === "command" && j.pid) {
    try {
      process.kill(-j.pid, "SIGTERM"); // the wrapper and its command share one process group
    } catch {
      try {
        process.kill(j.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  j.state = "cancelled";
  j.reason =
    j.kind === "command"
      ? "process group terminated"
      : "watch stopped (the watched service is unaffected)";
  j.finishedAt = new Date().toISOString();
  save(j);
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  return j.reason;
}
export async function wait(ids: string[], any: boolean, timeoutSec: number) {
  const end = Date.now() + timeoutSec * 1000;
  for (;;) {
    const st = ids.map((i) => status(i));
    const done = st.map((s) => !!s && s.state !== "running");
    if (st.some((s) => !s) || (any ? done.some(Boolean) : done.every(Boolean)) || Date.now() >= end)
      return st;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const brief = (s: NonNullable<ReturnType<typeof status>>) => ({
  id: s.id,
  title: s.title,
  kind: s.kind,
  state: s.state,
  exitCode: s.exitCode,
  reason: s.reason,
  elapsedSeconds: s.elapsedSeconds,
  polls: s.polls,
  output: s.output.slice(-TAIL),
});

export function registerLocalJobTools(server: McpServer) {
  rearmWatches();
  server.registerTool(
    "jobs_run",
    {
      description:
        'Run a local command that takes more than ~1 minute (encodes, renders, downloads, test suites) as a DETACHED tracked job instead of waiting or polling in the foreground. argv is the exact command (no shell: pass ["sh","-c","a && b"] for pipelines); it starts in cwd (default: project) with your environment. It survives agent interruption and app restarts; stdout+stderr go to a log; the exit code is persisted (nonzero or a vanished process = failed). Returns the job id at once: carry on with other work, then check jobs_local_status or jobs_local_wait. State lives in ~/.open-herness/jobs-local/.',
      inputSchema: {
        title: z.string().describe("Short label, e.g. 'encode final 4K'"),
        argv: z.array(z.string()).min(1),
        cwd: z.string().optional(),
      },
    },
    async ({ title, argv, cwd }) => {
      try {
        const j = runJob(title, argv, cwd);
        if (!j.pid) return fail(`could not start: ${argv[0]}`);
        return text(
          JSON.stringify(
            {
              id: j.id,
              pid: j.pid,
              log: j.log,
              note: "Running detached. Check with jobs_local_status {id} or jobs_local_wait; do not poll in a loop.",
            },
            null,
            2,
          ),
        );
      } catch (e) {
        return fail(`jobs_run failed: ${String(e)}`);
      }
    },
  );
  server.registerTool(
    "jobs_watch",
    {
      description:
        "Track something on another service or in the filesystem by running `command` (via sh -c) every `interval` seconds (default 60, min 5) until a case-insensitive regex in `until` matches the output (or the JSON `field`, dotted path), a `fail` regex matches, or exit_done=true and the command exits 0; gives up after `timeout` seconds (default 86400). The last output is kept. Cancelling only stops watching. Watches are re-armed from disk when the MCP server restarts. Check with jobs_local_status / jobs_local_wait.",
      inputSchema: {
        title: z.string(),
        command: z.string(),
        interval: z.number().min(5).max(3600).optional(),
        until: z.array(z.string()).optional(),
        fail: z.array(z.string()).optional(),
        field: z.string().optional(),
        exit_done: z.boolean().optional(),
        timeout: z
          .number()
          .positive()
          .max(7 * 86400)
          .optional(),
        cwd: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const j = watchJob(a);
        return text(
          JSON.stringify({ id: j.id, interval: j.interval, deadline: j.deadline }, null, 2),
        );
      } catch (e) {
        return fail(`jobs_watch failed: ${String(e)}`);
      }
    },
  );
  server.registerTool(
    "jobs_local_status",
    {
      description:
        "Status of jobs started with jobs_run / jobs_watch: state (running/completed/failed/cancelled/timeout), exit code, elapsed time and the last 4 KB of output. Without id lists recent jobs (active_only to filter). A finished job is final: do not poll it again.",
      inputSchema: {
        id: z.string().optional(),
        active_only: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ id, active_only, limit }) => {
      if (id) {
        const s = status(id);
        return s ? text(JSON.stringify(brief(s), null, 2)) : fail(`No local job ${id}`);
      }
      return text(
        JSON.stringify(
          listJobs(!!active_only, limit ?? 30).map((j) => ({
            id: j.id,
            title: j.title,
            kind: j.kind,
            state: j.state,
            startedAt: j.startedAt,
            exitCode: j.exitCode,
          })),
          null,
          2,
        ),
      );
    },
  );
  server.registerTool(
    "jobs_local_wait",
    {
      description:
        "Block (up to timeout seconds, max 120, default 60) until the given local jobs finish (mode all, default) or any one does. Returns each job's status; jobs still running after the timeout are reported as running: end your turn or do other work instead of calling this in a loop.",
      inputSchema: {
        ids: z.array(z.string()).min(1),
        mode: z.enum(["all", "any"]).optional(),
        timeout: z.number().min(0).max(120).optional(),
      },
    },
    async ({ ids, mode, timeout }) => {
      const st = await wait(ids, mode === "any", timeout ?? 60);
      return text(
        JSON.stringify(
          st.map((s, i) => (s ? brief(s) : { id: ids[i], error: "not found" })),
          null,
          2,
        ),
      );
    },
  );
  server.registerTool(
    "jobs_local_cancel",
    {
      description:
        "Cancel a jobs_run job (kills its process group) or stop a jobs_watch (the watched service is not touched).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => text(cancel(id)),
  );
}

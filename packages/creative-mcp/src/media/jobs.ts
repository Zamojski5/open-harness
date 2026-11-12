// Media jobs: queued with a concurrency limit, deduped by content fingerprint, saved in
// ~/.open-herness/media/jobs/<id>.json, outputs at <project>/takes/<slug>-take-NN.<ext>. Retries and
// route fallback happen only before the provider accepted the request; several MCP servers share
// the folder and only a job's owner pid (or the next server once it is gone) polls it.

import { ohHome } from "../home.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  activeCooldown,
  backoffMs,
  classifyException,
  makeFailure,
  noteCooldown,
  RETRY,
  type Failure,
  type Provider,
} from "./failures.ts";
import * as ledger from "./ledger.ts";
import * as pricing from "./pricing.ts";
import { rankRoutes } from "./route.ts";
import * as spend from "./spend.ts";
import { describeRef, sanitizeNative, sha256File, writeSidecar } from "./provenance.ts";
import {
  execute as executeProvider,
  guessKind,
  KEY_OF,
  loadKeys,
  MediaError,
  prepare,
  providerOf,
  requireKey,
  resume as resumeProvider,
  routeCandidates,
  type GenerateRequest,
  type Prepared,
  type ProviderContext,
  type ProviderHandle,
  type ProviderOutput,
} from "./providers.ts";
import * as timings from "./timings.ts";
import type { ErrorCode } from "../project/cast.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

export type JobState =
  | "waiting"
  | "preparing"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface Attempt {
  route: string;
  endpoint?: string;
  at: number;
  outcome: "ok" | "failed" | "skipped" | "retry";
  category?: string;
  message?: string;
  adjustments?: string[];
}

export interface MediaJob {
  id: string;
  projectPath: string;
  /** Open Herness thread that started it (T3CODE_THREAD_ID); quality goals count its spend */
  threadId?: string;
  model: string;
  kind: string;
  prompt?: string;
  title: string;
  state: JobState;
  detail?: string;
  fingerprint: string;
  /** caller-chosen idempotency key */
  requestId?: string;
  request: GenerateRequest;
  outputs?: string[];
  error?: string;
  errorCode?: string;
  hint?: string;
  failure?: Failure;
  /** served route */
  served?: { provider: string; model: string; endpoint: string };
  handle?: ProviderHandle;
  native?: unknown;
  adjustments?: string[];
  attempts?: Attempt[];
  estimate?: pricing.Estimate;
  allowUnpriced?: boolean;
  warnings?: string[];
  /** cast cards injected into this request (ids, refs, description size) - recorded in provenance */
  cast?: unknown[];
  /** job this one retries */
  retryOf?: string;
  /** chat (app thread) that asked for it; spend is counted per chat */
  chatId?: string;
  /** batch slot whose reservation this job takes over */
  reservationKey?: string;
  /** most a route may cost per take (the quoted worst case); dearer routes are not tried */
  priceCeiling?: number | null;
  /** the approval that paid for this job */
  approvalId?: string;
  /** a finishable draft this job produced (Seedance 2.5 draft mode) */
  draft?: {
    id: string;
    provider: string;
    model: string;
    seconds: number;
    madeAt: number;
    expiresAt: number;
  };
  /** charge the provider reported (USD), when it reports one */
  chargeUsd?: number;
  owner?: number;
  createdAt: number;
  startedAt?: number;
  submittedAt?: number;
  finishedAt?: number;
}

const MAX_CONCURRENT = 6;
const TERMINAL = new Set<JobState>(["completed", "failed", "cancelled", "uncertain"]);
const FALLBACK_ON = new Set(["auth", "billing", "capacity", "outage", "model_unavailable"]);
const dir = () => {
  const d = ohHome("media", "jobs");
  NodeFS.mkdirSync(d, { recursive: true });
  return d;
};

const jobs = new Map<string, MediaJob>();
const controllers = new Map<string, AbortController>();
const waiters = new Map<string, ((job: MediaJob) => void)[]>();
const queue: MediaJob[] = [];
let running = 0;
let loaded = false;

const alive = (pid: number | undefined) => {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};
const foreign = (job: MediaJob) => !!job.owner && job.owner !== process.pid && alive(job.owner);

/** Load jobs; adopt unfinished jobs whose owner process is gone: re-poll the ones with a provider handle. */
function load() {
  if (loaded) return;
  loaded = true;
  for (const name of NodeFS.readdirSync(dir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(NodeFS.readFileSync(NodePath.join(dir(), name), "utf8")) as MediaJob;
      jobs.set(job.id, job);
      if (TERMINAL.has(job.state) || foreign(job)) continue;
      job.owner = process.pid;
      if (job.handle) {
        job.state = "running";
        job.detail = "resumed after restart";
        save(job);
        void track(job, () => resumeJob(job));
      } else if (job.state === "waiting") {
        // never reached a provider: safe to run now
        save(job);
        queue.push(job);
      } else {
        job.state = "uncertain";
        job.failure = makeFailure("ambiguous", "local", {
          accepted: true,
          message:
            "The server stopped while this job was being sent; no provider handle was saved.",
        });
        job.hint = job.failure.hint;
        save(job);
      }
    } catch {
      // ignore corrupt record
    }
  }
  pump();
}

/** Start-up hook: load jobs and resume unfinished ones. */
export function init() {
  load();
}

const save = (job: MediaJob) =>
  NodeFS.writeFileSync(NodePath.join(dir(), `${job.id}.json`), JSON.stringify(job, null, 2));

/** Jobs owned by another live server change on disk; re-read them. */
function fresh(job: MediaJob): MediaJob {
  if (TERMINAL.has(job.state) || !foreign(job)) return job;
  try {
    const disk = JSON.parse(
      NodeFS.readFileSync(NodePath.join(dir(), `${job.id}.json`), "utf8"),
    ) as MediaJob;
    jobs.set(job.id, disk);
    return disk;
  } catch {
    return job;
  }
}

function finish(job: MediaJob) {
  for (const resolve of waiters.get(job.id) ?? []) resolve(job);
  waiters.delete(job.id);
}

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "take"
  );
}

const reserved = new Map<string, number>();

function nextTakeNumber(d: string, base: string) {
  const re = new RegExp(`^${base}-take-(\\d+)`);
  const onDisk = NodeFS.readdirSync(d).reduce(
    (m, f) => Math.max(m, Number(f.match(re)?.[1] ?? 0)),
    0,
  );
  const key = `${d}|${base}`;
  const n = Math.max(onDisk, reserved.get(key) ?? 0) + 1;
  reserved.set(key, n);
  return n;
}

/** Move downloaded temp files to <slug>-take-NN[-i].<ext>: hard link = exclusive create; EEXIST → next number. */
export function placeTakes(
  projectPath: string,
  title: string,
  temps: { tmp: string; ext: string }[],
): string[] {
  const d = NodePath.join(projectPath, "takes");
  NodeFS.mkdirSync(d, { recursive: true });
  const base = slug(title);
  for (let tries = 0; tries < 50; tries++) {
    const n = String(nextTakeNumber(d, base)).padStart(2, "0");
    const paths = temps.map((t, i) =>
      NodePath.join(d, `${base}-take-${n}${temps.length > 1 ? `-${i + 1}` : ""}${t.ext}`),
    );
    const linked: string[] = [];
    try {
      for (const [i, t] of temps.entries()) {
        NodeFS.linkSync(t.tmp, paths[i]!);
        linked.push(paths[i]!);
      }
    } catch (error) {
      for (const l of linked) NodeFS.unlinkSync(l);
      if ((error as { code?: string }).code === "EEXIST") continue;
      throw error;
    }
    for (const t of temps) NodeFS.unlinkSync(t.tmp);
    return paths;
  }
  throw new MediaError("Could not find a free take number", "provider_error");
}

async function download(job: MediaJob, outputs: ProviderOutput[], signal: AbortSignal) {
  const tmpDir = NodePath.join(job.projectPath, "takes", ".tmp");
  NodeFS.mkdirSync(tmpDir, { recursive: true });
  const temps: { tmp: string; ext: string }[] = [];
  for (const [i, out] of outputs.entries()) {
    const tmp = NodePath.join(
      tmpDir,
      `${job.id}-${i}-${NodeCrypto.randomUUID().slice(0, 6)}${out.ext}`,
    );
    if (out.data) NodeFS.writeFileSync(tmp, out.data);
    else if (out.url) {
      let res: Response | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(out.url, { ...(out.headers ? { headers: out.headers } : {}), signal });
          if (res.ok || attempt >= 2 || res.status < 500) break;
        } catch (error) {
          if (signal.aborted || attempt >= 2) throw error;
        }
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
      if (!res?.ok) {
        const f = makeFailure("outage", (job.served?.provider as Provider | undefined) ?? "fal", {
          accepted: true,
          retryable: false,
          message: `Download of the result failed (${res?.status}).`,
          hint: "The result is probably still at the provider: run jobs_status {ids:[…], collect:true} to download it again (no new charge).",
        });
        throw new MediaError(f.message, "provider_error", f.hint, f);
      }
      NodeFS.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    }
    temps.push({ tmp, ext: out.ext });
  }
  return temps;
}

function failureOf(
  error: unknown,
  provider: Parameters<typeof classifyException>[0],
  phase: "submit" | "poll",
): Failure {
  if (error instanceof MediaError && error.failure) return error.failure;
  return classifyException(provider, error, { phase });
}

function markFailed(job: MediaJob, f: Failure, error?: unknown) {
  job.state = f.category === "ambiguous" && f.accepted ? "uncertain" : "failed";
  job.failure = f;
  job.error = error instanceof Error ? error.message : f.message;
  job.errorCode =
    error instanceof MediaError
      ? error.code
      : f.category === "auth"
        ? "missing_key"
        : f.category === "invalid_input"
          ? "bad_request"
          : "provider_error";
  job.hint = moderationHint(job, f) ?? f.hint;
}

/** Moderation: one retry allowed; a second refusal for the same title in this project means stop. */
function moderationHint(job: MediaJob, f: Failure) {
  if (f.category !== "moderation") return undefined;
  const earlier = [...jobs.values()].some(
    (j) =>
      j.id !== job.id &&
      j.projectPath === job.projectPath &&
      slug(j.title) === slug(job.title) &&
      j.failure?.category === "moderation" &&
      Date.now() - (j.finishedAt ?? 0) < 3600_000,
  );
  return earlier
    ? "Second safety refusal for this shot. Stop retrying; tell the user what was refused and ask how to change the idea. Never disable safety settings."
    : undefined;
}

function context(job: MediaJob, signal: AbortSignal): ProviderContext {
  return {
    keys: loadKeys(),
    signal,
    onStatus: (state, detail) => {
      if (job.state === "cancelled") return;
      job.state = state === "queued" ? "queued" : "running";
      if (detail !== undefined) job.detail = detail;
      else delete job.detail;
    },
    onHandle: (handle) => {
      job.handle = handle;
      job.submittedAt = Date.now();
      save(job);
    },
  };
}

async function runRoutes(
  job: MediaJob,
  signal: AbortSignal,
): Promise<{ prepared: Prepared; outputs: ProviderOutput[] }> {
  const keys = loadKeys();
  const ranked = await rankRoutes(job.request, keys);
  // Never run on a route dearer than what was quoted (and approved): that needs a new quote.
  if (job.priceCeiling !== undefined)
    for (const r of ranked.routes) {
      const max = r.estimate.usdMax;
      if (
        !r.skip &&
        (job.priceCeiling === null ? false : max === null || max > job.priceCeiling + 1e-6)
      )
        r.skip = `dearer than the quoted price ($${job.priceCeiling}/take); quote again to use it`;
    }
  for (const r of ranked.routes.filter((x) => x.skip))
    if (ranked.routes.length > 1)
      (job.attempts ??= []).push({
        route: r.model,
        at: Date.now(),
        outcome: "skipped",
        message: r.skip!,
      });
  const usable = ranked.routes.filter((x) => !x.skip);
  // Nothing usable: run the asked model anyway so the missing key / cooldown is reported as usual.
  const plan = usable.length
    ? usable
    : [ranked.routes.find((x) => x.model === job.model) ?? ranked.routes[0]!];
  const candidates = plan.map((x) => x.model);
  const attempts = (job.attempts = job.attempts ?? []);
  let last: { failure: Failure; error: unknown } | undefined;
  for (const [i, model] of candidates.entries()) {
    const provider = providerOf(model);
    const key = keys[KEY_OF[provider]];
    const more = i < candidates.length - 1;
    const routeRequest = plan[i]!.request;
    if (!key) {
      if (more || last) {
        attempts.push({
          route: model,
          at: Date.now(),
          outcome: "skipped",
          category: "auth",
          message: "no key",
        });
        last ??= {
          failure: makeFailure("auth", provider, {
            message: `No ${provider} key configured for ${model}.`,
          }),
          error: undefined,
        };
        continue;
      }
      requireKey(key, provider, provider);
    }
    const cooldown = activeCooldown(provider, model, key);
    if (cooldown) {
      attempts.push({
        route: model,
        at: Date.now(),
        outcome: "skipped",
        category: cooldown.category,
        message: `cooldown (${cooldown.scope}): ${cooldown.message}`,
      });
      last = {
        failure: makeFailure(cooldown.category, provider, {
          message: `${model} is cooling down after ${cooldown.category}: ${cooldown.message}`,
        }),
        error: undefined,
      };
      continue;
    }
    let prepared: Prepared;
    try {
      prepared = await prepare(routeRequest, model, keys, signal, job.kind);
    } catch (error) {
      // nothing was sent yet: a local exception (unreadable reference, converter bug) is invalid input, not "maybe charged"
      if (!(error instanceof MediaError)) {
        const local = makeFailure("invalid_input", "local", {
          message: `Could not prepare the request: ${(error as Error)?.message ?? String(error)}`,
        });
        throw new MediaError(local.message, "bad_request", local.hint, local);
      }
      const f = failureOf(error, provider, "submit");
      attempts.push({
        route: model,
        at: Date.now(),
        outcome: "failed",
        category: f.category,
        message: f.message,
      });
      noteCooldown(f, provider, model, key);
      if (f.category === "model_unavailable" && more) {
        last = { failure: f, error };
        continue;
      }
      throw error;
    }
    if (i > 0 && last)
      prepared.adjustments.unshift(
        `fell back from ${candidates[0]} to ${model} (${last.failure.category}; the first route did not accept the request)`,
      );
    job.served = { provider, model, endpoint: prepared.endpoint };
    job.kind = prepared.kind;
    job.native = sanitizeNative(prepared.native);
    job.adjustments = prepared.adjustments;
    const p = job.request.parameters ?? {};
    job.estimate = plan[i]!.quote
      ? plan[i]!.estimate
      : await pricing.estimate(
          {
            model: prepared.endpoint === model || provider !== "fal" ? model : prepared.endpoint,
            provider,
            kind: prepared.kind,
            ...opt({
              prompt: job.request.prompt,
              duration: nativeSeconds(prepared) ?? p.duration ?? job.request.meterSeconds,
              resolution: p.resolution,
              audio: p.audio,
              num_outputs: p.num_outputs,
            }),
          },
          keys.falApiKey,
        );
    const refusal = ledger.reserveAll(
      [
        {
          key: job.id,
          provider,
          model,
          payer: job.estimate.payer,
          estimateUsd: job.estimate.usd,
          maxUsd: job.estimate.usdMax,
          ...(job.approvalId ? { approvalId: job.approvalId } : {}),
        },
      ],
      job.chatId ?? spend.chatId(),
      spend.caps(job.chatId ?? spend.chatId()),
      {
        ...(job.allowUnpriced ? { allowUnpriced: true } : {}),
        fromKeys: [job.reservationKey],
      },
    );
    if (refusal) throw ledger.refusalError(refusal, 1);
    save(job);
    for (let retry = 0; ; retry++) {
      try {
        const outputs = await executeProvider(prepared, context(job, signal));
        attempts.push({
          route: model,
          endpoint: prepared.endpoint,
          at: Date.now(),
          outcome: "ok",
          adjustments: prepared.adjustments,
        });
        return { prepared, outputs };
      } catch (error) {
        if (signal.aborted) throw error;
        const f = failureOf(error, provider, job.handle ? "poll" : "submit");
        const again = !f.accepted && f.retryable && retry < RETRY.maxRetries;
        // cooldown only once the failure is final for this route (a retried blip must not bench the provider)
        if (!again) noteCooldown(f, provider, model, key);
        attempts.push({
          route: model,
          endpoint: prepared.endpoint,
          at: Date.now(),
          outcome: again ? "retry" : "failed",
          category: f.category,
          message: f.message,
          adjustments: prepared.adjustments,
        });
        if (again) {
          const wait = backoffMs(retry, f);
          job.detail = `${f.category}: retry ${retry + 1}/${RETRY.maxRetries} in ${Math.round(wait / 1000)}s`;
          save(job);
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, wait);
            signal.addEventListener(
              "abort",
              () => (clearTimeout(t), reject(new MediaError("Anulowano", "cancelled"))),
              { once: true },
            );
          });
          continue;
        }
        ledger.settle(job.id, f.accepted ? "spent" : "released");
        if (f.accepted || !FALLBACK_ON.has(f.category) || !more)
          throw error instanceof MediaError
            ? error
            : new MediaError(f.message, "provider_error", f.hint, f);
        delete job.handle;
        last = { failure: f, error };
        break;
      }
    }
  }
  if (last?.error) throw last.error;
  throw new MediaError(
    last?.failure.message ?? "No usable route",
    "provider_error",
    last?.failure.hint,
    last?.failure,
  );
}

export function handleId(h: ProviderHandle): string {
  switch (h.provider) {
    case "fal":
      return h.requestId;
    case "google":
      return h.operation;
    case "runware":
      return h.taskUUID;
    case "replicate":
      return h.id;
  }
}

/** Drop undefined values (exactOptionalPropertyTypes). */
function opt<T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Seconds the provider was actually asked for (after snapping), for pricing and the length check. */
function nativeSeconds(p: { native: Record<string, unknown> }): number | undefined {
  const n = p.native as Record<string, any>;
  const raw =
    n.duration ??
    n.duration_seconds ??
    n.parameters?.durationSeconds ??
    (n.music_length_ms !== undefined ? Number(n.music_length_ms) / 1000 : undefined);
  const s = Number(String(raw ?? "").match(/\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(s) && raw !== undefined ? s : undefined;
}

/** ffprobe the delivered length; warn if off by more than max(1 s, 5%). */
async function checkLength(job: MediaJob, paths: string[]) {
  if (!["video", "music", "sfx"].includes(job.kind)) return;
  const n = job.native as Record<string, unknown> | undefined;
  const expected = (n && nativeSeconds({ native: n })) ?? job.request.parameters?.duration;
  if (!expected) return;
  for (const p of paths) {
    try {
      const { stdout } = await run(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
        { timeout: 20_000 },
      );
      const actual = Number(stdout.trim());
      if (Number.isFinite(actual) && Math.abs(actual - expected) > Math.max(1, expected * 0.05))
        (job.warnings ??= []).push(
          `${p}: delivered ${actual.toFixed(1)} s, asked ${expected} s - trim/loop with ffmpeg or regenerate`,
        );
    } catch {
      // no ffprobe or unreadable file: skip the check
    }
  }
}

async function finalize(job: MediaJob, outputs: ProviderOutput[], signal: AbortSignal) {
  const temps = await download(job, outputs, signal);
  const paths = placeTakes(job.projectPath, job.title, temps);
  job.outputs = paths;
  job.finishedAt = Date.now();
  await checkLength(job, paths);
  const providerSeconds =
    (job.finishedAt - (job.submittedAt ?? job.startedAt ?? job.createdAt)) / 1000;
  timings.record(
    job.served?.provider === "fal" ? job.served.endpoint : (job.served?.model ?? job.model),
    providerSeconds,
  );
  // The provider's reported charge settles the ledger when every output carries one (Runware).
  const charges = outputs.map((o) => o.costUsd);
  if (charges.length && charges.every((c) => typeof c === "number"))
    job.chargeUsd = Math.round(charges.reduce((s, c) => s + c!, 0) * 1e6) / 1e6;
  ledger.settle(
    job.id,
    "spent",
    job.chargeUsd !== undefined ? { usd: job.chargeUsd, source: "provider" } : undefined,
  );
  const draftId = outputs.find((o) => o.draftId)?.draftId;
  if (draftId && job.served) {
    const days = 7; // fal: 14 days (7 for US drafts); Runware publishes none, so 7 for both.
    job.draft = {
      id: draftId,
      provider: job.served.provider,
      model: job.served.model,
      seconds:
        nativeSeconds({ native: (job.native ?? {}) as Record<string, unknown> }) ??
        job.request.parameters?.duration ??
        5,
      madeAt: job.finishedAt,
      expiresAt: job.finishedAt + days * 86_400_000,
    };
  }
  const refs = (job.request.references ?? []).map(describeRef);
  for (const path of paths) {
    try {
      writeSidecar(path, {
        jobId: job.id,
        kind: job.kind,
        model: job.model,
        served: job.served,
        prompt: job.prompt,
        generic: {
          parameters: job.request.parameters ?? {},
          references: refs,
          ...(job.request.endImage ? { endImage: describeRef(job.request.endImage) } : {}),
          route: job.request.route ?? "auto",
        },
        native: job.native,
        nativeOverrides: job.request.input,
        seed: job.request.parameters?.seed ?? (job.native as Record<string, any> | undefined)?.seed,
        providerRequestId: job.handle ? handleId(job.handle) : undefined,
        timings: {
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          submittedAt: job.submittedAt,
          finishedAt: job.finishedAt,
          providerSeconds: Math.round(providerSeconds),
        },
        attempts: job.attempts,
        adjustments: job.adjustments,
        cost: job.estimate,
        warnings: job.warnings,
        cast: job.cast,
        retryOf: job.retryOf,
        siblings: paths.length > 1 ? paths : undefined,
      });
    } catch {
      // the take matters more than its sidecar
    }
  }
  job.state = "completed";
  delete job.failure;
  delete job.error;
  delete job.errorCode;
  delete job.hint;
}

async function track(job: MediaJob, body: (signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  try {
    await body(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || (job.state as string) === "cancelled") {
      job.state = "cancelled";
      // cancelled before the provider took it → nothing charged
      ledger.settle(job.id, job.handle ? "spent" : "released");
    } else
      markFailed(
        job,
        failureOf(
          error,
          (job.served?.provider ?? providerOf(job.model)) as Parameters<
            typeof classifyException
          >[0],
          job.handle ? "poll" : "submit",
        ),
        error,
      );
  } finally {
    job.finishedAt ??= Date.now();
    controllers.delete(job.id);
    save(job);
    finish(job);
  }
}

async function executeJob(job: MediaJob) {
  job.state = "preparing";
  job.startedAt = Date.now();
  job.owner = process.pid;
  save(job);
  await track(job, async (signal) => {
    const { outputs } = await runRoutes(job, signal);
    await finalize(job, outputs, signal);
  });
  running--;
  pump();
}

async function resumeJob(job: MediaJob) {
  await track(job, async (signal) => {
    const outputs = await resumeProvider(job.handle!, context(job, signal));
    await finalize(job, outputs, signal);
  });
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const next = queue.shift()!;
    if (next.state === "cancelled") continue;
    running++;
    void executeJob(next);
  }
}

// ---------------- submit / query ----------------

function videoRef(v: string) {
  if (/^(https?:|data:)/.test(v)) return v;
  try {
    const st = NodeFS.statSync(v);
    return `file:${v}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `missing:${v}`;
  }
}

/** Content fingerprint: local references by their bytes (not paths); title/fresh/request_id excluded. */
export function fingerprintOf(request: GenerateRequest, projectPath: string) {
  const ref = (r: string) =>
    /^(https?:|data:)/.test(r)
      ? r
      : NodeFS.existsSync(r)
        ? `sha256:${sha256File(r)}`
        : `missing:${r}`;
  const { model, prompt, input, parameters, route } = request;
  const payload = {
    p: projectPath,
    model,
    prompt,
    input,
    parameters,
    route: route ?? "auto",
    refs: (request.references ?? []).map(ref),
    end: request.endImage ? ref(request.endImage) : undefined,
    // Source videos can be huge: identified by path, size and mtime instead of their bytes.
    video: request.video ? videoRef(request.video) : undefined,
    finish: request.finishDraft?.draftId,
  };
  return NodeCrypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

export function submit(
  request: GenerateRequest,
  opts: {
    projectPath: string;
    title?: string;
    fresh?: boolean;
    kind?: string;
    requestId?: string;
    allowUnpriced?: boolean;
    cast?: unknown[];
    retryOf?: string;
    chatId?: string;
    reservationKey?: string;
    priceCeiling?: number | null;
    approvalId?: string;
  },
) {
  load();
  const fingerprint = fingerprintOf(request, opts.projectPath);
  if (opts.requestId) {
    const same = [...jobs.values()].find(
      (j) => j.requestId === opts.requestId && j.projectPath === opts.projectPath,
    );
    if (same) {
      if (same.fingerprint !== fingerprint)
        throw new MediaError(
          `request_id "${opts.requestId}" was already used for a different request (job ${same.id}).`,
          "bad_request",
          "Use a new request_id for a changed request, or resend exactly the same input to get the same job back.",
        );
      return { job: fresh(same), reused: true };
    }
  }
  if (!opts.fresh && !opts.requestId) {
    const existing = [...jobs.values()].find(
      (j) =>
        j.fingerprint === fingerprint && !["failed", "cancelled", "uncertain"].includes(j.state),
    );
    if (
      existing &&
      (existing.state !== "completed" || existing.outputs?.every((p) => NodeFS.existsSync(p)))
    )
      return { job: fresh(existing), reused: true };
  }
  const kind = opts.kind ?? guessKind(request.model);
  const job: MediaJob = {
    id: NodeCrypto.randomUUID().slice(0, 12),
    projectPath: opts.projectPath,
    model: request.model,
    kind,
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    title: opts.title || request.prompt?.slice(0, 60) || kind,
    state: "waiting",
    fingerprint,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.allowUnpriced ? { allowUnpriced: true } : {}),
    ...(opts.cast?.length ? { cast: opts.cast } : {}),
    ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    chatId: opts.chatId ?? spend.chatId(),
    ...(opts.reservationKey ? { reservationKey: opts.reservationKey } : {}),
    ...(opts.priceCeiling !== undefined ? { priceCeiling: opts.priceCeiling } : {}),
    ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
    request,
    owner: process.pid,
    ...(process.env.T3CODE_THREAD_ID ? { threadId: process.env.T3CODE_THREAD_ID } : {}),
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  save(job);
  queue.push(job);
  pump();
  return { job, reused: false };
}

export function get(id: string) {
  load();
  const job = jobs.get(id);
  return job && fresh(job);
}

export function list(projectPath: string, limit = 15) {
  load();
  return [...jobs.values()]
    .filter((j) => j.projectPath === projectPath)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(fresh);
}

export function cancel(id: string) {
  const job = jobs.get(id);
  if (!job || TERMINAL.has(job.state)) return job;
  job.state = "cancelled";
  controllers.get(id)?.abort();
  save(job);
  finish(job);
  return job;
}

/**
 * Re-poll jobs that have a provider handle but no usable outputs (failed download, server restart,
 * uncertain state). Returns the jobs that were restarted.
 */
export function collect(ids: string[]) {
  load();
  const restarted: MediaJob[] = [];
  for (const id of ids) {
    const job = jobs.get(id);
    if (!job?.handle || controllers.has(id) || foreign(job) || job.state === "cancelled") continue;
    const missing = job.state !== "completed" || !job.outputs?.every((p) => NodeFS.existsSync(p));
    const terminalFailure =
      job.state === "failed" &&
      job.failure &&
      ["moderation", "invalid_input"].includes(job.failure.category);
    if (!missing || terminalFailure) continue;
    job.state = "running";
    job.detail = "recollecting";
    job.owner = process.pid;
    delete job.finishedAt;
    save(job);
    void track(job, () => resumeJob(job));
    restarted.push(job);
  }
  return restarted;
}

/** Equivalent route on the other provider (only for capacity / model_unavailable) when its key exists. */
export function alternativeOf(job: MediaJob): { model: string; reason: string } | undefined {
  const category = job.failure?.category;
  if (job.state !== "failed" || (category !== "capacity" && category !== "model_unavailable"))
    return undefined;
  let other: string | undefined;
  try {
    other = routeCandidates(job.model, "auto")[1];
  } catch {
    return undefined;
  }
  if (!other || !loadKeys()[KEY_OF[providerOf(other)]]) return undefined;
  return { model: other, reason: category };
}

export interface RetryPlan {
  request: GenerateRequest;
  kind: string;
  title: string;
  requestId: string;
  retryOf: string;
  allowUnpriced?: boolean;
  cast?: unknown[];
}

export type RetryResult =
  | { ok: true; action: "collect"; job: MediaJob }
  | { ok: true; action: "new"; job: MediaJob; reused: boolean }
  | { ok: true; action: "plan"; plan: RetryPlan }
  | { ok: false; code: ErrorCode; message: string; remedy: string };

/**
 * New job from a failed/cancelled/uncertain job's request: an accepted but undownloaded result is
 * collected, a possibly charged failure needs confirmFresh, the model must be the offered
 * alternative, and the request id derives from the old job so repeats resolve to one new job.
 */
export function retry(
  id: string,
  opts: { model?: string; confirmFresh?: boolean; projectPath: string; planOnly?: boolean },
): RetryResult {
  load();
  const old = get(id);
  const no = (code: ErrorCode, message: string, remedy: string): RetryResult => ({
    ok: false,
    code,
    message,
    remedy,
  });
  if (!old || old.projectPath !== opts.projectPath)
    return no("NOT_FOUND", `Unknown job '${id}' in this project.`, "Use jobs_status to list jobs.");
  if (!TERMINAL.has(old.state))
    return no(
      "CONFLICT",
      `Job ${old.id} is ${old.state}; only failed, cancelled or uncertain jobs are retried.`,
      "Use jobs_wait, or jobs_cancel first.",
    );
  if (old.state === "completed" && old.outputs?.every((p) => NodeFS.existsSync(p)))
    return no(
      "CONFLICT",
      `Job ${old.id} completed and its files exist.`,
      "Nothing to retry; use media_generate fresh=true for a new take.",
    );
  const wantModel = opts.model && opts.model !== old.model ? opts.model : undefined;
  if (wantModel) {
    const alt = alternativeOf(old);
    if (!alt)
      return no(
        "INVALID_INPUT",
        `Job ${old.id} has no alternative model (only capacity / model_unavailable failures with a key for the equivalent route offer one).`,
        "Retry without model, or pick a model yourself with media_generate.",
      );
    if (wantModel !== alt.model)
      return no(
        "INVALID_INPUT",
        `model must be the alternative offered for this failure: ${alt.model}.`,
        `jobs_retry {id:"${old.id}", model:"${alt.model}"}`,
      );
  }
  // result already at the provider: collect, never pay twice (needs the same model, no alternative)
  const failedDownload =
    !!old.failure && /^Download of the result failed/.test(old.failure.message);
  if (
    old.handle &&
    !wantModel &&
    !(old.failure && ["moderation", "invalid_input"].includes(old.failure.category))
  ) {
    if (controllers.has(old.id) || foreign(old))
      return no(
        "CONFLICT",
        `Job ${old.id} is being polled by another server.`,
        "Wait, then jobs_status.",
      );
    if (collect([old.id]).length) return { ok: true, action: "collect", job: get(old.id)! };
    return no(
      failedDownload ? "COLLECTION_FAILED" : "CONFLICT",
      `Could not re-collect job ${old.id}.`,
      "Try jobs_status {collect:true} later, or retry with confirm_fresh after telling the user it may cost again.",
    );
  }
  const mayHaveBeenCharged = old.state === "uncertain" || !!old.failure?.accepted;
  if (mayHaveBeenCharged && !opts.confirmFresh && !wantModel)
    return no(
      "CONFIRM_REQUIRED",
      `Job ${old.id} was accepted by the provider before it failed and may already have been charged; a fresh run could cost twice.`,
      "Tell the user, and only after their OK call jobs_retry again with confirm_fresh=true.",
    );
  if (mayHaveBeenCharged && wantModel && !opts.confirmFresh)
    return no(
      "CONFIRM_REQUIRED",
      `Job ${old.id} was accepted before it failed (possibly charged); switching model would pay again.`,
      "Tell the user, then jobs_retry with confirm_fresh=true.",
    );
  const request: GenerateRequest = {
    ...old.request,
    ...(wantModel ? { model: wantModel, route: "exact" as const } : {}),
  };
  const requestId = `retry-${old.id}-${(wantModel ?? old.model).replace(/[^\w.-]+/g, "_")}${opts.confirmFresh ? "-paid" : ""}`;
  // A paid retry goes through the same quote / approval / cap path as any batch.
  if (opts.planOnly)
    return {
      ok: true,
      action: "plan",
      plan: {
        request,
        kind: old.kind,
        title: old.title,
        requestId,
        retryOf: old.id,
        ...(old.allowUnpriced ? { allowUnpriced: true } : {}),
        ...(old.cast ? { cast: old.cast } : {}),
      },
    };
  try {
    const { job, reused } = submit(request, {
      projectPath: old.projectPath,
      kind: old.kind,
      title: old.title,
      requestId: `retry-${old.id}-${(wantModel ?? old.model).replace(/[^\w.-]+/g, "_")}${opts.confirmFresh ? "-paid" : ""}`,
      retryOf: old.id,
      ...(old.chatId ? { chatId: old.chatId } : {}),
      ...(old.allowUnpriced ? { allowUnpriced: true } : {}),
      ...(old.cast ? { cast: old.cast } : {}),
    });
    return { ok: true, action: "new", job, reused };
  } catch (error) {
    return no(
      "INVALID_INPUT",
      (error as Error).message,
      (error as MediaError).hint ?? "Check the job's request.",
    );
  }
}

export async function wait(
  ids: string[],
  mode: "all" | "any",
  timeoutMs: number,
): Promise<MediaJob[]> {
  load();
  const pending = ids.map((id) => get(id)).filter((j): j is MediaJob => !!j);
  const open = pending.filter((j) => !TERMINAL.has(j.state));
  if (open.length === 0 || (mode === "any" && open.length < pending.length)) return pending;
  // Foreign jobs don't notify us; poll the disk for them.
  const promises = open.map((j) =>
    foreign(j)
      ? new Promise<MediaJob>((res) => {
          const t = setInterval(() => {
            const now = fresh(j);
            if (TERMINAL.has(now.state)) {
              clearInterval(t);
              res(now);
            }
          }, 2000);
          setTimeout(() => clearInterval(t), timeoutMs);
        })
      : new Promise<MediaJob>((res) => waiters.set(j.id, [...(waiters.get(j.id) ?? []), res])),
  );
  await Promise.race([
    new Promise((r) => setTimeout(r, timeoutMs)),
    mode === "all" ? Promise.all(promises) : Promise.race(promises),
  ]);
  return ids.map((id) => get(id)).filter((j): j is MediaJob => !!j);
}

/** Timing view of a running job (typical/p90 per endpoint, slowness flags). */
export function timing(job: MediaJob) {
  const key =
    job.served?.provider === "fal" ? job.served.endpoint : (job.served?.model ?? job.model);
  const elapsed = Math.round(
    ((job.finishedAt ?? Date.now()) - (job.submittedAt ?? job.startedAt ?? job.createdAt)) / 1000,
  );
  return { elapsedSeconds: elapsed, ...timings.slowness(key, job.kind, elapsed) };
}

export function describe(job: MediaJob) {
  const elapsed = Math.round(
    ((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.createdAt)) / 1000,
  );
  const served =
    job.served && job.served.endpoint !== job.model
      ? ` → ${job.served.provider}:${job.served.endpoint}`
      : "";
  const lines = [`job ${job.id} [${job.state}] ${job.model}${served} · ${elapsed}s`];
  if (job.detail && !TERMINAL.has(job.state)) lines.push(`  ${job.detail}`);
  if (!TERMINAL.has(job.state)) {
    const t = timing(job);
    lines.push(
      `  typicalSeconds=${t.typicalSeconds} (p90 ${t.p90Seconds}s), elapsed ${t.elapsedSeconds}s${t.unusuallySlow ? ", unusuallySlow=true" : ""}${t.stalled ? ", stalled=true" : ""}`,
    );
    if (t.unusuallySlow || t.stalled)
      lines.push(
        "  Taking much longer than usual. Stop polling; tell the user and offer: keep waiting (jobs_wait later), switch to another model, or cancel (jobs_cancel). Cancelling an accepted job may still be charged.",
      );
  }
  if (job.adjustments?.length) lines.push(`  adjustments: ${job.adjustments.join("; ")}`);
  if (job.estimate)
    lines.push(
      `  cost: ${job.chargeUsd !== undefined ? `$${job.chargeUsd} charged` : job.estimate.usd === null ? `unknown${job.estimate.usdMax !== null ? ` (up to $${job.estimate.usdMax})` : ""}` : `~$${job.estimate.usd}`} (${job.estimate.payer}${job.chargeUsd !== undefined ? ", reported by the provider" : ", approximate"})`,
    );
  if (job.draft)
    lines.push(
      `  draft ${job.draft.id} (${job.draft.provider}): finish this same take at 1080p with media_finish_draft {job_id:"${job.id}"} before ${new Date(job.draft.expiresAt).toISOString().slice(0, 10)} (quote first: media_estimate {finish_of:"${job.id}"})`,
    );
  if (job.cast?.length)
    lines.push(`  cast: ${(job.cast as { id: string }[]).map((c) => c.id).join(", ")}`);
  if (job.retryOf) lines.push(`  retry of job ${job.retryOf}`);
  if (job.outputs?.length) lines.push(...job.outputs.map((p) => `  → ${p}`));
  if (job.warnings?.length) lines.push(...job.warnings.map((w) => `  warning: ${w}`));
  if (job.state === "failed" || job.state === "uncertain") {
    const f = job.failure;
    lines.push(
      `  error (${f ? `${f.category}, accepted=${f.accepted}, retryable=${f.retryable}` : job.errorCode}): ${job.error ?? f?.message ?? ""}${job.hint ? `\n  hint: ${job.hint}` : ""}`,
    );
    const alt = alternativeOf(job);
    if (alt)
      lines.push(
        `  alternative: ${alt.model} (equivalent route, ${alt.reason}) - jobs_retry {id:"${job.id}", model:"${alt.model}"}`,
      );
    if (job.failure && /^Download of the result failed/.test(job.failure.message))
      lines.push(
        `  code: COLLECTION_FAILED (provider finished, files not collected) - jobs_retry {id:"${job.id}"} collects without paying again`,
      );
    const tried = job.attempts?.filter((a) => a.outcome !== "ok");
    if (tried && tried.length > 1)
      lines.push(
        `  attempts: ${tried.map((a) => `${a.route} ${a.outcome}${a.category ? ` (${a.category})` : ""}`).join(", ")}`,
      );
  }
  return lines.join("\n");
}

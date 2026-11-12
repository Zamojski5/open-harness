import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  resolveProviderFailureKind,
  type OrchestrationV2ProviderFailure,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Open Herness: context overflow / image errors compact once then continue (DeepSeek Harness
// overflow retry, behaviour only); temporary failures continue after 30 s, 2 min, 10 min (3 max).
// Only user-started turns or this service's own transient chain are recovered; timers are in memory.
const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const RECOVERY_PREFIX = "oh-recover:";
/** Tools that spend money on generation (creative media jobs, hosted generators). */
const PAID_GENERATION =
  /(media_generate|generate_(image|video|audio|3d)|_batch$|upscale_(image|video)|motion_control|ai_influencer_generate|ads_studio_generate|seedance|veo|kling)/i;
const TRANSIENT_KINDS = new Set([
  "transport",
  "provider-busy",
  "process-exit",
  "sdk-response-validation",
]);

export type RecoveryPlan =
  | { readonly type: "compact"; readonly cause: "context" | "image" }
  | { readonly type: "resume"; readonly attempt: number; readonly delayMs: number }
  | null;

/** What to do about a failed run, from its failure and the message that started it. */
export function planRecovery(input: {
  readonly failure: OrchestrationV2ProviderFailure;
  readonly triggerMessageId: string;
  readonly triggerCreatedBy: "user" | "agent" | "system";
  /** Compaction is a Claude Code command; other providers only surface the error. */
  readonly claude?: boolean;
  /** The failed turn ran paid generation tools: never repeat that without the user. */
  readonly paidGeneration?: boolean;
}): RecoveryPlan {
  if (input.failure.class === "usage_limit") return null;
  const kind = resolveProviderFailureKind(input.failure);
  const ours = input.triggerMessageId.startsWith(RECOVERY_PREFIX);
  const fromUser = input.triggerCreatedBy === "user" && !ours;
  if (
    kind === "context-length" ||
    input.failure.code === "image_error" ||
    input.failure.code === "prompt_too_long"
  )
    return fromUser && input.claude !== false
      ? { type: "compact", cause: kind === "context-length" ? "context" : "image" }
      : null;
  if (!TRANSIENT_KINDS.has(kind) || input.failure.retryable === false) return null;
  if (input.paidGeneration === true) return null;
  const previous = /^oh-recover:transient:(\d+):/.exec(input.triggerMessageId);
  if (!fromUser && previous === null) return null;
  const attempt = previous === null ? 1 : Number(previous[1]) + 1;
  const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt - 1];
  return delayMs === undefined ? null : { type: "resume", attempt, delayMs };
}

const CONTINUE_AFTER_COMPACT = {
  context:
    "Continue where you left off. The last request stopped because the conversation no longer fit the context window; it has been compacted, so pick the work up from the summary.",
  image:
    "Continue where you left off. The last request stopped because an image in the conversation could not be processed; it has been compacted. Look at large images through downscaled copies instead of attaching them full size.",
} as const;

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Resuming without the user is opt-in: the same "auto-resume" setting as usage limits (off by
  // default), read again when the wait ends so switching it off cancels a waiting resume.
  const autoResumeAllowed = settings.getSettings.pipe(
    Effect.map((current) => current.autoResumeLimitedThreads),
  );

  // The failed run is still the thread's latest, and nothing waits on the user.
  const stillFailed = Effect.fn("FailureRecoveryService.stillFailed")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const thread = yield* projections.getThread(threadId);
    if (thread.archivedAt !== null || thread.settledOverride === "settled") return false;
    const records = yield* projections.getThreadRecords(threadId, ["runs", "runtimeRequests"], {
      includeLatestRun: true,
      runIds: [runId],
      runtimeRequestStatuses: ["pending"],
    });
    if (records.runtimeRequests.length > 0) return false;
    const latest = records.runs.reduce<(typeof records.runs)[number] | undefined>(
      (best, run) => (best === undefined || run.ordinal > best.ordinal ? run : best),
      undefined,
    );
    return latest?.id === runId && latest.status === "failed";
  });

  const recover = Effect.fn("FailureRecoveryService.recover")(
    function* (threadId: ThreadId, runId: RunId) {
      const records = yield* projections.getThreadRecords(
        threadId,
        ["runs", "turnItems", "providerThreads"],
        {
          runIds: [runId],
          turnItemRunIds: [runId],
          turnItemTypes: ["error", "dynamic_tool"],
        },
      );
      const run = records.runs.find((candidate) => candidate.id === runId);
      if (run === undefined || run.status !== "failed") return;
      const failureItem = records.turnItems
        .filter((item) => item.type === "error" && item.status === "failed")
        .filter((item) => run.rootNodeId === null || item.nodeId === run.rootNodeId)
        .at(-1);
      if (failureItem?.type !== "error") return;
      const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: [run.userMessageId],
      });
      const trigger = messages.find((message) => message.id === run.userMessageId);
      if (trigger === undefined) return;
      const driver = records.providerThreads.find(
        (thread) => thread.id === run.providerThreadId,
      )?.driver;
      const paidGeneration = records.turnItems.some(
        (item) =>
          item.type === "dynamic_tool" &&
          item.toolName !== null &&
          PAID_GENERATION.test(item.toolName),
      );
      const plan = planRecovery({
        failure: failureItem.failure,
        triggerMessageId: trigger.id,
        triggerCreatedBy: trigger.createdBy,
        ...(driver === undefined ? {} : { claude: driver === "claudeAgent" }),
        paidGeneration,
      });
      if (plan === null) return;
      if (plan.type === "resume") {
        if (!(yield* autoResumeAllowed)) return;
        yield* Effect.logInfo("orchestration-v2.failure-recovery.resume-scheduled", {
          threadId,
          runId,
          attempt: plan.attempt,
          delayMs: plan.delayMs,
        });
        yield* Effect.sleep(Duration.millis(plan.delayMs));
        if (!(yield* autoResumeAllowed) || !(yield* stillFailed(threadId, runId))) return;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:oh-recover:${threadId}:${runId}`),
          messageId: MessageId.make(`${RECOVERY_PREFIX}transient:${plan.attempt}:${runId}`),
          threadId,
          text: "Continue where you left off. The last attempt failed on a temporary provider or connection error.",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
        return;
      }
      if (!(yield* stillFailed(threadId, runId))) return;
      yield* Effect.logInfo("orchestration-v2.failure-recovery.compact", {
        threadId,
        runId,
        cause: plan.cause,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:oh-recover-compact:${threadId}:${runId}`),
        messageId: MessageId.make(`${RECOVERY_PREFIX}compact:${runId}`),
        threadId,
        text: IDLE_COMPACTION_TEXT,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:oh-recover-continue:${threadId}:${runId}`),
        messageId: MessageId.make(`${RECOVERY_PREFIX}continue:${runId}`),
        threadId,
        text: CONTINUE_AFTER_COMPACT[plan.cause],
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("orchestration-v2.failure-recovery.skipped", { threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("FailureRecoveryService.start")(function* () {
    const enabled = yield* Config.String("OH_AUTO_RECOVERY").pipe(Config.withDefault("on"));
    if (enabled === "off") return;
    // Keyed by thread: a newer failure replaces a waiting retry.
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? FiberMap.run(timers, event.threadId, recover(event.threadId, event.payload.id))
          : Effect.void,
      ),
    );
    yield* Effect.logDebug("orchestration-v2.failure-recovery.started", {
      at: DateTime.formatIso(yield* DateTime.now),
    });
  });
  return { start };
});

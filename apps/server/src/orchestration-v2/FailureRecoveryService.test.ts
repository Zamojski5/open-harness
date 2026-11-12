import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as FailureRecoveryService from "./FailureRecoveryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const { planRecovery } = FailureRecoveryService;
const NOW_MS = Date.parse("2026-11-05T12:00:00.000Z");
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("recover-thread");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("root-node");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

const failure = (fields: Parameters<typeof makeProviderFailure>[0]) => makeProviderFailure(fields);
const overflow = failure({
  class: "provider_error",
  code: "prompt_too_long",
  kind: "context-length",
  message: "full",
});
const busy = failure({
  class: "provider_error",
  code: "api_error_529",
  kind: "provider-busy",
  message: "busy",
  retryable: true,
});

describe("planRecovery", () => {
  const plan = (f: OrchestrationV2ProviderFailure, id = "m1", by: "user" | "agent" = "user") =>
    planRecovery({ failure: f, triggerMessageId: id, triggerCreatedBy: by });

  it("compacts once after a context overflow or image error started by the user", () => {
    expect(plan(overflow)).toEqual({ type: "compact", cause: "context" });
    expect(
      plan(
        failure({
          class: "provider_error",
          code: "image_error",
          kind: "invalid-request",
          message: "img",
        }),
      ),
    ).toEqual({
      type: "compact",
      cause: "image",
    });
    expect(plan(overflow, "oh-recover:continue:run-0", "agent")).toBeNull();
    expect(plan(overflow, "limit-resume:x", "agent")).toBeNull();
  });

  it("resumes transient failures with 30 s, 2 min, 10 min backoff, three times at most", () => {
    expect(plan(busy)).toEqual({ type: "resume", attempt: 1, delayMs: 30_000 });
    expect(plan(busy, "oh-recover:transient:1:run-1", "agent")).toEqual({
      type: "resume",
      attempt: 2,
      delayMs: 120_000,
    });
    expect(plan(busy, "oh-recover:transient:2:run-2", "agent")).toEqual({
      type: "resume",
      attempt: 3,
      delayMs: 600_000,
    });
    expect(plan(busy, "oh-recover:transient:3:run-3", "agent")).toBeNull();
    expect(plan(failure({ class: "transport_error", message: "socket ECONNRESET" }))?.type).toBe(
      "resume",
    );
  });

  it("compacts only Claude threads and never repeats paid generation", () => {
    expect(
      planRecovery({
        failure: overflow,
        triggerMessageId: "m1",
        triggerCreatedBy: "user",
        claude: false,
      }),
    ).toBeNull();
    expect(
      planRecovery({
        failure: busy,
        triggerMessageId: "m1",
        triggerCreatedBy: "user",
        paidGeneration: true,
      }),
    ).toBeNull();
    expect(
      planRecovery({
        failure: busy,
        triggerMessageId: "m1",
        triggerCreatedBy: "user",
        claude: false,
      })?.type,
    ).toBe("resume");
  });

  it("leaves usage limits, auth, invalid requests, unresponsive turns and unknown failures alone", () => {
    expect(
      plan(failure({ class: "usage_limit", message: "limit", kind: "quota", retryable: true })),
    ).toBeNull();
    expect(
      plan(failure({ class: "permission_error", message: "x", kind: "authentication" })),
    ).toBeNull();
    expect(
      plan(failure({ class: "validation_error", message: "x", kind: "invalid-request" })),
    ).toBeNull();
    expect(
      plan(
        failure({ class: "transport_error", message: "x", kind: "unresponsive", retryable: false }),
      ),
    ).toBeNull();
    expect(plan(failure({ class: "unknown", message: "x" }))).toBeNull();
  });
});

function projection(
  f: OrchestrationV2ProviderFailure,
  latestRunId = runId,
): OrchestrationV2ThreadProjection {
  const messageId = MessageId.make("message-1");
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: messageId,
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "failed" as const,
    requestedAt: at(-60_000),
    startedAt: at(-60_000),
    completedAt: at(),
    checkpointId: null,
    contextHandoffId: null,
  };
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-60_000),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs:
      latestRunId === runId
        ? [run]
        : [run, { ...run, id: latestRunId, ordinal: 2, status: "running" as const }],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Make the film",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-60_000),
        updatedAt: at(-60_000),
      },
    ],
    turnItems: [
      makeProviderFailureTurnItem({
        driver: ProviderDriverKind.make("claudeAgent"),
        threadId,
        runId,
        nodeId,
        providerThreadId,
        providerTurnId: ProviderTurnId.make("turn-1"),
        itemOrdinal: 1,
        failure: f,
        occurredAt: at(),
      }),
    ],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    contextTransfers: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    plans: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    visibleTurnItems: [],
    updatedAt: at(),
  };
}

const runService = (
  data: OrchestrationV2ThreadProjection,
  after: Effect.Effect<void>,
  autoResume = true,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const dispatched: Array<{ readonly id: string; readonly mode: string; readonly text: string }> =
      [];
    const streamDone = yield* Deferred.make<void>();
    const dependencies = Layer.mergeAll(
      // The test environment switches recovery off for upstream suites; this one switches it on.
      ConfigProvider.layer(ConfigProvider.fromUnknown({ OH_AUTO_RECOVERY: "on" })),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.make({
          id: EventId.make("failed-run-1"),
          type: "run.updated" as const,
          threadId,
          runId,
          occurredAt: at(),
          payload: data.runs[0]!,
        }).pipe(Stream.ensuring(Deferred.succeed(streamDone, undefined))),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type === "message.dispatch")
              dispatched.push({
                id: command.messageId,
                mode: command.dispatchMode.type,
                text: command.text,
              });
            return { sequence: 1, storedEvents: [] };
          }),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          autoResumeLimitedThreads: autoResume,
        }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: () => Effect.succeed(data.thread),
        getThreadRecords: (_threadId, _keys, options) =>
          Effect.succeed({
            ...data,
            messages: data.messages.filter(
              (message) =>
                options?.messageIds === undefined || options.messageIds.includes(message.id),
            ),
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* FailureRecoveryService.make;
      yield* service.start();
      yield* Deferred.await(streamDone);
      yield* after;
    }).pipe(Effect.provide(dependencies));
    return dispatched;
  });

describe("FailureRecoveryService", () => {
  it.effect("compacts and continues after a context overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched = yield* runService(projection(overflow), TestClock.adjust(1_000));
        expect(dispatched.map((d) => [d.id, d.mode])).toEqual([
          ["oh-recover:compact:run-1", "start_immediately"],
          ["oh-recover:continue:run-1", "queue_after_active"],
        ]);
        expect(dispatched[0]!.text).toBe("/compact");
      }),
    ),
  );

  it.effect("resumes a transient failure after 30 seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const early = yield* runService(projection(busy), TestClock.adjust(29_000));
        expect(early).toEqual([]);
        const dispatched = yield* runService(projection(busy), TestClock.adjust(31_000));
        expect(dispatched.map((d) => d.id)).toEqual(["oh-recover:transient:1:run-1"]);
      }),
    ),
  );

  it.effect("does not resume unless the user turned auto-resume on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched = yield* runService(projection(busy), TestClock.adjust(31_000), false);
        expect(dispatched).toEqual([]);
      }),
    ),
  );

  it.effect("does not resume when the thread moved on while waiting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched = yield* runService(
          projection(busy, RunId.make("run-2")),
          TestClock.adjust(31_000),
        );
        expect(dispatched).toEqual([]);
      }),
    ),
  );
});

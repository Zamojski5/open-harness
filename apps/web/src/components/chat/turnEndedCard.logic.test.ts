import { describe, expect, it } from "vite-plus/test";

import {
  CONTINUE_PROMPT,
  deriveTurnEndedCard,
  isServerPaidGenerationTool,
  predictTurnRecovery,
  resolveTurnFailureKind,
  turnFailureGuidance,
  type TurnEndedInput,
} from "./turnEndedCard.logic";

const base: TurnEndedInput = {
  latestRun: { status: "failed", userMessageId: "u1" },
  messages: [{ id: "u1", role: "user", text: "render the shot", attachments: [] }],
  failure: { message: "Request failed", failureClass: "provider_error", code: null },
  runHadWork: false,
  working: false,
  readOnly: false,
};

describe("resolveTurnFailureKind", () => {
  it("uses a known server kind, including snake_case aliases", () => {
    expect(resolveTurnFailureKind({ kind: "context-length" })).toBe("context-length");
    expect(resolveTurnFailureKind({ kind: "provider_busy" })).toBe("provider-busy");
  });
  it("falls back to inference when the kind is absent or unknown", () => {
    expect(resolveTurnFailureKind({ kind: "brand-new", message: "Overloaded (529)" })).toBe(
      "provider-busy",
    );
    expect(resolveTurnFailureKind({ message: "prompt is too long: 210000 tokens" })).toBe(
      "context-length",
    );
    expect(resolveTurnFailureKind({ message: "401 Unauthorized: invalid api key" })).toBe(
      "authentication",
    );
    expect(resolveTurnFailureKind({ failureClass: "usage_limit", message: "x" })).toBe("quota");
    expect(resolveTurnFailureKind({ failureClass: "transport_error", message: "x" })).toBe(
      "transport",
    );
    expect(resolveTurnFailureKind({ message: "something odd" })).toBe("unknown");
  });
  it("has no guidance for unknown", () => {
    expect(turnFailureGuidance("unknown")).toBeNull();
    expect(turnFailureGuidance("transport")).not.toBeNull();
  });
});

describe("deriveTurnEndedCard", () => {
  it("shows nothing while working, in read-only chats, or after a newer message", () => {
    expect(deriveTurnEndedCard({ ...base, working: true })).toBeNull();
    expect(deriveTurnEndedCard({ ...base, readOnly: true })).toBeNull();
    expect(
      deriveTurnEndedCard({
        ...base,
        messages: [...base.messages, { id: "u2", role: "user", text: "next", attachments: [] }],
      }),
    ).toBeNull();
    expect(
      deriveTurnEndedCard({ ...base, latestRun: { status: "completed", userMessageId: "u1" } }),
    ).toBeNull();
  });
  it("resends the prompt when the turn produced nothing, else asks to continue", () => {
    expect(deriveTurnEndedCard(base)?.retryText).toBe("render the shot");
    expect(deriveTurnEndedCard({ ...base, runHadWork: true })?.retryText).toBe(CONTINUE_PROMPT);
    expect(
      deriveTurnEndedCard({
        ...base,
        runHadWork: true,
        messages: [{ id: "u1", role: "user", text: "see", attachments: [{}] }],
      })?.retryText,
    ).toBe(CONTINUE_PROMPT);
  });
  it("labels the primary Continue, or Try again for busy/unresponsive", () => {
    expect(deriveTurnEndedCard(base)?.buttons).toEqual([
      { action: "retry", label: "Continue", variant: "default" },
    ]);
    expect(
      deriveTurnEndedCard({ ...base, failure: { kind: "provider-busy" } })?.buttons[0]?.label,
    ).toBe("Try again");
  });
  it("orders kind-specific actions before the retry", () => {
    const context = deriveTurnEndedCard({ ...base, failure: { kind: "context-length" } });
    expect(context?.buttons.map((button) => [button.action, button.variant])).toEqual([
      ["start-new-chat", "default"],
      ["retry", "outline"],
    ]);
    const refused = deriveTurnEndedCard({ ...base, failure: { kind: "conversation-refused" } });
    expect(refused?.buttons.map((button) => button.action)).toEqual(["continue-in-new-chat"]);
    const auth = deriveTurnEndedCard({ ...base, failure: { kind: "authentication" } });
    expect(auth?.buttons.map((button) => button.label)).toEqual(["Sign in", "Try again"]);
  });
  it("leaves quota failures to the usage-limit banner", () => {
    expect(deriveTurnEndedCard({ ...base, failure: { kind: "quota" } })).toBeNull();
  });
  it("rewrites disk-full failures", () => {
    const card = deriveTurnEndedCard({ ...base, failure: { message: "SQLITE_FULL: disk full" } });
    expect(card?.title).toBe("The disk is full");
  });
  it("offers Try again and Edit prompt after a user stop", () => {
    const stopped = deriveTurnEndedCard({
      ...base,
      latestRun: { status: "interrupted", userMessageId: "u1" },
    });
    expect(stopped?.variant).toBe("stopped");
    expect(stopped?.buttons.map((button) => button.action)).toEqual(["retry", "edit-prompt"]);
    const withImage = deriveTurnEndedCard({
      ...base,
      latestRun: { status: "interrupted", userMessageId: "u1" },
      messages: [{ id: "u1", role: "user", text: "x", attachments: [{}] }],
    });
    expect(withImage?.buttons.map((button) => button.action)).toEqual(["edit-prompt"]);
  });
});

describe("review fixes", () => {
  it("B2: connection-refused transport errors are transport and offer a retry", () => {
    const failure = {
      message: "connect ECONNREFUSED 127.0.0.1:443",
      failureClass: "transport_error" as const,
    };
    expect(resolveTurnFailureKind(failure)).toBe("transport");
    expect(resolveTurnFailureKind({ message: "Connection refused by proxy" })).toBe("transport");
    const card = deriveTurnEndedCard({ ...base, failure });
    expect(card?.title).not.toContain("refused");
    expect(card?.buttons.map((button) => button.action)).toEqual(["retry"]);
  });
  it("B2: wording misfires from the review stay out", () => {
    expect(resolveTurnFailureKind({ message: "try again later (log in to view status)" })).not.toBe(
      "authentication",
    );
    expect(resolveTurnFailureKind({ message: "Bash tool failed: exit code 1" })).not.toBe(
      "process-exit",
    );
    expect(resolveTurnFailureKind({ message: "API Error: 529 overloaded" })).toBe("provider-busy");
    expect(resolveTurnFailureKind({ message: "image could not be processed" })).toBe(
      "conversation-refused",
    );
  });
  it("treats an explicit unknown kind as absent", () => {
    expect(resolveTurnFailureKind({ kind: "unknown", message: "not logged in" })).toBe(
      "authentication",
    );
  });
  it("M7: predicts the server's own recovery and shows it instead of manual fixes", () => {
    expect(
      predictTurnRecovery({
        kind: "context-length",
        failureClass: "provider_error",
        code: "prompt_too_long",
        retryable: null,
        triggerMessageId: "m1",
        triggerRole: "user",
        failedAtMs: 0,
      }),
    ).toEqual({ type: "compact" });
    expect(
      predictTurnRecovery({
        kind: "transport",
        failureClass: "transport_error",
        code: null,
        retryable: true,
        triggerMessageId: "oh-recover:transient:1:run",
        triggerRole: "user",
        failedAtMs: 1_000,
        autoResume: true,
      }),
    ).toEqual({ type: "resume", attempt: 2, atMs: 121_000 });
    expect(
      predictTurnRecovery({
        kind: "transport",
        failureClass: "transport_error",
        code: null,
        retryable: true,
        triggerMessageId: "oh-recover:transient:3:run",
        triggerRole: "user",
        failedAtMs: 0,
        autoResume: true,
      }),
    ).toBeNull();
    // Integration: matches server-behaviour's opt-in resume, paid-turn and Claude-only rules.
    const transient = {
      kind: "transport",
      failureClass: "transport_error",
      code: null,
      retryable: true,
      triggerMessageId: "m1",
      triggerRole: "user",
      failedAtMs: 0,
    } as const;
    expect(predictTurnRecovery(transient)).toBeNull();
    expect(predictTurnRecovery({ ...transient, autoResume: false })).toBeNull();
    expect(predictTurnRecovery({ ...transient, autoResume: true })).toEqual({
      type: "resume",
      attempt: 1,
      atMs: 30_000,
    });
    expect(
      predictTurnRecovery({ ...transient, autoResume: true, paidGeneration: true }),
    ).toBeNull();
    expect(isServerPaidGenerationTool("mcp__open-herness-creative__media_generate_batch")).toBe(
      true,
    );
    expect(isServerPaidGenerationTool("mcp__claude_ai_Higgsfield_MCP__generate_video")).toBe(true);
    expect(isServerPaidGenerationTool("mcp__open-herness-creative__jobs_status")).toBe(false);
    expect(
      predictTurnRecovery({
        kind: "context-length",
        failureClass: "provider_error",
        code: "prompt_too_long",
        retryable: null,
        triggerMessageId: "m1",
        triggerRole: "user",
        failedAtMs: 0,
        claude: false,
      }),
    ).toBeNull();
    const card = deriveTurnEndedCard({
      ...base,
      failure: { kind: "context-length" },
      recovery: { type: "compact" },
    });
    expect(card?.buttons.map((button) => [button.label, button.variant])).toEqual([
      ["Try now", "outline"],
    ]);
    expect(card?.guidance).toBeNull();
  });
  it("M8: a failed turn with files and no output offers Edit and resend, not a bare nudge", () => {
    const card = deriveTurnEndedCard({
      ...base,
      runHadWork: false,
      messages: [{ id: "u1", role: "user", text: "fix this", attachments: [{}] }],
      failure: { kind: "transport" },
    });
    expect(card?.buttons.map((button) => button.action)).toEqual(["edit-prompt"]);
  });
  it("M8: Edit prompt is offered for an attachment-only prompt and hidden for an empty one", () => {
    const stopped = { status: "interrupted", userMessageId: "u1" };
    expect(
      deriveTurnEndedCard({
        ...base,
        latestRun: stopped,
        messages: [{ id: "u1", role: "user", text: "", attachments: [{}] }],
      })?.buttons.map((button) => button.action),
    ).toEqual(["edit-prompt"]);
    expect(
      deriveTurnEndedCard({
        ...base,
        latestRun: stopped,
        messages: [{ id: "u1", role: "user", text: " ", attachments: [] }],
      })?.buttons,
    ).toEqual([]);
  });
});

describe("paid retry confirmation on the stopped card", () => {
  it("asks before re-running a stopped turn that started paid generations", () => {
    const stopped = { status: "interrupted", userMessageId: "u1" };
    expect(
      deriveTurnEndedCard({ ...base, latestRun: stopped, paidTurn: true })?.retryConfirmation,
    ).toContain("cost credits again");
    expect(deriveTurnEndedCard({ ...base, latestRun: stopped })?.retryConfirmation).toBeNull();
  });
});

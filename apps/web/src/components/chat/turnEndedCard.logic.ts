import {
  inferProviderFailureKind,
  type OrchestrationV2ProviderFailureClass,
} from "@t3tools/contracts";

/**
 * Why a turn failed. The server may send one of these as `kind`; without it we infer it from the failure class, code and message.
 */
const TURN_FAILURE_KINDS = [
  "authentication",
  "model-unavailable",
  "quota",
  "provider-busy",
  "invalid-request",
  "context-length",
  "conversation-refused",
  "transport",
  "sdk-response-validation",
  "process-exit",
  "unresponsive",
  "unknown",
] as const;
export type TurnFailureKind = (typeof TURN_FAILURE_KINDS)[number];

const KIND_ALIASES: Record<string, TurnFailureKind> = {
  auth: "authentication",
  signed_out: "authentication",
  model_unavailable: "model-unavailable",
  usage_limit: "quota",
  rate_limit: "quota",
  busy: "provider-busy",
  provider_busy: "provider-busy",
  overloaded: "provider-busy",
  invalid_request: "invalid-request",
  context_full: "context-length",
  context_length: "context-length",
  refused: "conversation-refused",
  conversation_refused: "conversation-refused",
  transport_error: "transport",
  response_validation: "sdk-response-validation",
  sdk_response_validation: "sdk-response-validation",
  process_exit: "process-exit",
  silent: "unresponsive",
};

function normalizeKind(kind: string | null | undefined): TurnFailureKind | null {
  if (!kind) return null;
  const trimmed = kind.trim();
  // "unknown" names no kind, so our own wording heuristics still get a chance.
  if (trimmed === "unknown") return null;
  if ((TURN_FAILURE_KINDS as ReadonlyArray<string>).includes(trimmed)) {
    return trimmed as TurnFailureKind;
  }
  return KIND_ALIASES[trimmed.toLowerCase().replaceAll("-", "_")] ?? null;
}

export interface TurnFailureInput {
  /** Server-provided failure kind, when the server sends one. */
  readonly kind?: string | null | undefined;
  readonly failureClass?: OrchestrationV2ProviderFailureClass | null | undefined;
  readonly code?: string | null | undefined;
  readonly message?: string | null | undefined;
}

/** The server's kind when it sends a known one; otherwise inferred, falling back to "unknown". */
export function resolveTurnFailureKind(input: TurnFailureInput): TurnFailureKind {
  // 1. The server's recorded kind.
  const explicit = normalizeKind(input.kind);
  if (explicit !== null) return explicit;
  // 2. The coarse class when it is decisive: a transport failure is never a refusal.
  if (input.failureClass === "usage_limit") return "quota";
  if (input.failureClass === "transport_error") return "transport";
  // 3. The contract's inference (HTTP status, socket errors, known provider texts), shared with
  //    the server so both classify a failure the same way.
  const inferred = inferProviderFailureKind({
    code: input.code ?? null,
    message: input.message ?? "",
    class: input.failureClass ?? "unknown",
  });
  if (inferred !== "unknown") return inferred;
  // 4. Our extra wording heuristics, anchored to the provider's phrases.
  const text = `${input.code ?? ""} ${input.message ?? ""}`.toLowerCase();
  if (/blocking_limit|too many tokens|maximum context/.test(text)) return "context-length";
  if (
    /could not process image|image could not be processed|image_error|conversation (was |has been )?refused|refused to continue (this|the) conversation/.test(
      text,
    )
  )
    return "conversation-refused";
  if (
    /unauthori[sz]ed|not (signed|logged) in|please (sign|log) in|authentication (failed|error|required)|invalid api key|token (has )?expired|invalid credentials/.test(
      text,
    )
  )
    return "authentication";
  if (
    /model[^.\n]{0,40}(not found|not available|unavailable|does not exist|no access|not supported)|unknown model/.test(
      text,
    )
  )
    return "model-unavailable";
  if (/rate[ _-]?limit|usage limit|quota exceeded|insufficient credits|billing/.test(text))
    return "quota";
  if (/server is busy|at capacity|temporarily unavailable/.test(text)) return "provider-busy";
  if (/no (output|response) for|unresponsive|stopped responding/.test(text)) return "unresponsive";
  if (
    /(agent|claude|provider|cli) process (exited|crashed|stopped)|process exited unexpectedly|terminated unexpectedly/.test(
      text,
    )
  )
    return "process-exit";
  if (/could not (parse|read|validate) (the )?response|invalid response from/.test(text))
    return "sdk-response-validation";
  if (
    /socket hang up|connection (closed|reset|lost|dropped|refused)|fetch failed|network error/.test(
      text,
    )
  )
    return "transport";
  if (input.failureClass === "validation_error") return "invalid-request";
  if (input.failureClass === "permission_error") return "authentication";
  return "unknown";
}

/** A disk-full failure gets a fixed explanation instead of the raw database error. */
function isDiskFullFailure(message: string | null | undefined): boolean {
  return /sqlite_full|no space left on device|enospc|database or disk is full/i.test(message ?? "");
}

/** One line on what to do next; null for "unknown", which shows none. */
export function turnFailureGuidance(kind: TurnFailureKind): string | null {
  switch (kind) {
    case "provider-busy":
      return "The provider is overloaded right now. Try again in a moment; there is no telling how long it lasts.";
    case "authentication":
      return "You're signed out or your sign-in expired. Sign in again, then retry.";
    case "quota":
      return "You've hit a usage or rate limit. Wait for it to reset or choose another model.";
    case "model-unavailable":
      return "Your account can't use this model. Choose another model, then retry.";
    case "invalid-request":
      return "The provider rejected this request as sent, so retrying unchanged will fail again. Remove large attachments, shorten the message, or start a new chat.";
    case "conversation-refused":
      return "The provider won't take more messages in this chat, often because of a large image, file or tool output earlier on. Continue in a new chat; this one stays as it is.";
    case "context-length":
      return "This chat no longer fits the model's context. Start a new chat, or send /compact and then resend.";
    case "transport":
      return "The connection to the provider dropped.";
    case "sdk-response-validation":
      return "The provider's reply couldn't be read.";
    case "process-exit":
      return "The agent process stopped unexpectedly.";
    case "unresponsive":
      return "The agent went quiet for 10 minutes with nothing running, so the turn was stopped. Finished work is kept.";
    case "unknown":
      return null;
  }
}

/** Text sent by "Continue" when the turn already produced something. Our wording. */
export const CONTINUE_PROMPT = "Continue from where you were cut off.";

export type TurnEndedAction =
  | "retry"
  | "start-new-chat"
  | "continue-in-new-chat"
  | "sign-in"
  | "switch-model"
  | "edit-prompt";

export interface TurnEndedButton {
  readonly action: TurnEndedAction;
  readonly label: string;
  readonly variant: "default" | "outline" | "ghost";
}

/** What the server is already doing about the failure (server-behaviour `FailureRecoveryService`). */
export type TurnRecovery =
  | { readonly type: "compact" }
  | { readonly type: "resume"; readonly attempt: number; readonly atMs: number };

export interface TurnEndedCardModel {
  readonly variant: "failed" | "stopped";
  readonly kind: TurnFailureKind | null;
  readonly tone: "neutral" | "error";
  readonly title: string;
  readonly guidance: string | null;
  /** Raw failure text, shown under "Details". */
  readonly details: string | null;
  readonly buttons: ReadonlyArray<TurnEndedButton>;
  /** What "retry" sends: the original prompt when nothing came back, else CONTINUE_PROMPT. */
  readonly retryText: string;
  /** The prompt "Edit prompt" puts back into the composer (its attachments are restored too). */
  readonly promptText: string;
  /** Set while the server recovers by itself; the card says so instead of urging a manual fix. */
  readonly recovery: TurnRecovery | null;
  /** Asked before "Try again" re-runs a turn that started paid generations. */
  readonly retryConfirmation: string | null;
}

export interface TurnEndedInput {
  readonly latestRun: {
    readonly status: string;
    readonly userMessageId: string;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments: ReadonlyArray<unknown>;
  }>;
  readonly failure: TurnFailureInput | null;
  /** The latest run produced tool calls or other visible work. */
  readonly runHadWork: boolean;
  readonly working: boolean;
  readonly readOnly: boolean;
  readonly recovery?: TurnRecovery | null;
  /** The run started paid generations (creative-mcp media jobs). */
  readonly paidTurn?: boolean;
}

const TRANSIENT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const RECOVERY_PREFIX = "oh-recover:";
// server-behaviour FailureRecoveryService PAID_GENERATION: turns that ran any of these are never
// resumed by the server (broader than the creative job tools: other MCP generators count too).
const SERVER_PAID_GENERATION =
  /(media_generate|generate_(image|video|audio|3d)|_batch$|upscale_(image|video)|motion_control|ai_influencer_generate|ads_studio_generate|seedance|veo|kling)/i;

export function isServerPaidGenerationTool(toolName: string | null | undefined): boolean {
  return toolName !== null && toolName !== undefined && SERVER_PAID_GENERATION.test(toolName);
}
const TRANSIENT_KINDS = new Set<TurnFailureKind>([
  "transport",
  "provider-busy",
  "process-exit",
  "sdk-response-validation",
]);

/**
 * What the server will do by itself after this failure, mirroring server-behaviour's
 * `planRecovery` (FailureRecoveryService.ts): compact once after a context overflow or image
 * error on a user-started Claude turn; resume transient kinds after 30 s, 2 min and 10 min, only
 * with the auto-resume setting on and never after paid generations. Only used when the server
 * advertises `failureAutoRecovery`.
 */
export function predictTurnRecovery(input: {
  readonly kind: TurnFailureKind;
  readonly failureClass: OrchestrationV2ProviderFailureClass | null | undefined;
  readonly code: string | null | undefined;
  readonly retryable: boolean | null | undefined;
  readonly triggerMessageId: string;
  readonly triggerRole: "user" | "assistant" | "system";
  readonly failedAtMs: number | null;
  /** Compaction is a Claude Code command; the server only compacts Claude threads. */
  readonly claude?: boolean;
  /** The server resumes only with the "auto-resume" setting on (off by default). */
  readonly autoResume?: boolean;
  /** The failed turn started paid generations: the server never resumes it by itself. */
  readonly paidGeneration?: boolean;
}): TurnRecovery | null {
  if (input.failureClass === "usage_limit") return null;
  const ours = input.triggerMessageId.startsWith(RECOVERY_PREFIX);
  const fromUser = input.triggerRole === "user" && !ours;
  if (
    input.kind === "context-length" ||
    input.code === "image_error" ||
    input.code === "prompt_too_long"
  )
    return fromUser && input.claude !== false ? { type: "compact" } : null;
  if (!TRANSIENT_KINDS.has(input.kind) || input.retryable === false) return null;
  if (input.paidGeneration === true || input.autoResume !== true) return null;
  const previous = /^oh-recover:transient:(\d+):/.exec(input.triggerMessageId);
  if (!fromUser && previous === null) return null;
  const attempt = previous === null ? 1 : Number(previous[1]) + 1;
  const delayMs = TRANSIENT_RETRY_DELAYS_MS[attempt - 1];
  if (delayMs === undefined || input.failedAtMs === null) return null;
  return { type: "resume", attempt, atMs: input.failedAtMs + delayMs };
}

/**
 * The card at the end of the timeline after the latest turn failed or was stopped. It is shown only for the latest turn, never
 * while working or once a newer user message exists, and never in read-only chats.
 */
export function deriveTurnEndedCard(input: TurnEndedInput): TurnEndedCardModel | null {
  const run = input.latestRun;
  if (run === null || input.working || input.readOnly) return null;
  if (run.status !== "failed" && run.status !== "interrupted") return null;
  const lastUser = input.messages.findLast((message) => message.role === "user");
  if (lastUser === undefined || lastUser.id !== run.userMessageId) return null;
  const userIndex = input.messages.lastIndexOf(lastUser);
  const producedOutput =
    input.runHadWork ||
    input.messages
      .slice(userIndex + 1)
      .some((message) => message.role === "assistant" && message.text.trim() !== "");
  const promptText = lastUser.text;
  const hasText = promptText.trim() !== "";
  const hasAttachments = lastUser.attachments.length > 0;
  // Edit shows only when there is something to put back.
  const canEdit = hasText || hasAttachments;

  if (run.status === "interrupted") {
    // User-stopped card: Try again only for a text prompt without attachments.
    const buttons: TurnEndedButton[] = [];
    if (hasText && !hasAttachments) {
      buttons.push({ action: "retry", label: "Try again", variant: "outline" });
    }
    if (canEdit) buttons.push({ action: "edit-prompt", label: "Edit prompt", variant: "ghost" });
    return {
      variant: "stopped",
      kind: null,
      tone: "neutral",
      title: "You stopped this reply",
      guidance: "The reply above is cut off. Work that finished before you stopped is kept.",
      details: null,
      buttons,
      retryText: promptText,
      promptText,
      recovery: null,
      retryConfirmation: input.paidTurn
        ? "This reply started paid generations. Trying again starts new ones, which cost credits again."
        : null,
    };
  }

  const failure = input.failure ?? {};
  const kind = resolveTurnFailureKind(failure);
  // Our usage-limit banner owns quota failures (auto-resume at reset).
  if (kind === "quota") return null;
  const diskFull = isDiskFullFailure(failure.message);
  const recovery = input.recovery ?? null;
  // Nothing came back and the prompt carried files: a text-only "continue" would reach the agent
  // without them, so the way back is to put the prompt and its files into the composer.
  const resendNeedsAttachments = !producedOutput && hasAttachments;
  const retryText = !producedOutput && hasText ? promptText : CONTINUE_PROMPT;
  const retryLabel = kind === "provider-busy" || kind === "unresponsive" ? "Try again" : "Continue";
  const buttons: TurnEndedButton[] = [];
  if (recovery === null) {
    if (kind === "context-length") {
      buttons.push({ action: "start-new-chat", label: "Start a new chat", variant: "default" });
    }
    if (kind === "conversation-refused") {
      buttons.push({
        action: "continue-in-new-chat",
        label: "Continue in a new chat",
        variant: "default",
      });
    }
    if (kind === "authentication") {
      buttons.push({ action: "sign-in", label: "Sign in", variant: "default" });
    }
    if (kind === "model-unavailable") {
      buttons.push({ action: "switch-model", label: "Switch model", variant: "default" });
    }
  }
  if (resendNeedsAttachments) {
    buttons.push({
      action: "edit-prompt",
      label: "Edit and resend",
      variant: buttons.length === 0 ? "default" : "outline",
    });
  } else if (kind !== "conversation-refused" || recovery !== null) {
    const primary = buttons.length === 0 && recovery === null;
    buttons.push({
      action: "retry",
      label: recovery !== null ? "Try now" : kind === "authentication" ? "Try again" : retryLabel,
      variant: primary ? "default" : "outline",
    });
  }
  return {
    variant: "failed",
    kind,
    tone: kind === "provider-busy" || recovery !== null ? "neutral" : "error",
    title: diskFull ? "The disk is full" : turnFailedTitle(kind),
    guidance: diskFull
      ? "Free up space by deleting old renders or other large files, then resend."
      : recovery !== null
        ? null
        : turnFailureGuidance(kind),
    details: failure.message?.trim() || null,
    buttons,
    retryText,
    promptText,
    recovery,
    retryConfirmation: null,
  };
}

function turnFailedTitle(kind: TurnFailureKind): string {
  switch (kind) {
    case "provider-busy":
      return "The model is busy";
    case "unresponsive":
      return "No reply from the agent";
    case "context-length":
      return "This chat is too long";
    case "conversation-refused":
      return "The provider refused this chat";
    case "process-exit":
      return "The agent session stopped";
    default:
      return "The turn stopped early";
  }
}

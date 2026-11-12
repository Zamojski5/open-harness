// @effect-diagnostics nodeBuiltinImport:off globalDate:off - SDK hook callbacks run outside Effect and read the session transcript synchronously.
// Open Herness quality-goal hooks: the Stop hook that holds a turn while the thread's quality goal
// is open (policy in @open-herness/creative-mcp goal state), and the PreToolUse
// checks that a spend cap or a stop request really comes from the user's own words.
import * as NodeFS from "node:fs";

import {
  currentReviews,
  endGoal,
  getGoal,
  goalPath,
  jobsFor,
  stopHold,
  type QualityGoal,
} from "@open-herness/creative-mcp/goal-state";
import { checkCapQuote, type UserWords } from "@open-herness/creative-mcp/capwords";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";

interface HumanWords {
  readonly at: number;
  readonly text: string;
  /** Picks only: the question the card asked. */
  readonly question?: string;
}

interface Transcript {
  readonly messages: ReadonlyArray<HumanWords>;
  readonly picks: ReadonlyArray<HumanWords>;
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((part) => (part as { type?: string })?.type === "tool_result")) return undefined;
  const texts = content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""));
  return texts.length ? texts.join("\n") : undefined;
};

/** What the person typed, and the options they picked on question cards, from the transcript. */
function readTranscript(path: string | undefined): Transcript {
  const messages: HumanWords[] = [];
  const picks: HumanWords[] = [];
  if (!path) return { messages, picks };
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch {
    return { messages, picks };
  }
  const questionIds = new Set<string>();
  for (const line of raw.split("\n")) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = Date.parse(String(entry.timestamp ?? "")) || 0;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (entry.type === "assistant" && Array.isArray(message?.content)) {
      for (const part of message.content as Array<Record<string, unknown>>)
        if (part.type === "tool_use" && part.name === "AskUserQuestion")
          questionIds.add(String(part.id));
      continue;
    }
    if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) continue;
    if (entry.isCompactSummary === true || entry.isSynthetic === true) continue;
    if (Array.isArray(message?.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type !== "tool_result" || !questionIds.has(String(part.tool_use_id))) continue;
        const body = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
        for (const match of body.matchAll(/"([^"]*)"\s*=\s*"([^"]+)"/g))
          picks.push({ at, question: match[1]!, text: match[2]! });
      }
    }
    const text = textOf(message?.content);
    if (text === undefined || /^Stop hook feedback:/.test(text) || /^<[a-z-]+>/.test(text.trim()))
      continue;
    messages.push({ at, text });
  }
  return { messages, picks };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The quote is one or more whole sentences of the message (not a fragment cut mid-sentence). */
export function wholeSentencesOf(quote: string, message: string): boolean {
  const q = normalize(quote).replace(/[.!?]+$/, "");
  const m = normalize(message);
  if (q.length === 0) return false;
  let from = 0;
  while (true) {
    const index = m.indexOf(q, from);
    if (index < 0) return false;
    const before = m.slice(0, index).trimEnd();
    const after = m.slice(index + q.length);
    if (
      (before === "" || /[.!?:;\n]$/.test(before)) &&
      (after.trim() === "" || /^[.!?]?(\s|$)/.test(after))
    )
      return true;
    from = index + 1;
  }
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

const toolInput = (input: HookInput) =>
  ((input as { tool_input?: unknown }).tool_input ?? {}) as Record<string, unknown>;
const transcriptPath = (input: HookInput) =>
  (input as { transcript_path?: string }).transcript_path;

/**
 * goal_set: a spend cap counts only when the person's own words (or a picked option) state it.
 * Same rules as the spend tools' chat caps (creative-mcp `capwords.checkCapQuote`, English and
 * Polish): whole sentences or a picked label, one stated sum, the latest money words win.
 */
export function checkBudgetQuote(input: HookInput): HookJSONOutput {
  const tool = toolInput(input);
  if (tool.localOnly === true) return {};
  const quote = typeof tool.budgetQuote === "string" ? tool.budgetQuote : "";
  const cap = typeof tool.spendLimitUsd === "number" ? tool.spendLimitUsd : undefined;
  if (!quote || cap === undefined) return {};
  const { messages, picks } = readTranscript(transcriptPath(input));
  const words: UserWords[] = [
    ...messages.map((message) => ({
      at: message.at,
      source: "prompt" as const,
      text: message.text,
    })),
    ...picks.map((pick) => ({
      at: pick.at,
      source: "card" as const,
      text: pick.text,
      picked: true,
      ...(pick.question === undefined ? {} : { question: pick.question }),
    })),
  ];
  const check = checkCapQuote(cap, quote, words);
  return check.ok ? {} : deny(`Open Herness: ${check.reason}`);
}

const STOP_WORDS = /\b(stop|pause|end|enough|halt|that'?s it|show me|finish|wrap up|done)\b/i;

/** goal_end "ended": userRequest must quote the person asking to stop. */
export function checkStopRequest(input: HookInput, threadId: string | undefined): HookJSONOutput {
  const tool = toolInput(input);
  if (tool.status !== "ended") return {};
  const quote = typeof tool.userRequest === "string" ? tool.userRequest : "";
  const goal = threadId ? getGoal(threadId) : undefined;
  if (!quote || !goal) return {};
  const { messages, picks } = readTranscript(transcriptPath(input));
  const since = messages.filter((message) => message.at >= goal.startedAt);
  if (since.some((message) => wholeSentencesOf(quote, message.text))) return {};
  if (picks.some((pick) => pick.at >= goal.startedAt && normalize(pick.text) === normalize(quote)))
    return {};
  const setting = messages.filter((message) => message.at < goal.startedAt).slice(-2);
  if (
    STOP_WORDS.test(quote) &&
    !/\d/.test(quote) &&
    setting.some((message) => wholeSentencesOf(quote, message.text))
  )
    return {};
  return deny(
    'Open Herness: "ended" needs userRequest to quote the user asking to stop (whole sentences of their message). If they did not ask, keep working toward the bar.',
  );
}

/** The user ended the goal (for example with /goal clear); holds stop at once. */
export function clearQualityGoal(threadId: string, reason: string): void {
  endGoal(threadId, "ended", reason);
}

// Threads whose current turn the user stopped: the hold never fights an interrupt. Cleared on the
// next user message (UserPromptSubmit).
const interruptedThreads = new Set<string>();

export function noteUserInterrupt(threadId: string): void {
  interruptedThreads.add(threadId);
}

export function clearUserInterrupt(threadId: string): void {
  interruptedThreads.delete(threadId);
}

/** Stop hook: hold the turn while the thread's quality goal is open (see goal state). */
export function qualityGoalStop(
  input: HookInput,
  threadId: string | undefined,
  turnId: string | undefined,
  options: { readonly creativeToolsAvailable?: boolean } = {},
): HookJSONOutput {
  if (!threadId || (input as { agent_id?: string }).agent_id !== undefined) return {};
  if (interruptedThreads.has(threadId)) return {};
  // Without the creative tools the agent cannot review or end the goal: never hold.
  if (options.creativeToolsAvailable === false) return {};
  const goal = getGoal(threadId);
  if (!goal || goal.status !== "active") return {};
  const reason = stopHold(threadId, turnId, jobsFor(threadId, goal.startedAt));
  return reason === undefined ? {} : { decision: "block", reason };
}

/** The thread's quality goal as the thread's goal line (status, reviews, latest score and gaps). */
export function providerGoalFromQualityGoal(
  goal: QualityGoal,
  nowMs: number,
): OrchestrationV2ProviderGoal {
  const reviews = currentReviews(goal);
  const latest = reviews.at(-1);
  const status: OrchestrationV2ProviderGoal["status"] =
    goal.status === "active"
      ? "active"
      : goal.status === "out_of_budget"
        ? "budget_limited"
        : goal.status === "plateau"
          ? "blocked"
          : "complete";
  const check = latest
    ? `Score ${latest.score}/10 (bar ${goal.target})${latest.gaps.length ? `: ${latest.gaps.slice(0, 3).join("; ")}` : ""}`
    : `Not reviewed yet (bar ${goal.target}/10)`;
  const end = goal.status === "active" ? nowMs : Math.min(nowMs, goal.deadlineAt);
  return {
    objective: goal.objective.slice(0, 500).trim() || "Quality goal",
    status,
    checks: reviews.length,
    timeUsedSeconds: Math.max(0, Math.round((end - goal.startedAt) / 1000)),
    lastCheck: goal.endReason && goal.status !== "active" ? `${check}. ${goal.endReason}` : check,
  };
}

const goalLineCache = new Map<
  string,
  { readonly mtimeMs: number; readonly goal: OrchestrationV2ProviderGoal | null }
>();

/** The goal line for `threadId`; undefined when no quality goal file exists or the thread has none. */
export function qualityGoalLine(threadId: string): OrchestrationV2ProviderGoal | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = NodeFS.statSync(goalPath(threadId)).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = goalLineCache.get(threadId);
  if (cached?.mtimeMs === mtimeMs) return cached.goal ?? undefined;
  const goal = getGoal(threadId);
  const line = goal === undefined ? null : providerGoalFromQualityGoal(goal, Date.now());
  goalLineCache.set(threadId, { mtimeMs, goal: line });
  return line ?? undefined;
}

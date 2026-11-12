/*
 * The "Stop and archive" confirmation follows DeepSeek Harness ArchiveSession
 * (packages/client/ui-workspace/src/client/session-actions/ArchiveSession.tsx), MIT License,
 * Copyright (c) 2026 DeepSeek: it names the turn in progress, the running subagents and other
 * background work before stopping it. Our own wording.
 */
import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";

const MAX_NAMED = 3;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function named(labels: ReadonlyArray<string>): string {
  const shown = labels.slice(0, MAX_NAMED).join(", ");
  return labels.length > MAX_NAMED ? `${shown} and ${labels.length - MAX_NAMED} more` : shown;
}

/** One line per kind of work that stops when a running thread is archived. */
export function stopAndArchiveLines(input: {
  readonly turnRunning: boolean;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}): string[] {
  const lines: string[] = [];
  if (input.turnRunning) lines.push("The reply in progress");
  const items = presentPendingBackgroundWork(input.tasks)?.items ?? [];
  const subagents = items.filter((item) => item.kind === "subagent");
  const commands = items.filter((item) => item.kind === "command" || item.kind === "monitor");
  const other = items.filter((item) => item.kind === "background_task");
  if (subagents.length > 0) {
    lines.push(
      `${plural(subagents.length, "running subagent", "running subagents")}: ${named(subagents.map((item) => item.label))}`,
    );
  }
  if (commands.length > 0) {
    lines.push(
      `${plural(commands.length, "background command", "background commands")}: ${named(commands.map((item) => item.label))}`,
    );
  }
  if (other.length > 0)
    lines.push(plural(other.length, "other background task", "other background tasks"));
  return lines;
}

export function stopAndArchiveMessage(title: string, lines: ReadonlyArray<string>): string {
  const list =
    lines.length > 0 ? lines.map((line) => `• ${line}`).join("\n") : "• Its current work";
  return `Stop and archive "${title}"?\n\nThis stops:\n${list}\n\nWork that already finished is kept.`;
}

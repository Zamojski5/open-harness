import type { CommandOutputView } from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, NodeId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { tickTextContent } from "~/lib/tickTextContent";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  advanceJobHistory,
  formatJobElapsed,
  lastOutputLine,
  type FinishedJob,
  type TrackedJob,
} from "./backgroundJobs.logic";
import { useCommandOutputStreaming } from "./CommandOutputPanel";

export interface BackgroundJobRow {
  readonly taskId: string;
  readonly kind: "subagent" | "command" | "monitor" | "background_task";
  readonly label: ReactNode;
  readonly labelText: string;
  readonly startedAtMs: number | null;
  /** The command's turn item, for its live output. */
  readonly commandItemId: TurnItemId | null;
  readonly inlineOutput: string | null;
  /** Agent progress text, the fallback line for subagents. */
  readonly activity: string | null;
  readonly childThreadId: ThreadId | undefined;
  readonly subagent: { readonly threadId: ThreadId; readonly subagentId: NodeId } | null;
}

const KIND_LABEL: Record<BackgroundJobRow["kind"], string> = {
  command: "Shell",
  monitor: "Monitor",
  subagent: "Agent",
  background_task: "Task",
};

/** Finished jobs per thread for this session, so reopening the panel keeps them. */
const finishedByThread = new Map<string, ReadonlyArray<FinishedJob>>();
const trackedByThread = new Map<string, ReadonlyArray<TrackedJob>>();
const NO_FINISHED: ReadonlyArray<FinishedJob> = [];
const historyListeners = new Set<() => void>();
function subscribeHistory(listener: () => void) {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}
function setFinishedHistory(key: string, finished: ReadonlyArray<FinishedJob>) {
  finishedByThread.set(key, finished);
  for (const listener of historyListeners) listener();
}

/** How long the first press of a stop arms the second (DSH two-press stop). */
const STOP_CONFIRM_MS = 3_000;

function CommandLastLine(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly fallback: string | null;
}) {
  const { data } = useEnvironmentQuery<CommandOutputView, unknown>(
    orchestrationEnvironment.v2.commandOutput({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, itemId: props.itemId },
    }),
  );
  const line = lastOutputLine(data?.output.text) ?? props.fallback;
  return <JobLine text={line} />;
}

function JobLine({ text }: { readonly text: string | null }) {
  return (
    <span className="block min-w-0 truncate font-mono text-2xs text-muted-foreground">
      {text ?? "No output yet"}
    </span>
  );
}

function JobRow(props: {
  readonly row: BackgroundJobRow;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly streamsOutput: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStopJob: (row: BackgroundJobRow) => Promise<boolean>;
}) {
  const { row } = props;
  const [stopState, setStopState] = useState<"idle" | "confirm" | "stopping" | "failed">("idle");
  const confirmTimer = useRef<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the armed-stop timer on unmount
  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );
  const startedAtMs = row.startedAtMs;
  const fallback =
    row.kind === "subagent" ? row.activity : (lastOutputLine(row.inlineOutput) ?? row.activity);
  const stop = () => {
    if (stopState === "stopping") return;
    if (stopState !== "confirm") {
      setStopState("confirm");
      confirmTimer.current = window.setTimeout(() => setStopState("idle"), STOP_CONFIRM_MS);
      return;
    }
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    setStopState("stopping");
    void props.onStopJob(row).then((ok) => setStopState(ok ? "idle" : "failed"));
  };
  const childThreadId = row.childThreadId;
  return (
    <li className="flex flex-col gap-0.5 py-1.5" data-background-job={row.kind}>
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-foreground">{row.label}</span>
        <span className="shrink-0 text-muted-foreground">{KIND_LABEL[row.kind]}</span>
        {startedAtMs === null ? null : (
          <span
            className="shrink-0 tabular-nums text-muted-foreground"
            ref={tickTextContent((nowMs) => formatJobElapsed(nowMs - startedAtMs), true)}
          />
        )}
      </div>
      {row.commandItemId !== null && props.streamsOutput ? (
        <CommandLastLine
          environmentId={props.environmentId}
          threadId={props.threadId}
          itemId={row.commandItemId}
          fallback={fallback}
        />
      ) : (
        <JobLine text={fallback} />
      )}
      <div className="flex items-center gap-2 text-2xs">
        {childThreadId === undefined ? null : (
          <InlineButton tone="muted" onClick={() => props.onOpenThread(childThreadId)}>
            View agent
          </InlineButton>
        )}
        {row.subagent === null ? null : (
          <InlineButton
            tone={stopState === "confirm" ? "default" : "muted"}
            disabled={stopState === "stopping"}
            onClick={stop}
          >
            {stopState === "confirm"
              ? "Click again to stop"
              : stopState === "stopping"
                ? "Stopping…"
                : stopState === "failed"
                  ? "Stop failed, retry"
                  : "Stop"}
          </InlineButton>
        )}
      </div>
    </li>
  );
}

/**
 * The background work list: running jobs with their latest output line, timer and stop, then
 * the jobs that finished this session with "Clear".
 */
export function BackgroundJobsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rows: ReadonlyArray<BackgroundJobRow>;
  readonly stopAllDisabled: boolean;
  readonly stopping: boolean;
  readonly onStopAll: () => Promise<void>;
  readonly onStopJob: (row: BackgroundJobRow) => Promise<boolean>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const key = `${props.environmentId}:${props.threadId}`;
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const finished = useSyncExternalStore(
    subscribeHistory,
    () => finishedByThread.get(key) ?? NO_FINISHED,
  );
  const { rows } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records jobs that left the running list into this session's finished history (a module store)
  useEffect(() => {
    const running: TrackedJob[] = rows.map((row) => ({
      taskId: row.taskId,
      label: row.labelText,
      kind: row.kind,
      startedAtMs: row.startedAtMs,
    }));
    const previous = trackedByThread.get(key) ?? [];
    const next = advanceJobHistory(previous, running, finishedByThread.get(key) ?? [], Date.now());
    trackedByThread.set(key, next.running);
    if (next.finished !== finishedByThread.get(key)) setFinishedHistory(key, next.finished);
  }, [key, rows]);
  return (
    <Popover>
      <PopoverTrigger render={<InlineButton tone="muted" />}>
        Jobs ({props.rows.length})
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        aria-label="Background work"
        className="w-[min(26rem,calc(100vw-2rem))]"
      >
        <div className="flex items-center justify-between gap-2 pb-1 text-xs">
          <span className="font-medium text-foreground">Running {props.rows.length}</span>
          <InlineButton disabled={props.stopAllDisabled} onClick={() => void props.onStopAll()}>
            {props.stopping ? "Stopping…" : "Stop all"}
          </InlineButton>
        </div>
        <ul className="divide-y divide-border">
          {props.rows.map((row) => (
            <JobRow
              key={row.taskId}
              row={row}
              environmentId={props.environmentId}
              threadId={props.threadId}
              streamsOutput={streamsOutput}
              onOpenThread={props.onOpenThread}
              onStopJob={props.onStopJob}
            />
          ))}
        </ul>
        {finished.length > 0 ? (
          <div className="mt-2 border-t border-border pt-2">
            <div className="flex items-center justify-between pb-1 text-xs">
              <span className="text-muted-foreground">Finished {finished.length}</span>
              <InlineButton tone="muted" onClick={() => setFinishedHistory(key, NO_FINISHED)}>
                Clear
              </InlineButton>
            </div>
            <ul className="space-y-1">
              {finished.map((job) => (
                <li key={`${job.taskId}:${job.finishedAtMs}`} className="flex gap-2 text-2xs">
                  <span className="min-w-0 flex-1 truncate text-secondary-label">{job.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {job.startedAtMs === null
                      ? "Done"
                      : `Took ${formatJobElapsed(job.finishedAtMs - job.startedAtMs)}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

import { SparklesIcon } from "lucide-react";

import { tickTextContent } from "~/lib/tickTextContent";
import { generationStatusView, type GenerationJobSnapshot } from "./generationJobs.logic";

const SLOW_TEXT =
  "Taking longer than usual. Keep waiting, or ask the agent to switch to a faster model.";

/**
 * Live cards for generations that are still pending: what the job is
 * doing, time so far, the expected duration, and a slow-job note. They tick every second from the
 * last result the agent received.
 */
export function GenerationStatusCards(props: {
  readonly jobs: ReadonlyArray<GenerationJobSnapshot>;
}) {
  if (props.jobs.length === 0) return null;
  return (
    <div className="chat-content-lane flex flex-col gap-1.5 pb-2" data-generation-status>
      {props.jobs.map((job) => {
        const initial = generationStatusView(job, job.observedAtMs);
        return (
          <div
            key={job.id}
            className="flex items-start gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs"
          >
            <SparklesIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="flex min-w-0 items-baseline gap-1.5">
                {/* The status region changes only with the job's state; the ticking time stays out of
                    it so screen readers aren't told every second. */}
                <span role="status" className="shrink-0 font-medium text-foreground">
                  {job.model}
                  <span className="sr-only">
                    {job.state === "running" ? ", generating" : ", waiting in line"}
                  </span>
                </span>
                <span
                  aria-live="off"
                  className="min-w-0 truncate text-secondary-label"
                  ref={tickTextContent((nowMs) => generationStatusView(job, nowMs).status, true)}
                />
              </p>
              {initial.eta ? (
                <p
                  className="text-muted-foreground"
                  aria-description="Includes time waiting in line; actual time varies."
                >
                  {initial.eta}
                </p>
              ) : null}
              <p
                className="text-warning-foreground empty:hidden"
                ref={tickTextContent(
                  (nowMs) => (generationStatusView(job, nowMs).slow ? SLOW_TEXT : ""),
                  true,
                )}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

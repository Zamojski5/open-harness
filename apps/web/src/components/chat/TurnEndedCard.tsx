import { CircleAlertIcon, CircleStopIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { tickTextContent } from "~/lib/tickTextContent";
import { formatJobElapsed } from "./backgroundJobs.logic";
import type { TurnEndedAction, TurnEndedCardModel, TurnRecovery } from "./turnEndedCard.logic";

function recoveryCountdown(recovery: TurnRecovery | null, nowMs: number): string {
  if (recovery?.type !== "resume") return "";
  const remaining = recovery.atMs - nowMs;
  const attempt = `attempt ${recovery.attempt} of 3`;
  return remaining > 0
    ? `Trying again automatically in ${formatJobElapsed(remaining)} (${attempt}).`
    : `Trying again automatically now (${attempt}).`;
}

/**
 * The card after the latest turn failed or was stopped: what happened, one line on what to do
 * next, and the actions for that failure kind. It is part of the timeline (not a dismissible
 * banner) and goes away once a new turn starts.
 */
export function TurnEndedCard(props: {
  readonly model: TurnEndedCardModel;
  readonly disabled: boolean;
  readonly onAction: (action: TurnEndedAction) => Promise<void> | void;
}) {
  const { model } = props;
  const [pending, setPending] = useState(false);
  const run = (action: TurnEndedAction) => {
    if (pending || props.disabled) return;
    setPending(true);
    void Promise.resolve(props.onAction(action)).finally(() => setPending(false));
  };
  const Icon = model.variant === "stopped" ? CircleStopIcon : CircleAlertIcon;
  return (
    <div className="chat-content-lane py-2">
      <div
        role="status"
        data-turn-ended={model.variant}
        data-failure-kind={model.kind ?? undefined}
        aria-busy={pending || undefined}
        className="rounded-xl border border-border bg-card px-3.5 py-3 text-sm"
      >
        <div className="flex items-start gap-2.5">
          <Icon
            aria-hidden
            className={cn(
              "mt-0.5 size-4 shrink-0",
              model.tone === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium text-foreground">{model.title}</p>
            {model.guidance ? <p className="text-secondary-label">{model.guidance}</p> : null}
            {model.recovery?.type === "compact" ? (
              <p className="text-secondary-label" data-turn-recovery="compact">
                Compacting this chat, then continuing automatically.
              </p>
            ) : model.recovery?.type === "resume" ? (
              <p className="text-secondary-label" data-turn-recovery="resume">
                <span
                  ref={tickTextContent((nowMs) => recoveryCountdown(model.recovery, nowMs), true)}
                />
              </p>
            ) : null}
            {model.buttons.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                {model.buttons.map((button) => (
                  <Button
                    key={button.action}
                    size="xs"
                    variant={button.variant}
                    disabled={pending || props.disabled}
                    onClick={() => run(button.action)}
                  >
                    {button.label}
                  </Button>
                ))}
              </div>
            ) : null}
            {model.details ? (
              <Collapsible>
                <CollapsibleTrigger className="pt-1 text-xs text-muted-foreground hover:text-foreground">
                  Details
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground select-text">
                    {model.details}
                  </pre>
                </CollapsiblePanel>
              </Collapsible>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

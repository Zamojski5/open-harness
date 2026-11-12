import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { ShieldIcon } from "lucide-react";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { memo, use, useEffect, useRef, useState } from "react";
import { approvalDecisionForKey, isRectInViewport } from "./approvalKeys";
import { Kbd } from "../ui/kbd";
import { type PendingApproval } from "../../session-logic";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    detailLabel: "App access request",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const rowRef = useRef<HTMLDivElement>(null);
  // Blocks a second answer before the responding state re-renders.
  const waitingRef = useRef(false);
  const compositionEndRef = useRef(Number.NEGATIVE_INFINITY);
  const [answering, setAnswering] = useState(false);
  const isResponding = answering || respondingRequestIds.includes(approval.requestId);
  const keyboardEnabled = canRespond && canOperateThread && onRespondToApproval !== undefined;
  const respond = (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
    if (waitingRef.current || !onRespondToApproval) return Promise.resolve(undefined);
    waitingRef.current = true;
    setAnswering(true);
    // Rolls back to answerable when the send failed; a success unmounts the row.
    return onRespondToApproval(requestId, decision).finally(() => {
      waitingRef.current = false;
      setAnswering(false);
    });
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves focus to a new approval only when nothing else holds focus, so Enter/Escape answer it
  useEffect(() => {
    if (!keyboardEnabled) return;
    const active = document.activeElement;
    const row = rowRef.current;
    if (row === null || (active !== null && active !== document.body)) return;
    // Only an approval on screen takes focus, so Enter can't answer one the user can't see.
    if (isRectInViewport(row.getBoundingClientRect(), window.innerHeight)) {
      row.focus({ preventScroll: true });
    }
  }, [keyboardEnabled]);
  return (
    <WorkLogRow
      ref={rowRef}
      role="group"
      aria-label={presentation.label}
      aria-busy={isResponding || undefined}
      aria-keyshortcuts={keyboardEnabled ? "Enter Escape" : undefined}
      tabIndex={keyboardEnabled ? 0 : undefined}
      data-approval-row=""
      onCompositionEnd={(event) => {
        compositionEndRef.current = event.timeStamp;
      }}
      onKeyDown={(event) => {
        if (!keyboardEnabled || isResponding) return;
        const decision = approvalDecisionForKey({
          key: event.key,
          repeat: event.repeat,
          isComposing: event.nativeEvent.isComposing,
          keyCode: event.nativeEvent.keyCode,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          target: event.target,
          focusInCard: event.currentTarget.contains(document.activeElement),
          msSinceCompositionEnd: event.timeStamp - compositionEndRef.current,
        });
        if (decision === null) return;
        const offered =
          approval.options === undefined ||
          approval.options.some((option) => option.decision === decision);
        if (!offered) return;
        event.preventDefault();
        event.stopPropagation();
        void respond(approval.requestId, decision);
      }}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      label={
        <code
          aria-label={presentation.detailLabel}
          className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {approval.detail || presentation.label}
        </code>
      }
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={isResponding}
                    canRespond={canRespond}
                    options={approval.options}
                    onRespondToApproval={respond}
                  />
                  {keyboardEnabled ? (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Kbd>Enter</Kbd> approve · <Kbd>Esc</Kbd> decline
                    </span>
                  ) : null}
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
          )}
          {approval.fullAccessOverride ? (
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {FULL_ACCESS_OVERRIDE_QUESTION}
              </PopoverTrigger>
              <PopoverPopup
                aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                tooltipStyle
                side="top"
                className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
              >
                {fullAccessOverrideExplanation(approval.fullAccessOverride)}
              </PopoverPopup>
            </Popover>
          ) : null}
        </div>
      </div>
    </WorkLogRow>
  );
});

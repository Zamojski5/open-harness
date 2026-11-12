import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { DiffStatLabel } from "./DiffStatLabel";
import { headTailText } from "./dshDerived";
import type { ToolRowFile } from "./toolRowSummary";

const stopRowToggle = (event: { stopPropagation: () => void }) => event.stopPropagation();

/** Most file links a collapsed row shows before "+N more". */
const MAX_ROW_FILE_LINKS = 3;

/** The path to open: workspace-relative inside the root, otherwise as recorded. */
function openablePath(path: string, workspaceRoot: string | undefined): string {
  const root = workspaceRoot?.replace(/\/+$/, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

/** One link per changed file; a move reads "old → new", a deleted file is plain text. */
export function ToolRowFileLinks(props: {
  readonly files: ReadonlyArray<ToolRowFile>;
  readonly workspaceRoot: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const shown = props.files.slice(0, MAX_ROW_FILE_LINKS);
  const rest = props.files.length - shown.length;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 truncate">
      {shown.map((file) => {
        const display = formatWorkspaceRelativePath(file.path, props.workspaceRoot);
        const name = fileName(display);
        const label = (
          <>
            {file.oldPath ? (
              <span className="text-muted-foreground">{fileName(file.oldPath)} → </span>
            ) : null}
            {name}
          </>
        );
        const { threadRef } = props;
        return file.linkable && threadRef ? (
          <button
            key={file.path}
            type="button"
            aria-label={`Open ${display}`}
            className="min-w-0 truncate rounded-sm font-mono text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            onClick={(event) => {
              event.stopPropagation();
              useRightPanelStore
                .getState()
                .openFile(threadRef, openablePath(file.path, props.workspaceRoot));
            }}
            onKeyDown={stopRowToggle}
          >
            {label}
          </button>
        ) : (
          <span
            key={file.path}
            aria-label={`${display} (deleted)`}
            className="min-w-0 truncate font-mono text-xs text-muted-foreground line-through"
          >
            {label}
          </span>
        );
      })}
      {rest > 0 ? (
        <span className="shrink-0 text-xs text-muted-foreground">+{rest} more</span>
      ) : null}
    </span>
  );
}

export function ToolRowDiffStat(props: { readonly additions: number; readonly deletions: number }) {
  return (
    <DiffStatLabel
      layout="inline"
      className="shrink-0 text-xs"
      additions={props.additions}
      deletions={props.deletions}
    />
  );
}

/** Neutral capsule with a failure dot (DSH ExitCodeBadge). */
export function ExitCodeBadge({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 font-mono text-2xs leading-4 text-muted-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
      {label}
    </span>
  );
}

export function CopyTextButton(props: { readonly text: string; readonly label?: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const label = props.label ?? "Copy";
  return (
    <button
      type="button"
      aria-label={isCopied ? "Copied" : label}
      className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/copyable:opacity-100 pointer-coarse:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        copyToClipboard(props.text, undefined);
      }}
    >
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

/** Lines shown before the middle of long output folds (DSH default). */
const TOOL_OUTPUT_MAX_LINES = 16;
/** Lines an expanded block renders at most. */
const EXPANDED_OUTPUT_LIMIT = 2_000;

/**
 * Long output keeps its first and last lines with "Show N more lines" between them, so the
 * first traceback and the final result both stay visible. Copy always copies the full text.
 */
export function HeadTailOutput(props: {
  readonly text: string;
  readonly className?: string;
  readonly maxLines?: number;
  readonly render?: (text: string) => ReactNode;
  /** Lines shown once expanded; the rest is left to Copy or "Open diff". */
  readonly expandedLimit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { head, hidden, tail, omitted } = headTailText(
    props.text,
    props.maxLines ?? TOOL_OUTPUT_MAX_LINES,
    expanded,
    props.expandedLimit ?? EXPANDED_OUTPUT_LIMIT,
  );
  const render = props.render ?? ((text: string) => text);
  return (
    <div className="group/copyable relative">
      <div className="absolute end-0 top-0 z-1">
        <CopyTextButton text={props.text} label="Copy output" />
      </div>
      <pre className={cn("pe-6", props.className)}>
        {render(head)}
        {hidden > 0 ? (
          <>
            {"\n"}
            <button
              type="button"
              className="my-0.5 rounded-md border border-dashed border-border px-1.5 font-sans text-2xs text-muted-foreground hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(true);
              }}
            >
              Show {hidden} more {hidden === 1 ? "line" : "lines"}
            </button>
            {"\n"}
            {render(tail)}
          </>
        ) : null}
        {omitted > 0 ? (
          <span className="block font-sans text-2xs text-muted-foreground">
            {omitted} more lines not shown. Copy has the full text.
          </span>
        ) : null}
      </pre>
    </div>
  );
}

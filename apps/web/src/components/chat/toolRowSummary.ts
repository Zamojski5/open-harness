import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import { firstErrorLine, terminalExitLabel } from "./dshDerived";

export interface ToolRowFile {
  readonly path: string;
  readonly oldPath?: string | undefined;
  /** A deleted file has nothing to open. */
  readonly linkable: boolean;
}

export interface ToolRowSummary {
  readonly diffStat: { readonly additions: number; readonly deletions: number } | null;
  readonly files: ReadonlyArray<ToolRowFile>;
  readonly exitLabel: string | null;
  readonly errorLine: string | null;
}

const EMPTY: ToolRowSummary = { diffStat: null, files: [], exitLabel: null, errorLine: null };

function isDeleteOperation(operation: string): boolean {
  return operation === "delete" || operation === "remove" || operation === "deleted";
}

function inlineOutputText(item: OrchestrationV2TurnItem): string | null {
  if (item.type === "command_execution") return item.output ?? null;
  if (item.type === "dynamic_tool") return typeof item.output === "string" ? item.output : null;
  return null;
}

/**
 * What a collapsed tool row shows next to its label (DSH ToolRow behaviour): a +/- diffstat and
 * one link per changed file, an exit badge for failed commands, and the first error line of a
 * failed tool. It reads only data already on the row, so a collapsed row never fetches.
 */
export function toolRowSummary(item: OrchestrationV2TurnItem | undefined): ToolRowSummary {
  if (item === undefined) return EMPTY;
  if (item.type === "file_change") {
    const changes = item.changes ?? [];
    const files: ToolRowFile[] =
      changes.length > 0
        ? changes.map((change) => ({
            path: change.path,
            oldPath: change.oldPath,
            linkable: !isDeleteOperation(change.operation),
          }))
        : [{ path: item.fileName, linkable: true }];
    const diffStat =
      item.additions !== undefined || item.deletions !== undefined
        ? { additions: item.additions ?? 0, deletions: item.deletions ?? 0 }
        : null;
    return { ...EMPTY, diffStat, files };
  }
  const failed = item.status === "failed";
  const exitLabel = item.type === "command_execution" ? terminalExitLabel(item.exitCode) : null;
  const errorLine = failed || exitLabel !== null ? firstErrorLine(inlineOutputText(item)) : null;
  return { ...EMPTY, exitLabel, errorLine };
}

import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toolRowSummary } from "./toolRowSummary";

const item = (fields: Record<string, unknown>) => fields as unknown as OrchestrationV2TurnItem;

describe("toolRowSummary", () => {
  it("lists changed files with a diffstat, and deleted files unlinked", () => {
    const summary = toolRowSummary(
      item({
        type: "file_change",
        status: "completed",
        fileName: "a.ts",
        additions: 3,
        deletions: 1,
        changes: [
          { operation: "update", path: "a.ts" },
          { operation: "move", path: "c.ts", oldPath: "b.ts" },
          { operation: "delete", path: "d.ts" },
        ],
      }),
    );
    expect(summary.diffStat).toEqual({ additions: 3, deletions: 1 });
    expect(summary.files.map((file) => [file.path, file.linkable, file.oldPath])).toEqual([
      ["a.ts", true, undefined],
      ["c.ts", true, "b.ts"],
      ["d.ts", false, undefined],
    ]);
  });
  it("falls back to fileName when there are no change details", () => {
    const summary = toolRowSummary(
      item({ type: "file_change", status: "completed", fileName: "x" }),
    );
    expect(summary.files).toEqual([{ path: "x", linkable: true }]);
    expect(summary.diffStat).toBeNull();
  });
  it("adds an exit badge and the first error line for a failed command", () => {
    const summary = toolRowSummary(
      item({
        type: "command_execution",
        status: "failed",
        input: "make",
        exitCode: 2,
        output: "cc main.c\nmain.c:3: error: expected ';'\n",
      }),
    );
    expect(summary.exitLabel).toBe("exit 2");
    expect(summary.errorLine).toBe("main.c:3: error: expected ';'");
  });
  it("shows nothing extra for a successful command or missing output", () => {
    expect(
      toolRowSummary(item({ type: "command_execution", status: "completed", exitCode: 0 })),
    ).toEqual({ diffStat: null, files: [], exitLabel: null, errorLine: null });
    expect(
      toolRowSummary(item({ type: "dynamic_tool", status: "failed", output: { a: 1 } })).errorLine,
    ).toBeNull();
  });
});

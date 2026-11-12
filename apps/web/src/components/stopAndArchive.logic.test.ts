import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stopAndArchiveLines, stopAndArchiveMessage } from "./stopAndArchive.logic";

const task = (fields: Record<string, unknown>) =>
  fields as unknown as OrchestrationV2PendingBackgroundTask;

describe("stopAndArchiveLines", () => {
  it("lists the turn, named subagents and commands", () => {
    expect(
      stopAndArchiveLines({
        turnRunning: true,
        tasks: [
          task({ taskId: "a", kind: "subagent", description: "Research refs" }),
          task({ taskId: "b", kind: "command", description: "npm run build" }),
          task({ taskId: "c", kind: "background_task" }),
        ],
      }),
    ).toEqual([
      "The reply in progress",
      "1 running subagent: Research refs",
      "1 background command: npm run build",
      "1 other background task",
    ]);
  });
  it("names at most three and counts the rest", () => {
    const tasks = ["a", "b", "c", "d", "e"].map((id) =>
      task({ taskId: id, kind: "subagent", description: id.toUpperCase() }),
    );
    expect(stopAndArchiveLines({ turnRunning: false, tasks })).toEqual([
      "5 running subagents: A, B, C and 2 more",
    ]);
  });
  it("builds the confirmation text", () => {
    expect(stopAndArchiveMessage("Shot 4", ["The reply in progress"])).toContain(
      "This stops:\n• The reply in progress",
    );
  });
});

// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { setGoal } from "@open-herness/creative-mcp/goal-state";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { openHernessHooks, spillMcpResult } from "./hooks.ts";
import {
  checkBudgetQuote,
  checkStopRequest,
  clearQualityGoal,
  clearUserInterrupt,
  noteUserInterrupt,
  providerGoalFromQualityGoal,
  qualityGoalLine,
  qualityGoalStop,
  wholeSentencesOf,
} from "./qualityGoalHooks.ts";

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-goal-hooks-"));
process.env.OPEN_HERNESS_HOME = home;
process.env.OH_MEDIA_JOBS_DIR = NodePath.join(home, "jobs");
afterAll(() => NodeFS.rmSync(home, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-05T10:00:00.000Z");

let transcripts = 0;
function transcript(entries: ReadonlyArray<object>): string {
  transcripts += 1;
  const path = NodePath.join(home, `t-${transcripts}.jsonl`);
  NodeFS.writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
  return path;
}
const human = (at: number, text: string) => ({
  type: "user",
  timestamp: new Date(at).toISOString(),
  message: { role: "user", content: text },
});
const hookInput = (fields: Record<string, unknown>) =>
  ({
    session_id: "s",
    cwd: home,
    hook_event_name: "PreToolUse",
    ...fields,
  }) as unknown as HookInput;
const denied = (output: object) =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === "deny";

describe("quality goal hooks", () => {
  it("matches whole sentences only", () => {
    expect(wholeSentencesOf("Spend at most $20.", "Make it moody. Spend at most $20.")).toBe(true);
    expect(wholeSentencesOf("$20", "Spend at most $20.")).toBe(false);
    expect(wholeSentencesOf("yes", "yes")).toBe(true);
  });

  it("reads caps with the spend tools' rules, Polish included", () => {
    const polish = transcript([human(T0, "Zrób trzy ujęcia. Nie wydawaj więcej niż 20 USD.")]);
    const check = (path: string, spendLimitUsd: number, budgetQuote: string) =>
      denied(
        checkBudgetQuote(
          hookInput({ transcript_path: path, tool_input: { spendLimitUsd, budgetQuote } }),
        ),
      );
    expect(check(polish, 20, "Nie wydawaj więcej niż 20 USD.")).toBe(false);
    expect(check(polish, 30, "Nie wydawaj więcej niż 20 USD.")).toBe(true);
    const prices = transcript([human(T0, "It costs $2 per image.")]);
    expect(check(prices, 2, "It costs $2 per image.")).toBe(true);
    const free = transcript([human(T0, "Free tools only.")]);
    expect(check(free, 0, "Free tools only.")).toBe(false);
    const yes = transcript([human(T0, "yes")]);
    expect(check(yes, 0, "yes")).toBe(true);
  });

  it("accepts a cap the user typed or picked, refuses a made-up or stale one", () => {
    const typed = transcript([human(T0, "Make the poster. You can spend up to $20.")]);
    const ok = checkBudgetQuote(
      hookInput({
        transcript_path: typed,
        tool_input: { spendLimitUsd: 20, budgetQuote: "You can spend up to $20." },
      }),
    );
    expect(denied(ok)).toBe(false);
    expect(
      denied(
        checkBudgetQuote(
          hookInput({
            transcript_path: typed,
            tool_input: { spendLimitUsd: 50, budgetQuote: "Up to $50." },
          }),
        ),
      ),
    ).toBe(true);
    const stale = transcript([
      human(T0, "You can spend up to $20."),
      human(T0 + 1000, "Actually keep it to $5."),
    ]);
    expect(
      denied(
        checkBudgetQuote(
          hookInput({
            transcript_path: stale,
            tool_input: { spendLimitUsd: 20, budgetQuote: "You can spend up to $20." },
          }),
        ),
      ),
    ).toBe(true);
    const card = transcript([
      {
        type: "assistant",
        timestamp: new Date(T0).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }],
        },
      },
      {
        type: "user",
        timestamp: new Date(T0 + 1).toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "q1",
              content: 'User has answered your questions: "Spend cap?"="Up to $10"',
            },
          ],
        },
      },
    ]);
    expect(
      denied(
        checkBudgetQuote(
          hookInput({
            transcript_path: card,
            tool_input: { spendLimitUsd: 10, budgetQuote: "Up to $10" },
          }),
        ),
      ),
    ).toBe(false);
    expect(
      denied(
        checkBudgetQuote(hookInput({ transcript_path: card, tool_input: { localOnly: true } })),
      ),
    ).toBe(false);
  });

  it("ended needs the user's own stop request", () => {
    setGoal({ threadId: "hook-end", objective: "x", criteria: [], references: [] }, T0);
    const path = transcript([
      human(T0 - 1000, "Make a trailer."),
      human(T0 + 5000, "Stop here, show me what you have."),
    ]);
    const end = (userRequest: string) =>
      checkStopRequest(
        hookInput({ transcript_path: path, tool_input: { status: "ended", userRequest } }),
        "hook-end",
      );
    expect(denied(end("Stop here, show me what you have."))).toBe(false);
    expect(denied(end("The user is happy."))).toBe(true);
  });

  it("the Stop hook blocks while the goal is open and lets subagents go", () => {
    setGoal({ threadId: "hook-stop", objective: "poster", criteria: [], references: [] });
    const stop = hookInput({ hook_event_name: "Stop", stop_hook_active: false });
    const first = qualityGoalStop(stop, "hook-stop", "s:1") as {
      decision?: string;
      reason?: string;
    };
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("goal_review");
    expect(qualityGoalStop(hookInput({ agent_id: "sub" }), "hook-stop", "s:1")).toEqual({});
    expect(qualityGoalStop(stop, "hook-nogoal", "s:1")).toEqual({});
  });

  it("shows the goal in the thread's goal line with the latest score and gaps", () => {
    const goal = setGoal({
      threadId: "hook-line",
      objective: "moody poster",
      criteria: [],
      references: [],
    });
    expect(qualityGoalLine("hook-line")?.lastCheck).toBe("Not reviewed yet (bar 8/10)");
    const line = providerGoalFromQualityGoal(
      {
        ...goal,
        reviews: [
          {
            at: goal.startedAt + 1,
            score: 6.5,
            meetsBar: false,
            gaps: ["sky flat", "logo small"],
            work: [],
          },
        ],
      },
      goal.startedAt + 60_000,
    );
    expect(line).toEqual({
      objective: "moody poster",
      status: "active",
      checks: 1,
      timeUsedSeconds: 60,
      lastCheck: "Score 6.5/10 (bar 8): sky flat; logo small",
    });
    expect(providerGoalFromQualityGoal({ ...goal, status: "plateau" }, goal.startedAt).status).toBe(
      "blocked",
    );
    expect(
      providerGoalFromQualityGoal({ ...goal, status: "out_of_budget" }, goal.startedAt).status,
    ).toBe("budget_limited");
  });

  it("spills oversized results of other MCP servers and leaves ours alone", () => {
    const big = `FIRST ${"x".repeat(60_000)} LAST`;
    const post = (tool_name: string, tool_response: unknown) =>
      spillMcpResult(
        hookInput({ hook_event_name: "PostToolUse", tool_name, tool_response, cwd: home }),
        "thread-spill",
      ) as { hookSpecificOutput?: { updatedToolOutput?: unknown } };
    const out = post("mcp__lightcraft__export", [{ type: "text", text: big }]).hookSpecificOutput
      ?.updatedToolOutput as Array<{ text: string }>;
    expect(out[0]!.text.startsWith("FIRST")).toBe(true);
    expect(out[0]!.text).toContain("LAST");
    expect(out[0]!.text).toContain(NodePath.join(home, "spill", "thread-spill"));
    expect(Buffer.byteLength(out[0]!.text)).toBeLessThanOrEqual(20_000);
    expect(post("mcp__open-herness-creative__blender_exec", [{ type: "text", text: big }])).toEqual(
      {},
    );
    expect(post("mcp__lightcraft__export", [{ type: "text", text: "small" }])).toEqual({});
    expect(post("Bash", big)).toEqual({});
  });

  it("the user's interrupt always wins over the hold", () => {
    setGoal({ threadId: "hook-int", objective: "poster", criteria: [], references: [] });
    const stop = hookInput({ hook_event_name: "Stop", stop_hook_active: false });
    noteUserInterrupt("hook-int");
    for (let i = 0; i < 5; i++) expect(qualityGoalStop(stop, "hook-int", `s:${i}`)).toEqual({});
    clearUserInterrupt("hook-int");
    expect((qualityGoalStop(stop, "hook-int", "s:9") as { decision?: string }).decision).toBe(
      "block",
    );
  });

  it("never holds when the creative tools are off, and /goal clear ends the goal", () => {
    setGoal({ threadId: "hook-off", objective: "poster", criteria: [], references: [] });
    const stop = hookInput({ hook_event_name: "Stop", stop_hook_active: false });
    expect(qualityGoalStop(stop, "hook-off", "s:1", { creativeToolsAvailable: false })).toEqual({});
    clearQualityGoal("hook-off", "Cleared by the user with /goal clear.");
    expect(qualityGoalStop(stop, "hook-off", "s:2")).toEqual({});
    expect(qualityGoalLine("hook-off")?.status).toBe("complete");
  });

  it("registers the Stop hook and the goal tool checks", () => {
    const hooks = openHernessHooks({ threadId: "t" });
    expect(hooks.Stop?.length).toBe(1);
    expect(hooks.PreToolUse?.map((m) => m.matcher)).toContain(
      "mcp__open-herness-creative__goal_set",
    );
  });
});

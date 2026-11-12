// goal_set / goal_review / goal_end: the quality goal of this thread (see state.ts) and its
// independent reviewer (review.ts). The server checks the user's own words for spend caps and
// stop requests before goal_set / goal_end run (openHerness/hooks.ts, PreToolUse).

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logMoment } from "../case/sources.ts";
import { reviewWork } from "./review.ts";
import {
  currentReviews,
  getGoal,
  goalLimit,
  jobsFor,
  recordReview,
  setGoal,
  summarize,
  endGoal,
  type QualityGoal,
} from "./state.ts";

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 1),
    },
  ],
});
const fail = (message: string) => ({ ...text(message), isError: true });

const NO_THREAD =
  "Quality goals need an Open Herness thread (T3CODE_THREAD_ID is not set in this session).";
const NO_GOAL = "NO_GOAL: this thread has no open quality goal. Set one with goal_set first.";
const ASK_FOR_CAP =
  'ASK_FOR_CAP: a spend cap must come from the user. Ask once with the question tool: one cap per option (for example $0 free tools only, $5, $20), none marked recommended, and room to type their own. Then call goal_set again with spendLimitUsd and budgetQuote = the user\'s own sentence or the label of the option they picked. A bare "yes" is not a cap. For work that needs no paid generation at all, pass localOnly: true instead.';

const threadId = () => process.env.T3CODE_THREAD_ID;
const contextFor = (goal: QualityGoal) => ({
  now: Date.now(),
  ...jobsFor(goal.threadId, goal.startedAt),
});

export function registerGoalTools(server: McpServer) {
  server.registerTool(
    "goal_set",
    {
      description:
        "Set this thread's quality goal before iterating on visual work: objective, the user's bar in their own words (criteria), absolute paths of reference files, target score (default 8/10), time budget (default 8 h) and a spend cap from the user's own words (or localOnly for free/local work). While the goal is open you are held at the end of each turn until goal_review says the bar is met or a limit is reached. Calling it again starts a new goal and budget.",
      inputSchema: {
        objective: z.string().min(1).max(2000),
        criteria: z.array(z.string().min(1).max(500)).default([]),
        references: z.array(z.string().min(1).max(4096)).default([]),
        target: z.number().min(5).max(10).optional(),
        hours: z.number().min(0.25).max(24).optional(),
        spendLimitUsd: z.number().min(0).optional(),
        budgetQuote: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "the user's own sentence stating the cap, or the label of the cap option they picked",
          ),
        localOnly: z
          .boolean()
          .optional()
          .describe("true when the work uses no paid generation: cap $0, no quote needed"),
      },
    },
    async (input) => {
      const thread = threadId();
      if (!thread) return fail(NO_THREAD);
      const relative = input.references.filter((p) => !NodePath.isAbsolute(p));
      if (relative.length) return fail(`References must be absolute paths: ${relative.join(", ")}`);
      const missing = input.references.filter((p) => !NodeFS.existsSync(p));
      if (missing.length) return fail(`These reference files do not exist: ${missing.join(", ")}`);
      let spendLimitUsd: number;
      if (input.localOnly) {
        if ((input.spendLimitUsd ?? 0) > 0)
          return fail(
            "localOnly means no paid generation, so the spend cap must be 0 (or leave it out).",
          );
        spendLimitUsd = 0;
      } else {
        if (input.spendLimitUsd === undefined || input.budgetQuote === undefined)
          return fail(ASK_FOR_CAP);
        spendLimitUsd = input.spendLimitUsd;
      }
      const goal = setGoal({
        threadId: thread,
        objective: input.objective,
        criteria: input.criteria,
        references: input.references,
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.hours === undefined ? {} : { hours: input.hours }),
        spendLimitUsd,
      });
      return text({
        ok: true,
        goal: summarize(goal, contextFor(goal)),
        next: "Work toward the bar, show each new version, and score it with goal_review.",
      });
    },
  );

  server.registerTool(
    "goal_review",
    {
      description:
        "Independent review of a new version against this thread's quality goal and references. A separate model sees only the goal, stills of the references and stills of the work (videos: evenly spaced stills, so motion and sound are not judged), never your reasoning. Returns score 0-10, meetsBar, up to 8 gaps (biggest first), up to 4 strengths and a short summary. Run it after each version you show; the goal closes as met when the bar is cleared.",
      inputSchema: {
        work: z
          .array(z.string().min(1))
          .min(1)
          .max(6)
          .describe("absolute paths of the new version's files"),
        note: z.string().max(1000).optional().describe("what changed since the last version"),
      },
    },
    async (input) => {
      const thread = threadId();
      if (!thread) return fail(NO_THREAD);
      const goal = getGoal(thread);
      if (!goal || (goal.status !== "active" && goal.status !== "met")) return fail(NO_GOAL);
      const relative = input.work.filter((p) => !NodePath.isAbsolute(p));
      if (relative.length) return fail(`Work paths must be absolute: ${relative.join(", ")}`);
      let verdict;
      try {
        verdict = await reviewWork({
          objective: goal.objective,
          target: goal.target,
          criteria: goal.criteria,
          references: goal.references,
          work: input.work,
          note: input.note,
        });
      } catch (error) {
        return fail(
          `The reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const previous = currentReviews(goal).at(-1)?.score;
      if (previous === undefined || previous !== verdict.score)
        logMoment(process.cwd(), {
          kind: "score_change",
          label: previous === undefined ? "first review" : "review score",
          data: {
            ...(previous !== undefined ? { from: previous } : {}),
            to: verdict.score,
            target: goal.target,
            threadId: thread,
          },
          source: "goal_review",
        });
      const updated =
        recordReview(thread, {
          at: Date.now(),
          score: verdict.score,
          meetsBar: verdict.meetsBar,
          gaps: verdict.gaps,
          work: input.work,
        }) ?? goal;
      return text({ ...verdict, goal: summarize(updated, contextFor(updated)) });
    },
  );

  server.registerTool(
    "goal_end",
    {
      description:
        'Close this thread\'s quality goal. "met": only after the latest goal_review cleared the bar. "out_of_budget" / "plateau": only once the time or spend limit is reached or the scores stopped improving (you are told when). "ended": only when the user asked to stop; userRequest must quote their words. Report the latest score and what still falls short when you close it.',
      inputSchema: {
        status: z.enum(["met", "out_of_budget", "plateau", "ended"]),
        reason: z.string().min(1).max(1000),
        userRequest: z.string().max(4000).optional(),
      },
    },
    async (input) => {
      const thread = threadId();
      if (!thread) return fail(NO_THREAD);
      const goal = getGoal(thread);
      if (!goal || (goal.status !== "active" && goal.status !== "met")) return fail(NO_GOAL);
      const context = contextFor(goal);
      const latest = currentReviews(goal).at(-1);
      if (input.status === "met" && !(latest && latest.meetsBar && latest.score >= goal.target))
        return fail(
          `Not met yet: the latest review ${latest ? `scored ${latest.score}/10` : "does not exist"} against a bar of ${goal.target}/10. Improve the work and run goal_review again.`,
        );
      if (
        (input.status === "out_of_budget" || input.status === "plateau") &&
        goal.wrapUpToldAt === undefined &&
        goalLimit(goal, context) === undefined
      )
        return fail("No limit has been reached yet: keep improving toward the bar.");
      if (input.status === "ended" && !input.userRequest)
        return fail('"ended" needs userRequest: quote the user asking to stop.');
      const closed = endGoal(thread, input.status, input.reason) ?? goal;
      return text({ ok: true, goal: summarize(closed, context) });
    },
  );
}

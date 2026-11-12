import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  decideStop,
  endGoal,
  goalHistoryPath,
  goalPath,
  goalsDir,
  GOAL_LIMITS,
  getGoal,
  loadGoals,
  plateaued,
  recordReview,
  setGoal,
  stopHold,
  touchGoal,
  type QualityGoal,
} from "./state.ts";

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-goal-state-"));
process.env.OPEN_HERNESS_HOME = home;
NodeTest.after(() => NodeFS.rmSync(home, { recursive: true, force: true }));

const T0 = 1_800_000_000_000;
const quiet = { runningJobs: 0, spentUsd: 0 };
const review = (at: number, score: number, meetsBar = false) => ({
  at,
  score,
  meetsBar,
  gaps: [`gap at ${score}`],
  work: ["/w.png"],
});

NodeTest.test("defaults: target 8, 8 hours, capped at 24 hours", () => {
  const goal = setGoal(
    { threadId: "t-defaults", objective: "poster", criteria: [], references: [] },
    T0,
  );
  NodeAssert.equal(goal.target, 8);
  NodeAssert.equal(goal.deadlineAt - goal.startedAt, 8 * 3_600_000);
  const long = setGoal(
    { threadId: "t-long", objective: "x", criteria: [], references: [], hours: 99 },
    T0,
  );
  NodeAssert.equal(long.deadlineAt - long.startedAt, 24 * 3_600_000);
});

NodeTest.test(
  "holds twice without a review, then lets the turn end; a review resets the count",
  () => {
    setGoal({ threadId: "t-holds", objective: "film", criteria: [], references: [] }, T0);
    const first = stopHold("t-holds", "turn-1", quiet, T0 + 1);
    NodeAssert.match(first!, /Nothing has been reviewed yet/);
    NodeAssert.ok(stopHold("t-holds", "turn-1", quiet, T0 + 2));
    NodeAssert.equal(stopHold("t-holds", "turn-1", quiet, T0 + 3), undefined);
    recordReview("t-holds", review(T0 + 4, 6), T0 + 4);
    const held = stopHold("t-holds", "turn-1", quiet, T0 + 5)!;
    NodeAssert.match(held, /scored 6\/10/);
    NodeAssert.match(held, /- gap at 6/);
  },
);

NodeTest.test("a new turn resets the hold count", () => {
  setGoal({ threadId: "t-turns", objective: "film", criteria: [], references: [] }, T0);
  stopHold("t-turns", "a", quiet, T0 + 1);
  stopHold("t-turns", "a", quiet, T0 + 2);
  NodeAssert.equal(stopHold("t-turns", "a", quiet, T0 + 3), undefined);
  NodeAssert.ok(stopHold("t-turns", "b", quiet, T0 + 4));
});

NodeTest.test("running media jobs always let the turn end", () => {
  setGoal({ threadId: "t-jobs", objective: "x", criteria: [], references: [] }, T0);
  NodeAssert.equal(stopHold("t-jobs", "a", { runningJobs: 1, spentUsd: 0 }, T0 + 1), undefined);
});

NodeTest.test("a met goal no longer holds", () => {
  setGoal({ threadId: "t-met", objective: "x", criteria: [], references: [] }, T0);
  const goal = recordReview("t-met", review(T0 + 1, 8.5, true), T0 + 1)!;
  NodeAssert.equal(goal.status, "met");
  NodeAssert.equal(stopHold("t-met", "a", quiet, T0 + 2), undefined);
  setGoal({ threadId: "t-met2", objective: "x", criteria: [], references: [], target: 9 }, T0);
  NodeAssert.equal(recordReview("t-met2", review(T0 + 1, 8.5, true), T0 + 1)!.status, "active");
});

NodeTest.test("limits wrap up once per goal: time, then spend, then plateau", () => {
  setGoal({ threadId: "t-time", objective: "x", criteria: [], references: [], hours: 1 }, T0);
  const late = T0 + 3_600_000;
  NodeAssert.match(stopHold("t-time", "a", quiet, late)!, /time budget is used up/);
  NodeAssert.equal(stopHold("t-time", "b", quiet, late + 1), undefined);
  NodeAssert.equal(getGoal("t-time", late + 1)!.status, "active");

  setGoal(
    { threadId: "t-spend", objective: "x", criteria: [], references: [], spendLimitUsd: 5 },
    T0,
  );
  NodeAssert.ok(
    stopHold("t-spend", "a", { runningJobs: 0, spentUsd: 4.99 }, T0 + 1)!.startsWith(
      "Quality goal",
    ),
  );
  NodeAssert.match(
    stopHold("t-spend", "a", { runningJobs: 0, spentUsd: 5 }, T0 + 2)!,
    /spend cap of \$5/,
  );

  setGoal(
    { threadId: "t-zero", objective: "x", criteria: [], references: [], spendLimitUsd: 0 },
    T0,
  );
  NodeAssert.match(
    stopHold("t-zero", "a", { runningJobs: 0, spentUsd: 0.01 }, T0 + 1)!,
    /spend cap of \$0/,
  );
});

NodeTest.test("plateau: last 3 reviews not at least 0.5 above the earlier best", () => {
  const base: QualityGoal = {
    threadId: "p",
    objective: "x",
    criteria: [],
    references: [],
    target: 8,
    startedAt: T0,
    deadlineAt: T0 + 1e9,
    status: "active",
    reviews: [],
    holdsSinceReview: 0,
  };
  const withScores = (...scores: number[]) => ({
    ...base,
    reviews: scores.map((score, i) => review(T0 + i, score)),
  });
  NodeAssert.equal(plateaued(withScores(6, 6, 6)), false);
  NodeAssert.equal(plateaued(withScores(6, 6, 6, 6)), true);
  NodeAssert.equal(plateaued(withScores(6, 5, 6, 6.6)), false);
  NodeAssert.equal(plateaued(withScores(7, 5, 6, 7)), true);
  // A slowly rising, noisy series no longer runs until the deadline.
  NodeAssert.equal(plateaued(withScores(6.0, 6.1, 6.3, 6.2, 6.4)), true);
  const stale = { ...withScores(6, 6, 6, 6), startedAt: T0 + 10 };
  NodeAssert.equal(plateaued(stale), false);
  NodeAssert.equal(decideStop(withScores(6, 6, 6, 6), { now: T0 + 5, ...quiet }).kind, "wrap_up");
});

NodeTest.test("reviews and holds per goal are capped", () => {
  setGoal({ threadId: "t-caps", objective: "x", criteria: [], references: [] }, T0);
  for (let i = 0; i < GOAL_LIMITS.maxReviews; i++)
    recordReview("t-caps", review(T0 + 1 + i, 1 + i * 0.6), T0 + 1 + i);
  NodeAssert.match(stopHold("t-caps", "a", quiet, T0 + 100)!, /12 reviews have been used/);
  setGoal({ threadId: "t-holdcap", objective: "x", criteria: [], references: [] }, T0);
  let holds = 0;
  for (let turn = 0; turn < 40; turn++)
    for (let i = 0; i < 3; i++)
      if (stopHold("t-holdcap", `turn-${turn}`, quiet, T0 + turn * 10 + i)) holds += 1;
  NodeAssert.equal(holds, GOAL_LIMITS.maxHolds + 1);
});

NodeTest.test("a goal that was ended is never brought back by a later hold or review", () => {
  setGoal({ threadId: "t-ended", objective: "x", criteria: [], references: [] }, T0);
  NodeAssert.ok(endGoal("t-ended", "ended", "user said stop", T0 + 1));
  NodeAssert.equal(stopHold("t-ended", "a", quiet, T0 + 2), undefined);
  NodeAssert.equal(recordReview("t-ended", review(T0 + 3, 9, true), T0 + 3), undefined);
  NodeAssert.equal(getGoal("t-ended", T0 + 4)!.status, "ended");
});

NodeTest.test("threads keep separate goal files", () => {
  setGoal({ threadId: "t-a", objective: "a", criteria: [], references: [] }, T0);
  setGoal({ threadId: "t-b", objective: "b", criteria: [], references: [] }, T0);
  endGoal("t-a", "ended", "stop", T0 + 1);
  stopHold("t-b", "x", quiet, T0 + 2);
  NodeAssert.equal(getGoal("t-a", T0 + 3)!.status, "ended");
  NodeAssert.equal(getGoal("t-b", T0 + 3)!.status, "active");
});

NodeTest.test("goal_set again resets budget and holds, keeps old reviews out of the count", () => {
  setGoal({ threadId: "t-reset", objective: "x", criteria: [], references: [] }, T0);
  recordReview("t-reset", review(T0 + 1, 5), T0 + 1);
  touchGoal({ ...getGoal("t-reset", T0 + 2)!, wrapUpToldAt: T0 + 2, holdsSinceReview: 2 }, T0 + 2);
  const again = setGoal(
    { threadId: "t-reset", objective: "y", criteria: [], references: [] },
    T0 + 3,
  );
  NodeAssert.equal(again.holdsSinceReview, 0);
  NodeAssert.equal(again.wrapUpToldAt, undefined);
  NodeAssert.equal(again.reviews.length, 1);
  NodeAssert.match(stopHold("t-reset", "a", quiet, T0 + 4)!, /Nothing has been reviewed yet/);
});

NodeTest.test("an active goal past its deadline plus 1 h grace is closed on load", () => {
  setGoal({ threadId: "t-expire", objective: "x", criteria: [], references: [], hours: 1 }, T0);
  const after = T0 + 3_600_000 + GOAL_LIMITS.expiryGraceMs + 1;
  NodeAssert.equal(getGoal("t-expire", after)!.status, "out_of_budget");
  NodeAssert.equal(
    loadGoals(after).find((g) => g.threadId === "t-expire")!.status,
    "out_of_budget",
  );
});

NodeTest.test("keeps at most 256 goal files; drops malformed reviews one by one", () => {
  NodeFS.mkdirSync(goalsDir(), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(goalsDir(), "bad.json"), JSON.stringify({ threadId: 3 }));
  NodeAssert.equal(getGoal("bad", T0), undefined);
  const goal = setGoal({ threadId: "t-mixed", objective: "x", criteria: [], references: [] }, T0);
  NodeFS.writeFileSync(
    goalPath("t-mixed"),
    JSON.stringify({ ...goal, reviews: [review(T0 + 1, 5), { at: "x" }] }),
  );
  NodeAssert.equal(getGoal("t-mixed", T0 + 2)!.reviews.length, 1);
  for (let i = 0; i < GOAL_LIMITS.goalsKept + 5; i++)
    setGoal({ threadId: `lru-${i}`, objective: "x", criteria: [], references: [] }, T0);
  const files = NodeFS.readdirSync(goalsDir()).filter((name) => name.endsWith(".json"));
  NodeAssert.ok(files.length <= GOAL_LIMITS.goalsKept);
  NodeAssert.ok(files.includes(`lru-${GOAL_LIMITS.goalsKept + 4}.json`));
});

NodeTest.test("a replaced goal is kept in the thread's history file", () => {
  setGoal({ threadId: "t-hist", objective: "first", criteria: [], references: [] }, T0);
  setGoal({ threadId: "t-hist", objective: "second", criteria: [], references: [] }, T0 + 1000);
  const lines = NodeFS.readFileSync(goalHistoryPath("t-hist"), "utf8").trim().split("\n");
  NodeAssert.equal(lines.length, 1);
  NodeAssert.equal(JSON.parse(lines[0]!).objective, "first");
  NodeAssert.equal(getGoal("t-hist", T0 + 1000)?.objective, "second");
  // the history file is not read as a goal
  NodeAssert.ok(!loadGoals(T0 + 1000).some((g) => g.objective === "first"));
});

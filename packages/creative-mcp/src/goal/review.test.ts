import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { finishAnswer, reviewWork, stillTimes, workStillCount } from "./review.ts";
import { getGoal } from "./state.ts";
import { registerGoalTools } from "./tools.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-goal-review-"));
process.env.OPEN_HERNESS_HOME = dir;
process.env.OH_MEDIA_JOBS_DIR = NodePath.join(dir, "jobs");
NodeTest.after(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

function ffmpeg(args: string[]): boolean {
  try {
    NodeChildProcess.execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
    return true;
  } catch {
    return false;
  }
}

/** A stand-in reviewer CLI: records what it was sent and answers with a fixed verdict. */
function fakeReviewer(answer: object): string {
  const script = NodePath.join(dir, `reviewer-${Math.random().toString(36).slice(2)}.mjs`);
  NodeFS.writeFileSync(
    script,
    `#!${process.execPath}
import * as fs from "node:fs";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const message = JSON.parse(input.trim());
  fs.writeFileSync(${JSON.stringify(NodePath.join(dir, "sent.json"))}, JSON.stringify({ args: process.argv.slice(2), message }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: ${JSON.stringify(answer)}, modelUsage: { "claude-test": {} } }));
});
`,
    { mode: 0o755 },
  );
  return script;
}

NodeTest.test("still sampling and per-file counts follow the reviewer limits", () => {
  NodeAssert.deepEqual(stillTimes(8, 4), [1, 3, 5, 7]);
  NodeAssert.equal(workStillCount(1), 8);
  NodeAssert.equal(workStillCount(3), 5);
  NodeAssert.equal(workStillCount(6), 2);
});

NodeTest.test("meetsBar is forced off below the target; scores are clamped and rounded", () => {
  const base = { gaps: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], strengths: [], summary: "s" };
  NodeAssert.equal(finishAnswer({ ...base, score: 7.94, meetsBar: true }, 8)!.meetsBar, false);
  NodeAssert.equal(finishAnswer({ ...base, score: 7.94, meetsBar: true }, 8)!.score, 7.9);
  NodeAssert.equal(finishAnswer({ ...base, score: 12, meetsBar: true }, 8)!.score, 10);
  NodeAssert.equal(finishAnswer({ ...base, score: 12, meetsBar: true }, 8)!.gaps.length, 8);
  NodeAssert.equal(finishAnswer({ score: "x" }, 8), undefined);
});

NodeTest.test("reviews video stills beside reference stills with a tool-free call", async (t) => {
  const ref = NodePath.join(dir, "ref.png");
  const clip = NodePath.join(dir, "clip.mp4");
  if (
    !ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=320x180", "-frames:v", "1", ref]) ||
    !ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x180:d=4:r=10", "-pix_fmt", "yuv420p", clip])
  )
    return t.skip("ffmpeg not available");
  process.env.OH_GOAL_REVIEWER_CMD = fakeReviewer({
    score: 6.2,
    meetsBar: true,
    gaps: ["sky too flat"],
    strengths: ["framing"],
    summary: "Close.",
  });
  const result = await reviewWork({
    objective: "moody sky",
    target: 8,
    criteria: ["like the references"],
    references: [ref],
    work: [clip],
  });
  NodeAssert.equal(result.score, 6.2);
  NodeAssert.equal(result.meetsBar, false);
  NodeAssert.equal(result.reviewer, "claude-test");
  NodeAssert.equal(result.judgedFrom, "8 stills of the work beside 1 of the references");
  const sent = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "sent.json"), "utf8"));
  const images = sent.message.message.content.filter((c: { type: string }) => c.type === "image");
  NodeAssert.equal(images.length, 9);
  const args: string[] = sent.args;
  NodeAssert.equal(args[args.indexOf("--tools") + 1], "");
  NodeAssert.ok(args.includes("--json-schema") && args.includes("--strict-mcp-config"));
});

NodeTest.test(
  "goal tools: set needs a cap or localOnly, review records, end checks the bar",
  async (t) => {
    const work = NodePath.join(dir, "work.png");
    if (!ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=320x180", "-frames:v", "1", work]))
      return t.skip("ffmpeg not available");
    process.env.T3CODE_THREAD_ID = "thread-tools";
    // goal_review logs key moments into the project (cwd): keep them in the temp folder
    const cwd = process.cwd();
    process.chdir(dir);
    t.after(() => process.chdir(cwd));
    const server = new McpServer({ name: "t", version: "0" });
    registerGoalTools(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      return { text: result.content[0]!.text, isError: result.isError === true };
    };
    const noCap = await call("goal_set", { objective: "red poster" });
    NodeAssert.ok(noCap.isError && noCap.text.startsWith("ASK_FOR_CAP"));
    const set = await call("goal_set", { objective: "red poster", localOnly: true, target: 8 });
    NodeAssert.equal(set.isError, false);
    NodeAssert.equal(getGoal("thread-tools")!.spendLimitUsd, 0);
    const early = await call("goal_end", { status: "met", reason: "done" });
    NodeAssert.ok(early.isError);
    NodeAssert.ok((await call("goal_end", { status: "plateau", reason: "x" })).isError);
    process.env.OH_GOAL_REVIEWER_CMD = fakeReviewer({
      score: 8.4,
      meetsBar: true,
      gaps: [],
      strengths: ["colour"],
      summary: "Good.",
    });
    const reviewed = await call("goal_review", { work: [work] });
    NodeAssert.equal(reviewed.isError, false);
    NodeAssert.equal(JSON.parse(reviewed.text).goal.status, "met");
    const moment = JSON.parse(
      NodeFS.readFileSync(NodePath.join(dir, ".open-herness", "key-moments.jsonl"), "utf8").trim(),
    );
    NodeAssert.equal(moment.kind, "score_change");
    NodeAssert.equal(moment.data.to, 8.4);
    const end = await call("goal_end", { status: "met", reason: "bar cleared" });
    NodeAssert.equal(end.isError, false);
    NodeAssert.equal(getGoal("thread-tools")!.status, "met");
    await client.close();
  },
);

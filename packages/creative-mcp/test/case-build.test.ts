// End to end: CASE.md + numbers.json + PDF from fixture logs (a fixture server database with the
// real table names, jobs, ledger, takes, goals, key moments). PDF and video steps need Chrome and
// ffmpeg; without them those assertions are skipped (the build reports a warning instead).

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildCaseStudy, timelapseFrames } from "../src/case/build.ts";
import { NOT_RECORDED } from "../src/case/metrics.ts";
import { hasChrome, hasFfmpeg, pdfPages, probeVideo, renderVideo } from "../src/case/render.ts";
import {
  logMoment,
  logPresentedOnce,
  readMoments,
  readThreads,
  recordToolMoment,
} from "../src/case/sources.ts";
import { isolate } from "./isolate.ts";

const env = isolate();
const sqlite = (db: string, sql: string) => NodeChildProcess.execFileSync("sqlite3", [db, sql]);
const ff = (args: string[]) =>
  NodeChildProcess.execFileSync("ffmpeg", ["-y", "-v", "error", ...args]);
const iso = (ms: number) => new Date(ms).toISOString();

function fixtureDb(file: string, project: string) {
  const T0 = Date.parse("2026-11-01T09:00:00Z");
  sqlite(
    file,
    `PRAGMA journal_mode=WAL;
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INT, status TEXT, requested_at TEXT, completed_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT, thread_id TEXT, kind TEXT, status TEXT, created_at TEXT, resolved_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT, thread_id TEXT, type TEXT, payload_json TEXT);
    INSERT INTO projection_projects VALUES ('p1','Acme','${project}',NULL), ('p2','Other','/elsewhere',NULL);
    INSERT INTO orchestration_v2_projection_threads VALUES ('th-1','p1','Acme hero film','${iso(T0)}',NULL,'{}'),
      ('th-2','p1','Acme stills','${iso(T0)}',NULL,'{}'), ('th-x','p2','Other','${iso(T0)}',NULL,'{}'),
      ('th-w','p2','Worktree thread','${iso(T0)}',NULL,'{"worktreePath":"${project}-wt"}'),
      ('th-sub','p1','Subagent','${iso(T0)}',NULL,'{"lineage":{"relationshipToParent":"subagent"}}');
    INSERT INTO orchestration_v2_projection_runs VALUES
      ('r1','th-1',1,'completed','${iso(T0)}','${iso(T0 + 3_600_000)}','{"startedAt":"${iso(T0 + 1000)}"}'),
      ('r2','th-2',1,'completed','${iso(T0 + 600_000)}','${iso(T0 + 1_800_000)}','{}'),
      ('r3','th-1',2,'running','${iso(T0 + 7_200_000)}',NULL,'{}'),
      ('rx','th-x',1,'completed','${iso(T0)}','${iso(T0 + 99_000_000)}','{}'),
      ('r4','th-2',2,'interrupted','${iso(T0 + 7_200_000)}','${iso(T0 + 180_000_000)}','{}'),
      ('rs','th-sub',1,'completed','${iso(T0)}','${iso(T0 + 3_600_000)}','{}');
    INSERT INTO orchestration_v2_projection_messages VALUES
      ('m1','th-1','user','${iso(T0)}','{"text":"Acme wants a 15 s launch film for its new kettle, monochrome, punchy."}'),
      ('m2','th-1','assistant','${iso(T0 + 5000)}','{"text":"ok"}'),
      ('m3','th-2','user','${iso(T0 + 600_000)}','{"text":"stills too"}'),
      ('m4','th-2','user','${iso(T0 + 700_000)}','{"text":"continue (written by the agent)","createdBy":"agent"}');
    INSERT INTO orchestration_v2_projection_runtime_requests VALUES
      ('q1','th-1','command','resolved','${iso(T0 + 60_000)}','${iso(T0 + 90_000)}','{"decision":"accept"}'),
      ('q2','th-1','user_input','resolved','${iso(T0 + 60_000)}','${iso(T0 + 990_000)}','{}');
    INSERT INTO orchestration_v2_projection_turn_items VALUES ('i1','th-1','dynamic_tool','{}'),('i2','th-1','assistant_message','{}');`,
  );
  return T0;
}

function fixtureProject() {
  const project = NodePath.join(env.home, "acme-launch");
  const takes = NodePath.join(project, "takes");
  NodeFS.mkdirSync(takes, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(project, "delivery"), { recursive: true });
  const db = NodePath.join(env.home, "statev2.sqlite");
  const T0 = fixtureDb(db, project);
  const ohHome = env.home; // isolate() points OH_HOME here
  const jobsDir = NodePath.join(ohHome, "media", "jobs");
  NodeFS.mkdirSync(jobsDir, { recursive: true });
  const RW = "runware:bytedance:seedance@2.5";
  const jobs = [
    { id: "d1", request: { model: RW, parameters: { duration: 5, draft: true } } },
    { id: "d2", request: { model: RW, parameters: { duration: 5, draft: true } } },
    {
      id: "f1",
      request: {
        model: RW,
        finishDraft: { draftId: "x", provider: "runware", seconds: 5, ofJob: "d2" },
      },
    },
  ];
  for (const j of jobs)
    NodeFS.writeFileSync(
      NodePath.join(jobsDir, `${j.id}.json`),
      JSON.stringify({
        ...j,
        projectPath: project,
        threadId: "th-1",
        model: RW,
        kind: "video",
        state: "completed",
        served: { provider: "runware", model: RW, endpoint: "r" },
        createdAt: T0 + 100,
      }),
    );
  const ledger = [
    { key: "d1", chargeUsd: 0.51 },
    { key: "d2", chargeUsd: 0.51 },
    { key: "f1", chargeUsd: 3.04 },
  ].map((l) =>
    JSON.stringify({
      v: 2,
      chatId: "th-1",
      day: "2026-11-01",
      at: T0,
      state: "spent",
      estimateUsd: 1,
      maxUsd: 5,
      chargeSource: "provider",
      ...l,
    }),
  );
  NodeFS.writeFileSync(NodePath.join(ohHome, "media", "ledger.jsonl"), `${ledger.join("\n")}\n`);
  const goalsDir = NodePath.join(ohHome, "quality-goals");
  NodeFS.mkdirSync(goalsDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(goalsDir, "th-1.json"),
    JSON.stringify({
      threadId: "th-1",
      objective: "Acme film 8/10",
      criteria: [],
      references: [],
      target: 8,
      startedAt: T0,
      deadlineAt: T0 + 1e8,
      status: "met",
      holdsSinceReview: 0,
      reviews: [
        // carried over from an earlier goal of the thread: not this goal's review
        { at: T0 - 5e6, score: 2, meetsBar: false, gaps: [], work: [] },
        { at: T0 + 1e6, score: 6, meetsBar: false, gaps: [], work: [] },
        { at: T0 + 2e6, score: 8, meetsBar: true, gaps: [], work: [] },
      ],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(goalsDir, "th-1.history.jsonl"),
    `${JSON.stringify({
      threadId: "th-1",
      objective: "Acme storyboard 7/10",
      target: 7,
      startedAt: T0 - 9e6,
      status: "active",
      reviews: [{ at: T0 - 5e6, score: 2, meetsBar: false, gaps: [], work: [] }],
    })}\n`,
  );
  if (hasFfmpeg()) {
    ff([
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=320x240",
      "-frames:v",
      "1",
      NodePath.join(takes, "hero-take-01.png"),
    ]);
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240",
      "-frames:v",
      "1",
      NodePath.join(takes, "hero-take-02.png"),
    ]);
    ff([
      "-f",
      "lavfi",
      "-i",
      "testsrc=s=320x240:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      NodePath.join(project, "delivery", "hero.mp4"),
    ]);
  } else {
    NodeFS.writeFileSync(NodePath.join(takes, "hero-take-01.png"), "x");
    NodeFS.writeFileSync(NodePath.join(takes, "hero-take-02.png"), "x");
  }
  NodeFS.writeFileSync(
    NodePath.join(takes, "ledger.json"),
    JSON.stringify({
      picked: "t2",
      takes: [
        { id: "t1", file: "takes/hero-take-01.png", score: 6, added: iso(T0 + 1e6) },
        { id: "t2", file: "takes/hero-take-02.png", score: 8, added: iso(T0 + 2e6) },
      ],
    }),
  );
  logMoment(project, {
    at: T0 + 2e6,
    kind: "score_change",
    label: "review score",
    data: { from: 6, to: 8 },
  });
  return {
    project,
    db,
    T0,
    paths: {
      jobsDir,
      ledgerFile: NodePath.join(ohHome, "media", "ledger.jsonl"),
      goalsDir,
      stateDb: db,
    },
  };
}

describe("case_study_build end to end", () => {
  it("reads the server database through a copy, never touching the original", () => {
    const { project, db } = fixtureProject();
    const before = NodeFS.statSync(db).mtimeMs;
    const t = readThreads(db, { project });
    expect(t.unavailable).toBeUndefined();
    expect(t.threads.map((x) => x.threadId).sort()).toEqual(["th-1", "th-2"]);
    const th1 = t.threads.find((x) => x.threadId === "th-1")!;
    expect(th1.turns).toHaveLength(2);
    expect(th1.turns.find((x) => x.turnId === "r3")?.endedAt).toBeUndefined();
    expect(th1.userMessages).toHaveLength(1);
    expect(th1.approvals).toEqual([expect.objectContaining({ id: "q1", decision: "accept" })]);
    expect(th1.toolCalls).toBe(1);
    // an interrupted run's completedAt is when it was found dead: its end is not recorded
    const th2 = t.threads.find((x) => x.threadId === "th-2")!;
    expect(th2.turns.find((x) => x.turnId === "r4")?.endedAt).toBeUndefined();
    // agent-authored "user" messages are not the human's
    expect(th2.userMessages.map((m) => m.id)).toEqual(["m3"]);
    expect(NodeFS.statSync(db).mtimeMs).toBe(before);
    expect(readThreads(NodePath.join(env.home, "nope.sqlite"), { project }).unavailable).toMatch(
      /not found/,
    );
  });

  it("writes CASE.md, numbers.json (with sources) and a one-page PDF", async () => {
    const { project, paths } = fixtureProject();
    const r = await buildCaseStudy({ project, paths, video: "none", agencyEstimateHours: 60 });
    const dir = NodePath.join(project, "delivery", "case-study");
    const numbers = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "numbers.json"), "utf8"));
    expect(numbers.time.activeAgent.value.turns).toBe(2);
    expect(numbers.time.maxConcurrency.value.threads).toBe(2);
    expect(numbers.time.activeAgent.sources[0].file).toBe(paths.stateDb);
    expect(numbers.spend.total.value.usd).toBe(4.06);
    expect(numbers.spend.withoutDrafts.value.counterfactualUsd).toBeCloseTo(2 * 0.61354 * 5, 2);
    expect(numbers.human.approvalWait.value).toEqual({ ms: 30_000, approvals: 1, unresolved: 0 });
    expect(numbers.moments.map((m: { kind: string }) => m.kind).sort()).toEqual([
      "approval_accepted",
      "score_change",
    ]);
    expect(numbers.agencyEstimate.label).toBe("user's estimate");
    // the replaced goal comes from the history file; the carried-over review stays with it
    const goals = numbers.iterations.goals.value as { objective: string; first: number }[];
    expect(goals.map((g) => [g.objective, g.first])).toEqual([
      ["Acme storyboard 7/10", 2],
      ["Acme film 8/10", 6],
    ]);
    const md = NodeFS.readFileSync(NodePath.join(dir, "CASE.md"), "utf8");
    expect(md).toContain("Acme wants a 15 s launch film");
    expect(md).toContain("First user message");
    expect(md).toContain("6/10 → 8/10");
    expect(md).toMatch(/user's estimate/);
    if (hasChrome()) {
      expect(r.files).toContain("delivery/case-study/case-study.pdf");
      expect(pdfPages(NodePath.join(dir, "case-study.pdf"))).toBe(1);
    } else expect(r.warnings.join(" ")).toMatch(/Chrome/);
    if (hasFfmpeg()) {
      expect(numbers.deliverables.value[0]).toMatchObject({
        file: "delivery/hero.mp4",
        width: 320,
        height: 240,
      });
      expect(r.files).toContain("delivery/case-study/before-after.jpg");
    }
  });

  it("confidential + relative-only + spec: names redacted everywhere, no $ in CASE.md numbers", async () => {
    const { project, paths } = fixtureProject();
    await buildCaseStudy({
      project,
      paths,
      video: "none",
      pdf: false,
      confidential: true,
      relativeOnly: true,
      spec: true,
      clientNames: ["Acme"],
    });
    const dir = NodePath.join(project, "delivery", "case-study");
    const md = NodeFS.readFileSync(NodePath.join(dir, "CASE.md"), "utf8");
    // relative-only: the absolute numbers stay out of delivery/ (audit copy in .open-herness/)
    expect(NodeFS.existsSync(NodePath.join(dir, "numbers.json"))).toBe(false);
    const json = NodeFS.readFileSync(
      NodePath.join(project, ".open-herness", "case-study", "numbers.json"),
      "utf8",
    );
    const html = NodeFS.readFileSync(NodePath.join(dir, "case-study.html"), "utf8");
    for (const text of [md, json, html]) {
      expect(text).not.toMatch(/acme/i);
    }
    expect(json).not.toContain(project);
    // confidential: the readable take images never land in delivery/
    expect(NodeFS.existsSync(NodePath.join(dir, "before-after.jpg"))).toBe(false);
    expect(md).toContain("Spec campaign");
    expect(html).toContain("Spec campaign");
    const numbersSection = md.slice(md.indexOf("## Numbers"), md.indexOf("## Before"));
    expect(numbersSection).not.toMatch(/\$/);
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(md).not.toContain("before-after.jpg)");
  });

  it("brief shows composer chips by their label; confidential with a brand kit warns about the brand name", async () => {
    const { project, paths } = fixtureProject();
    const text =
      "Make the kettle film in [Blender](t3-context://v1/app/app_blender), see [notes.md](t3-context://v1/file/f_1).";
    sqlite(
      paths.stateDb,
      `UPDATE orchestration_v2_projection_messages SET payload_json='${JSON.stringify({ text })}' WHERE message_id='m1';`,
    );
    NodeFS.mkdirSync(NodePath.join(project, "brand"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(project, "brand", "brand.md"), "# Kettleco\n");
    const r = await buildCaseStudy({
      project,
      paths,
      video: "none",
      pdf: false,
      confidential: true,
      clientNames: ["Acme"],
    });
    const md = NodeFS.readFileSync(
      NodePath.join(project, "delivery", "case-study", "CASE.md"),
      "utf8",
    );
    expect(md).toContain("Make the kettle film in Blender, see notes.md.");
    expect(md).not.toContain("t3-context:");
    expect(r.warnings.join(" ")).toMatch(/brand kit/);
    NodeFS.writeFileSync(NodePath.join(project, "brand", "NONE"), "");
    const off = await buildCaseStudy({
      project,
      paths,
      video: "none",
      pdf: false,
      confidential: true,
      clientNames: ["Acme"],
    });
    expect(off.warnings.join(" ")).not.toMatch(/brand kit/);
  });

  it("leaves out the thread that runs the build (its own turn and prompt are not the work)", async () => {
    const { project, paths } = fixtureProject();
    const r = await buildCaseStudy({
      project,
      paths,
      video: "none",
      pdf: false,
      excludeThreadIds: ["th-2"],
    });
    const c = r.numbers.time.maxConcurrency.value;
    expect(c !== NOT_RECORDED && c.threads).toBe(1);
    expect(r.numbers.human.userMessages.value).toBe(1);
  });

  it("a rebuild is idempotent and leaves no stale outputs from an earlier build", async () => {
    const { project, paths } = fixtureProject();
    const dir = NodePath.join(project, "delivery", "case-study");
    const once = { project, paths, video: "none" as const, pdf: false, now: 1 };
    await buildCaseStudy(once);
    const md1 = NodeFS.readFileSync(NodePath.join(dir, "CASE.md"), "utf8");
    const json1 = NodeFS.readFileSync(NodePath.join(dir, "numbers.json"), "utf8");
    NodeFS.writeFileSync(NodePath.join(dir, "case-study-16x9.mp4"), "old cut, old numbers");
    await buildCaseStudy(once);
    expect(NodeFS.readFileSync(NodePath.join(dir, "CASE.md"), "utf8")).toBe(md1);
    expect(NodeFS.readFileSync(NodePath.join(dir, "numbers.json"), "utf8")).toBe(json1);
    expect(NodeFS.existsSync(NodePath.join(dir, "case-study-16x9.mp4"))).toBe(false);
  });

  it("records a final reviewed for delivery once per file (from the MCP tool, so Codex too)", () => {
    const project = NodePath.join(env.home, "moments");
    NodeFS.mkdirSync(project, { recursive: true });
    logPresentedOnce(project, NodePath.join(project, "delivery/final.mp4"));
    logPresentedOnce(project, "delivery/final.mp4");
    logPresentedOnce(project, "delivery/other.mp4");
    expect(readMoments(project).map((m) => m.data?.file)).toEqual([
      "delivery/final.mp4",
      "delivery/other.mp4",
    ]);
    // from finished tool calls: picks and successful reviews only
    recordToolMoment(project, "takes_log", { action: "add", file: "takes/a.png" }, {});
    recordToolMoment(project, "takes_log", { action: "pick", file: "t3" }, { isError: true });
    recordToolMoment(project, "takes_log", { action: "pick", file: "t3" }, {});
    recordToolMoment(project, "media_review", { path: "delivery/third.mp4" }, { isError: true });
    recordToolMoment(project, "media_frames", { path: "delivery/third.mp4" }, {});
    expect(readMoments(project).map((m) => [m.kind, m.data?.take ?? m.data?.file])).toEqual([
      ["deliverable_presented", "delivery/final.mp4"],
      ["deliverable_presented", "delivery/other.mp4"],
      ["take_picked", "t3"],
    ]);
  });

  it("without any logs everything reads 'not recorded'", async () => {
    const project = NodePath.join(env.home, "empty");
    NodeFS.mkdirSync(project, { recursive: true });
    const r = await buildCaseStudy({
      project,
      video: "none",
      pdf: false,
      paths: {
        jobsDir: NodePath.join(env.home, "none"),
        ledgerFile: NodePath.join(env.home, "none.jsonl"),
        goalsDir: NodePath.join(env.home, "none"),
        stateDb: NodePath.join(env.home, "none.sqlite"),
      },
    });
    expect(r.numbers.time.activeAgent.value).toBe(NOT_RECORDED);
    expect(r.numbers.spend.total.value).toBe(NOT_RECORDED);
    const md = NodeFS.readFileSync(
      NodePath.join(project, "delivery", "case-study", "CASE.md"),
      "utf8",
    );
    expect(md).toContain("not recorded");
    expect(md).toContain("Brief not recorded");
  });

  it.runIf(hasFfmpeg())(
    "renders a tiny synthetic video (frames + stills) at the asked size",
    async () => {
      const dir = NodePath.join(env.home, "frames");
      NodeFS.mkdirSync(dir, { recursive: true });
      const frames = [1, 2, 3, 4].map((i) => {
        const f = NodePath.join(dir, `${1_762_000_000_000 + i * 10_000}.jpg`);
        ff(["-f", "lavfi", "-i", `color=c=0x${i}0${i}0${i}0:s=200x120`, "-frames:v", "1", f]);
        return f;
      });
      const still = NodePath.join(dir, "still.png");
      ff(["-f", "lavfi", "-i", "testsrc=s=100x100", "-frames:v", "1", still]);
      const out = NodePath.join(env.home, "tiny.mp4");
      await renderVideo(
        [
          { type: "image", file: still, seconds: 0.5, fit: "cover" },
          { type: "frames", files: frames, seconds: 1, blur: true },
        ],
        out,
        108,
        136,
      );
      const p = probeVideo(out)!;
      expect(p).toMatchObject({ width: 108, height: 136 });
      expect(p.seconds).toBeGreaterThan(1.2);
      expect(p.seconds).toBeLessThan(1.8);
      // the timelapse reader picks frames by their epoch-ms names and range
      const project = NodePath.join(env.home, "p");
      NodeFS.mkdirSync(NodePath.join(project, ".open-herness"), { recursive: true });
      NodeFS.cpSync(dir, NodePath.join(project, ".open-herness", "process-frames"), {
        recursive: true,
      });
      expect(timelapseFrames(project, undefined)).toHaveLength(4);
      expect(timelapseFrames(project, { from: 1_762_000_025_000 })).toHaveLength(2);
      expect(timelapseFrames(project, undefined, 2)).toHaveLength(2);
    },
  );
});

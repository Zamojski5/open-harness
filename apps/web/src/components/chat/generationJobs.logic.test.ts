import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";

import {
  formatGenerationDuration,
  generationSlowWindow,
  isPendingGenerationJob,
  isStaleGenerationSnapshot,
  recentGenerationSnapshots,
  generationStatusView,
  isGenerationJobTool,
  latestGenerationJobs,
  parseGenerationJobs,
  toolOutputText,
} from "./generationJobs.logic";

const RUNNING = [
  "job j1 [running] veo-3.1-fast → fal:fal-ai/veo3.1/fast · 42s",
  "  IN_PROGRESS",
  "  typicalSeconds=70 (p90 150s), elapsed 42s",
  "  cost: ~$0.4 (payer, approximate)",
].join("\n");

describe("parseGenerationJobs", () => {
  it("reads state, model, timing, detail and outputs", () => {
    const [job] = parseGenerationJobs(RUNNING, 1_000);
    expect(job).toMatchObject({
      id: "j1",
      state: "running",
      model: "veo-3.1-fast",
      elapsedSeconds: 42,
      typicalSeconds: 70,
      p90Seconds: 150,
      detail: "IN_PROGRESS",
      observedAtMs: 1_000,
    });
    const done = parseGenerationJobs("job j1 [completed] m · 80s\n  → /takes/a.mp4\n", 2_000);
    expect(done[0]).toMatchObject({ state: "completed", outputs: ["/takes/a.mp4"] });
  });
  it("reads several jobs and keeps the latest per id", () => {
    const jobs = parseGenerationJobs(`${RUNNING}\njob j2 [queued] m · 3s`, 0);
    expect(jobs.map((job) => job.id)).toEqual(["j1", "j2"]);
    const later = parseGenerationJobs("job j1 [completed] m · 90s", 5);
    expect(latestGenerationJobs([...jobs, ...later]).map((job) => job.state)).toEqual([
      "completed",
      "queued",
    ]);
  });
  it("extracts text from MCP content arrays", () => {
    expect(toolOutputText([{ type: "text", text: "a" }, { type: "image" }])).toBe("a");
    expect(toolOutputText({ content: [{ type: "text", text: "b" }] })).toBe("b");
    expect(toolOutputText(3)).toBeNull();
  });
});

describe("generationStatusView", () => {
  const [job] = parseGenerationJobs(RUNNING, 0);
  it("counts elapsed from the last observation and words the estimate", () => {
    const view = generationStatusView(job!, 30_000);
    expect(view.status).toBe("Generating · IN_PROGRESS · 1 min so far");
    expect(view.eta).toBe("Estimated at about 1 min · most finish within 3 min");
    const [quick] = parseGenerationJobs(
      "job q [running] m · 1s\n  typicalSeconds=20 (p90 40s), elapsed 1s",
      0,
    );
    expect(generationStatusView(quick!, 0).eta).toBe(
      "Estimated at under a min · most finish within under a min",
    );
  });
  it("marks the phase as last known after 60 s", () => {
    expect(generationStatusView(job!, 61_000).status).toContain("Last known: IN_PROGRESS");
  });
  it("shows the slow line between slowAfter and the estimate stall point (typical × 10)", () => {
    // A seeded video timing: typical 120 s, p90 300 s -> slow after 450 s, stall at 1200 s.
    const [video] = parseGenerationJobs(
      "job v [running] veo · 0s\n  typicalSeconds=120 (p90 300s), elapsed 0s",
      0,
    );
    expect(generationStatusView(video!, 440_000).slow).toBe(false);
    expect(generationStatusView(video!, 460_000).slow).toBe(true);
    expect(generationStatusView(video!, 1_210_000).slow).toBe(false);
  });
  it("never calls a job waiting in line slow", () => {
    const [queued] = parseGenerationJobs(
      "job w [queued] veo · 0s\n  typicalSeconds=120 (p90 300s), elapsed 0s",
      0,
    );
    expect(generationStatusView(queued!, 600_000).slow).toBe(false);
  });
});

describe("helpers", () => {
  it("formats durations as 'under a min', 'N min', 'N hr'", () => {
    expect(formatGenerationDuration(30, "round")).toBe("under a min");
    expect(formatGenerationDuration(119, "floor")).toBe("1 min");
    expect(formatGenerationDuration(119, "round")).toBe("2 min");
    expect(formatGenerationDuration(3600, "round")).toBe("1 hr");
    expect(formatGenerationDuration(3900, "round")).toBe("1 hr 5 min");
  });
  it("recognises creative-mcp job tools", () => {
    expect(isGenerationJobTool("mcp__open-herness-creative__jobs_wait")).toBe(true);
    expect(isGenerationJobTool("mcp__other__jobs_wait")).toBe(false);
  });
});

describe("review fixes", () => {
  it("M4: keeps a multi-line phase inside the job and still reads the timing", () => {
    const [job] = parseGenerationJobs(
      [
        "job j1 [running] veo · 10s",
        "  provider says:",
        "IN_QUEUE position 3",
        "  typicalSeconds=70 (p90 150s), elapsed 12s",
        "",
        "job j2 [completed] veo · 80s",
      ].join("\n"),
      0,
    );
    expect(job).toMatchObject({
      detail: "provider says: IN_QUEUE position 3",
      typicalSeconds: 70,
      p90Seconds: 150,
      elapsedSeconds: 12,
    });
  });
  it("M4: tolerates spacing and separator changes", () => {
    const [job] = parseGenerationJobs(
      "job  j1 [Running] veo -> fal:x - 5s\n typicalSeconds = 30 (p90 60 s), elapsed 6s",
      0,
    );
    expect(job).toMatchObject({ state: "running", typicalSeconds: 30, p90Seconds: 60 });
  });
  it("M3: cancel and the new spend tools end or start jobs", () => {
    for (const tool of [
      "jobs_cancel",
      "media_generate_batch",
      "media_finish_draft",
      "media_upscale",
    ])
      expect(isGenerationJobTool(`mcp__open-herness-creative__${tool}`)).toBe(true);
    const items = [
      {
        type: "dynamic_tool",
        toolName: "mcp__open-herness-creative__media_generate",
        status: "completed",
        output: "job j1 [running] veo · 1s",
        completedAt: DateTime.makeUnsafe(1_000),
      },
      {
        type: "dynamic_tool",
        toolName: "mcp__open-herness-creative__jobs_cancel",
        status: "completed",
        output: [{ type: "text", text: "job j1 [cancelled] veo · 9s" }],
        completedAt: DateTime.makeUnsafe(2_000),
      },
    ];
    const latest = latestGenerationJobs(recentGenerationSnapshots(items, 40));
    expect(latest.filter(isPendingGenerationJob)).toEqual([]);
  });
  it("M3: a snapshot nobody re-polled goes stale after max(p90 × 3, 30 min)", () => {
    const [job] = parseGenerationJobs(
      "job j [running] m · 0s\n  typicalSeconds=60 (p90 900s), elapsed 0s",
      0,
    );
    expect(isStaleGenerationSnapshot(job!, 44 * 60_000)).toBe(false);
    expect(isStaleGenerationSnapshot(job!, 46 * 60_000)).toBe(true);
  });
  it("M5: every seeded creative-mcp timing has a reachable slow window", () => {
    for (const [typical, p90] of [
      [70, 150],
      [150, 300],
      [15, 40],
      [150, 360],
      [10, 25],
      [120, 300],
    ] as const) {
      const window = generationSlowWindow(typical, p90);
      expect(window.stallAt!).toBeGreaterThan(window.slowAfter!);
    }
  });
});

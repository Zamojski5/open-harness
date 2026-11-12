import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseGenerationJobs } from "./generationJobs.logic";

// Contract test: the card parses what creative-mcp's describe() really writes, so a wording change
// there fails here instead of the cards silently disappearing. The module is loaded by path at run
// time; the web typecheck does not cover creative-mcp's node-only sources.
interface JobLike {
  readonly [key: string]: unknown;
}
type DescribeJob = (job: JobLike) => string;

const JOBS_MODULE = new URL(
  "../../../../../packages/creative-mcp/src/media/jobs.ts",
  import.meta.url,
).pathname;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

async function loadDescribe(): Promise<DescribeJob> {
  const module = (await import(/* @vite-ignore */ JOBS_MODULE)) as { describe: DescribeJob };
  return module.describe;
}

const job = (fields: JobLike): JobLike => ({
  id: "job-1",
  projectPath: "/work",
  model: "veo-3.1-fast",
  kind: "video",
  title: "shot",
  state: "running",
  fingerprint: "f",
  request: {},
  createdAt: NOW - 50_000,
  startedAt: NOW - 45_000,
  submittedAt: NOW - 40_000,
  ...fields,
});

describe("creative-mcp describe() -> parseGenerationJobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a running job with its phase and timing", async () => {
    const describeJob = await loadDescribe();
    const text = describeJob(
      job({
        detail: "IN_PROGRESS\nstep 2 of 3",
        served: { provider: "fal", model: "veo", endpoint: "fal-ai/veo3.1/fast" },
      }),
    );
    const [parsed] = parseGenerationJobs(text, NOW);
    expect(parsed).toMatchObject({ id: "job-1", state: "running", model: "veo-3.1-fast" });
    expect(parsed!.typicalSeconds).toBeGreaterThan(0);
    expect(parsed!.p90Seconds).toBeGreaterThan(0);
    expect(parsed!.elapsedSeconds).toBe(40);
    expect(parsed!.detail).toContain("IN_PROGRESS");
  });

  it("reads a finished job's outputs and terminal state", async () => {
    const describeJob = await loadDescribe();
    const text = describeJob(
      job({ state: "completed", finishedAt: NOW, outputs: ["/work/takes/a.mp4"] }),
    );
    expect(parseGenerationJobs(text, NOW)[0]).toMatchObject({
      state: "completed",
      outputs: ["/work/takes/a.mp4"],
    });
  });
});

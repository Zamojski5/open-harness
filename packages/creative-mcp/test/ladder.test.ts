// End to end through the job queue with Runware mocked: route choice by price, the draft ladder,
// approvals, caps and the ledger. No real network, no money.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { finishRequest, quoteBatch, submitBatch } from "../src/media/batch.ts";
import { clearCooldowns } from "../src/media/failures.ts";
import * as jobs from "../src/media/jobs.ts";
import { current, readLines } from "../src/media/ledger.ts";
import { loadKeys } from "../src/media/providers.ts";
import { rankRoutes } from "../src/media/route.ts";
import { setChatCap } from "../src/media/spend.ts";
import { appSession, isolate, json } from "./isolate.ts";

const env = isolate();
const SEEDANCE = "bytedance/seedance-2.5/text-to-video";

function mockRunware(opts: { draftId?: string; cost?: number } = {}) {
  env.route("https://api.runware.ai/v1", (_u, init) => {
    const [task] = JSON.parse(String(init!.body));
    if (task.taskType === "videoInference")
      return json({ data: [{ taskType: "videoInference", taskUUID: task.taskUUID }] });
    return json({
      data: [
        {
          taskUUID: task.taskUUID,
          status: "success",
          videoURL: `https://cdn.runware.ai/${task.taskUUID}.mp4`,
          cost: opts.cost ?? 0.5,
          ...(opts.draftId ? { outputs: { draftId: opts.draftId } } : {}),
        },
      ],
    });
  });
  env.route("https://cdn.runware.ai/", () => new Response(new Uint8Array([0, 0, 0, 24])));
}

function setup() {
  clearCooldowns();
  process.env.OH_POLL_MS = "1";
  process.env.OH_THREAD_ID = "thread-test";
  process.env.RUNWARE_API_KEY = "rw-test";
  const project = NodePath.join(env.home, "project");
  NodeFS.mkdirSync(project, { recursive: true });
  return project;
}

describe("price-aware routing", () => {
  it("picks the cheapest keyed route and says why others are skipped", async () => {
    setup();
    process.env.FAL_KEY = "fal-test";
    const { routes } = await rankRoutes(
      { model: SEEDANCE, prompt: "x", parameters: { duration: 5, resolution: "1080p" } },
      loadKeys(),
    );
    expect(routes[0]).toMatchObject({ provider: "runware" });
    expect(routes[0]!.skip).toBeUndefined();
    expect(routes[1]).toMatchObject({ provider: "fal" });
    expect(routes.find((r) => r.provider === "replicate")?.skip).toMatch(/no 1080p/);
  });

  it("no Runware key: the route is skipped and reported, fal runs", async () => {
    setup();
    delete process.env.RUNWARE_API_KEY;
    process.env.FAL_KEY = "fal-test";
    const { routes } = await rankRoutes({ model: SEEDANCE, prompt: "x" }, loadKeys());
    expect(routes[0]!.provider).toBe("fal");
    expect(routes.find((r) => r.provider === "runware")?.skip).toMatch(/no runware key/);
  });

  it("route:'quality' keeps the asked provider first; a provider name pins it", async () => {
    setup();
    process.env.FAL_KEY = "fal-test";
    const quality = await rankRoutes(
      { model: SEEDANCE, prompt: "x", route: "quality" },
      loadKeys(),
    );
    expect(quality.routes[0]!.provider).toBe("fal");
    const pinned = await rankRoutes({ model: SEEDANCE, prompt: "x", route: "runware" }, loadKeys());
    expect(pinned.routes.filter((r) => !r.skip).map((r) => r.provider)).toEqual(["runware"]);
  });
});

describe("never pay twice, never deliver the wrong take", () => {
  const finish = (draftId: string) => ({
    model: "runware:bytedance:seedance@2.5",
    route: "exact",
    parameters: { duration: 5 },
    finishDraft: { draftId, provider: "runware", seconds: 5, ofJob: "j" },
  });

  it("finishing two different drafts are two jobs; the same draft again is reused", () => {
    const p = setup();
    expect(jobs.fingerprintOf(finish("d-1"), p)).not.toBe(jobs.fingerprintOf(finish("d-2"), p));
    expect(jobs.fingerprintOf(finish("d-1"), p)).toBe(jobs.fingerprintOf(finish("d-1"), p));
  });

  it("upscaling two different files are two jobs", () => {
    const p = setup();
    const a = NodePath.join(p, "a.mp4");
    const b = NodePath.join(p, "b.mp4");
    NodeFS.writeFileSync(a, "aaaa");
    NodeFS.writeFileSync(b, "bbbbbb");
    const up = (video: string) => ({ model: "fal-ai/topaz/upscale/video", route: "exact", video });
    expect(jobs.fingerprintOf(up(a), p)).not.toBe(jobs.fingerprintOf(up(b), p));
  });

  it("a provider pin on a model that provider doesn't sell refuses instead of switching", async () => {
    setup();
    process.env.FAL_KEY = "fal-test";
    const { routes } = await rankRoutes(
      { model: "fal-ai/veo3.1/fast", prompt: "x", route: "runware" },
      loadKeys(),
    );
    expect(routes.every((r) => r.skip?.includes("does not sell"))).toBe(true);
  });
});

describe("draft → finish ladder (Runware mocked)", () => {
  it("drafts, records the draft and the charged cost, then finishes the same take", async () => {
    const project = setup();
    mockRunware({ draftId: "draft-77", cost: 0.5125 });
    const draft = await submitBatch(
      [
        {
          request: { model: SEEDANCE, prompt: "a boat", parameters: { duration: 5, draft: true } },
          kind: "video",
          title: "boat",
        },
      ],
      { projectPath: project },
    );
    expect(draft.status).toBe("submitted");
    if (draft.status !== "submitted") return;
    const [done] = await jobs.wait([draft.jobs[0]!.job.id], "all", 10_000);
    expect(done!.state).toBe("completed");
    expect(done!.served?.provider).toBe("runware");
    expect(done!.draft).toMatchObject({ id: "draft-77", provider: "runware", seconds: 5 });
    expect(done!.chargeUsd).toBe(0.5125);
    expect(current().get(done!.id)).toMatchObject({
      state: "spent",
      chargeUsd: 0.5125,
      chargeSource: "provider",
    });
    // the slot reservation was handed over to the job
    expect([...current().values()].filter((l) => l.state === "reserved")).toHaveLength(0);
    const sent = JSON.parse(String(env.calls[0]!.init!.body))[0];
    expect(sent).toMatchObject({ resolution: "480p", settings: { draft: true } });

    const finish = finishRequest(done!.id);
    expect("request" in finish).toBe(true);
    if (!("request" in finish)) return;
    // Finish at Runware's published 1080p token rate: 5 s × $0.6085.
    const quote = await quoteBatch([{ request: finish.request, kind: "video" }]);
    expect(quote.usd).toBe(3.043);
    const finished = await submitBatch([{ request: finish.request, kind: "video" }], {
      projectPath: project,
    });
    expect(finished.status).toBe("submitted");
    if (finished.status !== "submitted") return;
    await jobs.wait([finished.jobs[0]!.job.id], "all", 10_000);
    const sentFinish = env.calls
      .map((c) => (c.init?.body ? JSON.parse(String(c.init.body))[0] : undefined))
      .find((t) => t?.inputs?.draftId);
    expect(sentFinish).toMatchObject({ resolution: "1080p", inputs: { draftId: "draft-77" } });
    expect(sentFinish.positivePrompt).toBeUndefined();
  });

  it("refuses to finish a job that is not a draft", () => {
    expect(finishRequest("nope")).toMatchObject({ error: expect.stringMatching(/Unknown job/) });
  });
});

describe("approvals and caps before anything is sent", () => {
  it("above the ask-before limit nothing is sent until approved", async () => {
    const project = setup();
    mockRunware();
    const r = await submitBatch(
      [
        {
          request: {
            model: SEEDANCE,
            prompt: "x",
            parameters: { duration: 10, resolution: "1080p" },
          },
          kind: "video",
          count: 2,
        },
      ],
      { projectPath: project },
    );
    expect(r.status).toBe("approval_required");
    if (r.status !== "approval_required") return;
    expect(r.quote.usd).toBe(12.27);
    expect(r.card.questions[0]!.options[0]!.label).toBe("Approve $12.27");
    expect(env.calls).toHaveLength(0);
    expect(readLines()).toHaveLength(0);
  });

  it("a $0 chat cap refuses paid work with nothing submitted", async () => {
    const project = setup();
    mockRunware();
    setChatCap({ localOnly: true });
    const r = await submitBatch(
      [
        {
          request: { model: SEEDANCE, prompt: "x", parameters: { duration: 4, draft: true } },
          kind: "video",
        },
      ],
      { projectPath: project },
    );
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.message).toMatch(/Nothing was submitted/);
    expect(env.calls).toHaveLength(0);
  });

  it("a batch that does not fit the daily cap is refused whole, with how many fit", async () => {
    const project = setup();
    mockRunware();
    process.env.OH_SPEND_CAP_USD = "1.5";
    const r = await submitBatch(
      [
        {
          request: { model: SEEDANCE, prompt: "x", parameters: { duration: 5, draft: true } },
          kind: "video",
          count: 3,
        },
      ],
      { projectPath: project },
    );
    expect(r.status).toBe("refused");
    if (r.status === "refused") expect(r.hint).toMatch(/shrink the batch to 2 take/);
    expect(env.calls).toHaveLength(0);
  });
});

describe("review fixes end to end (Runware mocked)", () => {
  const big = { model: SEEDANCE, prompt: "x", parameters: { duration: 10, resolution: "1080p" } };

  it("M4: the approval names the dearest fallback and dies when the route or price changes", async () => {
    const project = setup();
    process.env.FAL_KEY = "fal-test";
    appSession();
    const r = await submitBatch([{ request: big, kind: "video" }], { projectPath: project });
    expect(r.status).toBe("approval_required");
    if (r.status !== "approval_required") return;
    // runs on Runware ($6.14) but may fall back to fal ($11.64): both shown, the dearer bounds it
    expect(r.quote).toMatchObject({ usd: 6.135, usdMax: 11.64 });
    expect(r.approval.question).toContain("up to $11.64");
    // the Runware key goes away before the resend: different route and price, approval refused
    delete process.env.RUNWARE_API_KEY;
    const resend = await submitBatch([{ request: big, kind: "video" }], {
      projectPath: project,
      approvalId: r.approval.id,
    });
    expect(resend).toMatchObject({
      status: "invalid",
      message: expect.stringMatching(/different batch, route or price/),
    });
    expect(env.calls).toHaveLength(0);
  });

  it("M4: at run time a fallback dearer than the quoted price is not tried", async () => {
    const project = setup();
    process.env.FAL_KEY = "fal-test";
    env.route("https://api.runware.ai/v1", () =>
      json({ errors: [{ code: "insufficientCredits", message: "Insufficient credits" }] }, 402),
    );
    const { job } = jobs.submit(big, { projectPath: project, kind: "video", priceCeiling: 7 });
    const [done] = await jobs.wait([job.id], "all", 10_000);
    expect(done!.state).toBe("failed");
    expect(done!.attempts?.some((a) => /dearer than the quoted price/.test(a.message ?? ""))).toBe(
      true,
    );
    expect(env.calls.some((c) => c.url.includes("fal.run"))).toBe(false);
    expect(current().get(job.id)?.state).toBe("released");
  });

  it("H4: a retry goes through the same quote and approval path", async () => {
    const project = setup();
    env.route("https://api.runware.ai/v1", () =>
      json({ errors: [{ code: "insufficientCredits", message: "Insufficient credits" }] }, 402),
    );
    const { job } = jobs.submit(big, { projectPath: project, kind: "video" });
    await jobs.wait([job.id], "all", 10_000);
    // Runware is now on a billing cooldown; the user adds a fal key, so the retry runs on fal.
    process.env.FAL_KEY = "fal-test";
    const plan = jobs.retry(job.id, { projectPath: project, planOnly: true });
    expect(plan).toMatchObject({ ok: true, action: "plan" });
    if (!plan.ok || plan.action !== "plan") return;
    const r = await submitBatch(
      [
        {
          request: plan.plan.request,
          kind: plan.plan.kind,
          requestId: plan.plan.requestId,
          retryOf: plan.plan.retryOf,
        },
      ],
      { projectPath: project },
    );
    expect(r.status).toBe("approval_required");
  });

  it("H4: many small calls in one chat still reach the ask-before limit", async () => {
    const project = setup();
    appSession();
    mockRunware({ cost: 1.152 });
    const small = { model: SEEDANCE, prompt: "x", parameters: { duration: 5, resolution: "720p" } };
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await submitBatch([{ request: { ...small, prompt: `x${i}` }, kind: "video" }], {
        projectPath: project,
      });
      statuses.push(r.status);
      if (r.status === "submitted")
        await jobs.wait(
          r.jobs.map((j) => j.job.id),
          "all",
          10_000,
        );
      if (r.status === "approval_required") break;
    }
    // $1.15 each: the 5th would bring the chat to $5.76 > $5
    expect(statuses).toEqual([
      "submitted",
      "submitted",
      "submitted",
      "submitted",
      "approval_required",
    ]);
  });
});

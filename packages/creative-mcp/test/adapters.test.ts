import { describe, expect, it } from "vite-plus/test";
import { MediaError } from "../src/media/failures.ts";
import { loadKeys, type GenerateRequest, type ProviderContext } from "../src/media/providers.ts";
import {
  prepareReplicate,
  replicatePoll,
  replicateSubmit,
  REPLICATE_API,
} from "../src/media/replicate.ts";
import { prepareRunware, RUNWARE_API, runwarePoll, runwareSubmit } from "../src/media/runware.ts";
import { isolate, json } from "./isolate.ts";

const env = isolate();
const dataUri = (r: string) => `data:image/png;base64,${Buffer.from(r).toString("base64")}`;
const ctx = (
  over: Partial<ProviderContext["keys"]> = {},
): ProviderContext & {
  handles: unknown[];
} => {
  const handles: unknown[] = [];
  return {
    keys: { ...loadKeys(), ...over },
    signal: new AbortController().signal,
    onStatus: () => {},
    onHandle: (h) => handles.push(h),
    handles,
  };
};
const RW = "runware:bytedance:seedance@2.5";
const bodyOf = (i: number) => JSON.parse(String(env.calls[i]!.init!.body));

describe("Runware adapter", () => {
  it("maps a generic request onto a videoInference task", () => {
    const req: GenerateRequest = {
      model: RW,
      prompt: "a lighthouse at dusk",
      parameters: { duration: 12.4, resolution: "720p", aspect_ratio: "9:16", audio: false },
    };
    const p = prepareRunware(req, RW, dataUri);
    expect(p.native).toMatchObject({
      taskType: "videoInference",
      model: "bytedance:seedance@2.5",
      deliveryMethod: "async",
      includeCost: true,
      positivePrompt: "a lighthouse at dusk",
      duration: 12,
      width: 720,
      height: 1280,
      settings: { audio: false },
    });
    expect(p.native.resolution).toBeUndefined();
    expect(p.adjustments.join()).toMatch(/12.4 → 12/);
  });

  it("drafts at 480p and finishes with only the draft id at 1080p", () => {
    const draft = prepareRunware(
      { model: RW, prompt: "x", parameters: { draft: true, resolution: "1080p" } },
      RW,
      dataUri,
    );
    expect(draft.native).toMatchObject({ resolution: "480p", settings: { draft: true } });
    const finish = prepareRunware(
      {
        model: RW,
        prompt: "ignored",
        finishDraft: { draftId: "d-1", provider: "runware", seconds: 5, ofJob: "j" },
      },
      RW,
      dataUri,
    );
    expect(finish.native).toMatchObject({ resolution: "1080p", inputs: { draftId: "d-1" } });
    expect(finish.native.positivePrompt).toBeUndefined();
    expect(finish.native.duration).toBeUndefined();
  });

  it("start/end frames vs reference images", () => {
    const frames = prepareRunware(
      { model: RW, prompt: "x", references: ["https://a/1.png"], endImage: "https://a/2.png" },
      RW,
      dataUri,
    ).native;
    expect(frames.inputs).toEqual({
      frameImages: [
        { image: "https://a/1.png", frame: "first" },
        { image: "https://a/2.png", frame: "last" },
      ],
    });
    const refs = prepareRunware(
      { model: RW, prompt: "x", references: ["https://a/1.png", "/local/2.png"] },
      RW,
      dataUri,
    ).native;
    expect((refs.inputs as { referenceImages: string[] }).referenceImages[1]).toMatch(/^data:/);
  });

  it("submits, polls, and returns the draft id and the charged cost", async () => {
    env.route(RUNWARE_API, (_u, init) => {
      const [task] = JSON.parse(String(init!.body));
      if (task.taskType === "videoInference")
        return json({ data: [{ taskType: "videoInference", taskUUID: task.taskUUID }] });
      const n = env.calls.length;
      return json({
        data: [
          n < 3
            ? { taskUUID: task.taskUUID, status: "processing", progress: 40 }
            : {
                taskUUID: task.taskUUID,
                status: "success",
                videoURL: "https://cdn.runware.ai/v.mp4",
                cost: 0.5125,
                seed: 99,
                outputs: { draftId: "draft-abc" },
              },
        ],
      });
    });
    const c = ctx({ runwareApiKey: "rw-test-key" });
    const p = prepareRunware({ model: RW, prompt: "x", parameters: { draft: true } }, RW, dataUri);
    const h = await runwareSubmit(p, c);
    expect(c.handles).toHaveLength(1);
    expect(env.calls[0]!.init!.headers).toMatchObject({ Authorization: "Bearer rw-test-key" });
    const out = await runwarePoll(h, c, 1);
    expect(out).toEqual([
      {
        url: "https://cdn.runware.ai/v.mp4",
        ext: ".mp4",
        draftId: "draft-abc",
        costUsd: 0.5125,
        seed: 99,
      },
    ]);
    expect(bodyOf(1)).toEqual([{ taskType: "getResponse", taskUUID: h.taskUUID }]);
  });

  it("no key = refused locally, nothing sent", async () => {
    const p = prepareRunware({ model: RW, prompt: "x" }, RW, dataUri);
    await expect(runwareSubmit(p, ctx())).rejects.toMatchObject({
      failure: { category: "auth", accepted: false },
    });
    expect(env.calls).toHaveLength(0);
  });

  it("a 402 before acceptance is billing and not accepted", async () => {
    env.route(RUNWARE_API, () =>
      json({ errors: [{ code: "insufficientCredits", message: "Insufficient credits" }] }, 402),
    );
    const p = prepareRunware({ model: RW, prompt: "x" }, RW, dataUri);
    const err = (await runwareSubmit(p, ctx({ runwareApiKey: "k" })).catch((e) => e)) as MediaError;
    expect(err.failure).toMatchObject({ category: "billing", accepted: false });
  });

  it("a task error after acceptance is reported as accepted", async () => {
    env.route(RUNWARE_API, (_u, init) => {
      const [task] = JSON.parse(String(init!.body));
      return json({
        data: [],
        errors: [
          {
            taskUUID: task.taskUUID,
            code: "contentModeration",
            message: "content flagged by safety filter",
          },
        ],
      });
    });
    const c = ctx({ runwareApiKey: "k" });
    const err = (await runwarePoll({ provider: "runware", taskUUID: "t-1", model: RW }, c, 1).catch(
      (e) => e,
    )) as MediaError;
    expect(err.failure).toMatchObject({ category: "moderation", accepted: true });
  });
});

describe("Replicate adapter", () => {
  const RP = "replicate:bytedance/seedance-2.5";

  it("maps fields and refuses what it cannot do", () => {
    const p = prepareReplicate(
      {
        model: RP,
        prompt: "x",
        references: ["https://a/1.png"],
        parameters: { duration: 6, seed: 3 },
      },
      RP,
      dataUri,
    );
    expect(p.native).toEqual({
      prompt: "x",
      duration: 6,
      resolution: "720p",
      seed: 3,
      image: "https://a/1.png",
      aspect_ratio: "adaptive",
    });
    expect(() =>
      prepareReplicate({ model: RP, parameters: { resolution: "1080p" } }, RP, dataUri),
    ).toThrow(/480p and 720p/);
    expect(() => prepareReplicate({ model: RP, parameters: { draft: true } }, RP, dataUri)).toThrow(
      /draft/,
    );
  });

  it("creates a prediction and polls until it succeeds", async () => {
    env.route(`${REPLICATE_API}/models/bytedance/seedance-2.5/predictions`, () =>
      json({
        id: "p1",
        status: "starting",
        urls: {
          get: "https://api.replicate.com/v1/predictions/p1",
          cancel: "https://api.replicate.com/v1/predictions/p1/cancel",
        },
      }),
    );
    let polls = 0;
    env.route("/predictions/p1", () =>
      json(
        ++polls < 2
          ? { id: "p1", status: "processing" }
          : { id: "p1", status: "succeeded", output: "https://replicate.delivery/out.mp4" },
      ),
    );
    const c = ctx({ replicateApiKey: "r8_test" });
    const h = await replicateSubmit(prepareReplicate({ model: RP, prompt: "x" }, RP, dataUri), c);
    expect(bodyOf(0)).toEqual({ input: { prompt: "x", resolution: "720p" } });
    expect(await replicatePoll(h, c, 1)).toEqual([
      { url: "https://replicate.delivery/out.mp4", ext: ".mp4" },
    ]);
  });

  it("a failed prediction is classified", async () => {
    env.route("/predictions/p2", () =>
      json({ id: "p2", status: "failed", error: "The input was flagged as sensitive (nsfw)" }),
    );
    const c = ctx({ replicateApiKey: "r8" });
    const err = (await replicatePoll(
      { provider: "replicate", id: "p2", getUrl: "https://api.replicate.com/v1/predictions/p2" },
      c,
      1,
    ).catch((e) => e)) as MediaError;
    expect(err.failure?.category).toBe("moderation");
  });
});

describe("L3: the Replicate token never leaves api.replicate.com", () => {
  it("ignores foreign get/cancel URLs from a response", async () => {
    env.route(`${REPLICATE_API}/models/bytedance/seedance-2.5/predictions`, () =>
      json({
        id: "p9",
        status: "starting",
        urls: { get: "https://evil.example/steal", cancel: "http://api.replicate.com/x" },
      }),
    );
    const RP = "replicate:bytedance/seedance-2.5";
    const h = await replicateSubmit(
      prepareReplicate({ model: RP, prompt: "x" }, RP, dataUri),
      ctx({ replicateApiKey: "r8" }),
    );
    expect(h.getUrl).toBe("https://api.replicate.com/v1/predictions/p9");
    expect(h.cancelUrl).toBeUndefined();
  });
});

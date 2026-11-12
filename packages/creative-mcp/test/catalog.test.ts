import { describe, expect, it } from "vite-plus/test";
import { cannotCarry, groupOf, quoteRoute, routeOf, SEEDANCE_25 } from "../src/media/catalog.ts";
import type { GenerateRequest } from "../src/media/providers.ts";

const route = (p: string) => SEEDANCE_25.routes.find((r) => r.provider === p)!;
const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: "bytedance/seedance-2.5/text-to-video",
  prompt: "a boat",
  ...over,
});

describe("Seedance 2.5 price catalog", () => {
  it("knows every route id of the group", () => {
    expect(groupOf("bytedance/seedance-2.5/reference-to-video")?.id).toBe("seedance-2.5");
    expect(routeOf("runware:bytedance:seedance@2.5")?.provider).toBe("runware");
    expect(routeOf("replicate:bytedance/seedance-2.5")?.provider).toBe("replicate");
    expect(groupOf("fal-ai/veo3.1")).toBeUndefined();
  });

  it("matches the providers' published per-second prices", () => {
    const p = { parameters: { duration: 5, resolution: "720p" } };
    expect(quoteRoute(route("fal"), SEEDANCE_25, req(p)).usd).toBe(2.365);
    // Runware's page: 720p, 5 s text-to-video ≈ $1.17 (0.2304 × 5 = 1.152).
    expect(quoteRoute(route("runware"), SEEDANCE_25, req(p)).usd).toBe(1.152);
    expect(quoteRoute(route("replicate"), SEEDANCE_25, req(p)).usd).toBe(1.156);
    const tenAt1080 = req({ parameters: { duration: 10, resolution: "1080p" } });
    expect(quoteRoute(route("fal"), SEEDANCE_25, tenAt1080).usd).toBe(11.64);
    expect(quoteRoute(route("runware"), SEEDANCE_25, tenAt1080).usd).toBe(6.135);
  });

  it("prices drafts at the 480p rate and multiplies by takes", () => {
    const q = quoteRoute(
      route("runware"),
      SEEDANCE_25,
      req({ parameters: { duration: 10, resolution: "1080p", draft: true } }),
      4,
    );
    expect(q.usd).toBe(4.1);
    expect(q.rate).toMatch(/480p \(draft\)/);
  });

  it("finishing a draft: fal's published rate; Runware at its published 1080p token rate", () => {
    const finish = (provider: string, extra = {}) =>
      req({ finishDraft: { draftId: "d1", provider, seconds: 10, ofJob: "j1", ...extra } });
    expect(quoteRoute(route("fal"), SEEDANCE_25, finish("fal")).usd).toBe(11.64);
    // $12.52 per 1M tokens × 48,600 tokens per 1080p 16:9 second ≈ $0.6085/s
    expect(quoteRoute(route("runware"), SEEDANCE_25, finish("runware")).usd).toBe(6.085);
    // A draft made on fal cannot be finished on Runware.
    expect(quoteRoute(route("runware"), SEEDANCE_25, finish("fal")).cannotCarry).toMatch(
      /made on fal/,
    );
  });

  it("L1: a draft made from a clip bills the clip's seconds when finished (fal ×0.6)", () => {
    const clip = req({
      finishDraft: {
        draftId: "d1",
        provider: "fal",
        seconds: 10,
        ofJob: "j",
        videoInput: true,
        inputSeconds: 5,
      },
    });
    // 1.164 × 0.6 × (5 + 10)
    expect(quoteRoute(route("fal"), SEEDANCE_25, clip).usd).toBe(10.476);
    const unknownClip = req({
      finishDraft: { draftId: "d1", provider: "fal", seconds: 10, ofJob: "j", videoInput: true },
    });
    const q = quoteRoute(route("fal"), SEEDANCE_25, unknownClip);
    expect(q.usd).toBeNull();
    expect(q.usdMax).toBeGreaterThan(10.476);
  });

  it("the full ladder costs well under straight finals (4 drafts + 1 finish)", () => {
    const r = route("runware");
    const straight = quoteRoute(
      r,
      SEEDANCE_25,
      req({ parameters: { duration: 10, resolution: "1080p" } }),
      4,
    ).usd!;
    const drafts = quoteRoute(
      r,
      SEEDANCE_25,
      req({ parameters: { duration: 10, draft: true } }),
      4,
    ).usd!;
    const finish = quoteRoute(
      r,
      SEEDANCE_25,
      req({ parameters: { duration: 10, resolution: "1080p" } }),
    ).usd!;
    expect((drafts + finish) / straight).toBeLessThan(0.45);
  });

  it("auto length is unknown, quoted up to the longest clip", () => {
    const q = quoteRoute(route("fal"), SEEDANCE_25, req({ input: { duration: "auto" } }));
    expect(q.usd).toBeNull();
    expect(q.usdMax).toBe(14.19);
  });

  it("fal bills the input video: ×0.6 over input + output seconds", () => {
    const v = req({ video: "https://x/clip.mp4", parameters: { duration: 5, resolution: "720p" } });
    const known = quoteRoute(route("fal"), SEEDANCE_25, v, 1, { inputVideoSeconds: 5 });
    expect(known.usd).toBe(2.838);
    const unknown = quoteRoute(route("fal"), SEEDANCE_25, v);
    expect(unknown.usd).toBeNull();
    expect(unknown.usdMax).toBeGreaterThan(known.usd!);
    expect(quoteRoute(route("replicate"), SEEDANCE_25, v).usd).toBe(4.838);
  });

  it("names what a route cannot carry instead of dropping it", () => {
    expect(cannotCarry(route("replicate"), req({ parameters: { resolution: "1080p" } }))).toMatch(
      /no 1080p/,
    );
    expect(cannotCarry(route("replicate"), req({ parameters: { draft: true } }))).toMatch(
      /no draft/,
    );
    expect(cannotCarry(route("runware"), req({ parameters: { seed: 7 } }))).toMatch(/seed/);
    expect(cannotCarry(route("runware"), req({ video: "/tmp/a.mp4" }))).toMatch(/local source/);
    expect(cannotCarry(route("runware"), req({ input: { task: "editing" } }))).toMatch(
      /native fal fields/,
    );
    expect(cannotCarry(route("fal"), req({ parameters: { seed: 7 } }))).toBeUndefined();
  });
});

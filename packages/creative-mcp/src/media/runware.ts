// Runware (wholesale route for Seedance 2.5): one JSON endpoint taking task arrays, async delivery,
// polled with getResponse. Built from the public schema (checked 2026-11-05):
// https://runware.ai/docs/models/bytedance-seedance-2-5/schema.json and
// https://runware.ai/docs/models-api/task-polling.md. Without a key the route is skipped.

import * as NodeCrypto from "node:crypto";
import { classifyReported, failureError, makeFailure } from "./failures.ts";
import { call, pollWithRetry, sleep } from "./http.ts";
import type {
  GenerateRequest,
  Prepared,
  ProviderContext,
  ProviderHandle,
  ProviderOutput,
} from "./providers.ts";

export const RUNWARE_API = "https://api.runware.ai/v1";
const AIR: Record<string, string> = { "runware:bytedance:seedance@2.5": "bytedance:seedance@2.5" };

// Output sizes Runware accepts per resolution, by aspect ratio.
const SIZES: Record<string, Record<string, [number, number]>> = {
  "480p": {
    "16:9": [854, 480],
    "4:3": [752, 560],
    "1:1": [640, 640],
    "3:4": [560, 752],
    "9:16": [480, 854],
    "21:9": [992, 432],
  },
  "720p": {
    "16:9": [1280, 720],
    "4:3": [1112, 834],
    "1:1": [960, 960],
    "3:4": [834, 1112],
    "9:16": [720, 1280],
    "21:9": [1470, 630],
  },
  "1080p": {
    "16:9": [1920, 1080],
    "4:3": [1664, 1248],
    "1:1": [1440, 1440],
    "3:4": [1248, 1664],
    "9:16": [1080, 1920],
    "21:9": [2206, 946],
  },
};

const toUri = (ref: string, toDataUri: (r: string) => string) =>
  /^(https?:|data:)/.test(ref) ? ref : toDataUri(ref);

/** Generic request → one Runware videoInference task. */
export function prepareRunware(
  req: GenerateRequest,
  model: string,
  toDataUri: (ref: string) => string,
): Prepared {
  const air = AIR[model];
  if (!air)
    throw failureError(
      makeFailure("model_unavailable", "runware", { message: `No Runware mapping for ${model}.` }),
    );
  const adjustments: string[] = [];
  const p = req.parameters ?? {};
  const task: Record<string, unknown> = {
    taskType: "videoInference",
    taskUUID: NodeCrypto.randomUUID(),
    model: air,
    deliveryMethod: "async",
    includeCost: true,
    outputType: "URL",
    outputFormat: "MP4",
    numberResults: Math.min(4, Math.max(1, p.num_outputs ?? 1)),
  };
  if (req.finishDraft) {
    // Finishing reuses the draft's prompt and media; Runware takes only the id and 1080p.
    task.inputs = { draftId: req.finishDraft.draftId };
    task.resolution = "1080p";
    return {
      provider: "runware",
      model,
      endpoint: air,
      kind: "video",
      native: task,
      adjustments: ["finishing the draft at 1080p"],
    };
  }
  if (req.prompt) task.positivePrompt = req.prompt;
  let resolution = String(p.resolution ?? "720p").toLowerCase();
  if (p.draft) {
    if (resolution !== "480p") adjustments.push(`resolution ${resolution} → 480p (draft)`);
    resolution = "480p";
    task.settings = { draft: true };
  } else if (!SIZES[resolution]) {
    adjustments.push(`resolution ${resolution} → 720p`);
    resolution = "720p";
  }
  if (p.duration !== undefined) {
    const d = Math.round(Math.min(30, Math.max(4, p.duration)));
    if (d !== p.duration) adjustments.push(`duration ${p.duration} → ${d} s`);
    task.duration = d;
  }
  if (p.audio !== undefined)
    task.settings = { ...(task.settings as object | undefined), audio: p.audio };
  const inputs: Record<string, unknown> = {};
  const refs = (req.references ?? []).map((r) => toUri(r, toDataUri));
  if (req.endImage)
    inputs.frameImages = [
      ...(refs[0] ? [{ image: refs[0], frame: "first" }] : []),
      { image: toUri(req.endImage, toDataUri), frame: "last" },
    ];
  else if (refs.length === 1) inputs.frameImages = [{ image: refs[0], frame: "first" }];
  else if (refs.length > 1) inputs.referenceImages = refs;
  if (req.video) inputs.video = req.video;
  if (Object.keys(inputs).length) task.inputs = inputs;
  // Frame images and source videos set the output shape; otherwise an aspect ratio picks a size.
  const aspect = p.aspect_ratio;
  const size = aspect ? SIZES[resolution]?.[aspect] : undefined;
  if (aspect && !inputs.frameImages && !inputs.video) {
    if (size) {
      task.width = size[0];
      task.height = size[1];
    } else {
      adjustments.push(`aspect ${aspect} not offered; 16:9 used`);
      task.resolution = resolution;
    }
  } else {
    if (aspect) adjustments.push(`aspect ${aspect} ignored (the input image or video sets it)`);
    task.resolution = resolution;
  }
  Object.assign(task, req.input ?? {});
  return { provider: "runware", model, endpoint: air, kind: "video", native: task, adjustments };
}

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

/** errors[] inside a 200 answer (Runware also uses it for per-task failures). */
function reportedError(body: Record<string, any>, taskUUID: string, accepted: boolean) {
  const err = (body.errors as Record<string, any>[] | undefined)?.find(
    (e) => !e.taskUUID || e.taskUUID === taskUUID,
  );
  if (!err) return undefined;
  const f = classifyReported("runware", `${err.code ?? ""} ${err.message ?? ""}`, accepted);
  if (!accepted && f.category === "ambiguous") f.category = "invalid_input";
  return failureError(f);
}

export async function runwareSubmit(
  p: Prepared,
  ctx: ProviderContext,
): Promise<ProviderHandle & { provider: "runware" }> {
  const key = ctx.keys.runwareApiKey;
  if (!key)
    throw failureError(
      makeFailure("auth", "runware", { message: "No Runware key configured (media_set_key)." }),
    );
  ctx.onStatus("queued", p.endpoint);
  const taskUUID = String(p.native.taskUUID);
  const body = await call(
    "runware",
    RUNWARE_API,
    {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify([p.native]),
      signal: ctx.signal,
    },
    "submit",
    false,
  );
  const refused = reportedError(body, taskUUID, false);
  if (refused) throw refused;
  const handle = { provider: "runware" as const, taskUUID, model: p.model };
  ctx.onHandle?.(handle);
  return handle;
}

export async function runwarePoll(
  h: ProviderHandle & { provider: "runware" },
  ctx: ProviderContext,
  intervalMs = Number(process.env.OH_POLL_MS) || 3000,
): Promise<ProviderOutput[]> {
  const key = ctx.keys.runwareApiKey;
  for (;;) {
    await sleep(intervalMs, ctx.signal);
    const body = await pollWithRetry(
      () =>
        call(
          "runware",
          RUNWARE_API,
          {
            method: "POST",
            headers: headers(key),
            body: JSON.stringify([{ taskType: "getResponse", taskUUID: h.taskUUID }]),
            signal: ctx.signal,
          },
          "poll",
          true,
        ),
      ctx.signal,
    );
    const failed = reportedError(body, h.taskUUID, true);
    if (failed) throw failed;
    const items = ((body.data as Record<string, any>[] | undefined) ?? []).filter(
      (d) => d.taskUUID === h.taskUUID,
    );
    if (items.some((d) => d.status === "error"))
      throw failureError(classifyReported("runware", JSON.stringify(items).slice(0, 600)));
    if (!items.length || items.some((d) => d.status === "processing")) {
      const progress = items.find((d) => typeof d.progress === "number")?.progress;
      ctx.onStatus("running", progress !== undefined ? `${progress}%` : undefined);
      continue;
    }
    const outputs: ProviderOutput[] = items
      .filter((d) => typeof d.videoURL === "string")
      .map((d) => ({
        url: d.videoURL as string,
        ext: ".mp4",
        ...(typeof d.outputs?.draftId === "string" ? { draftId: d.outputs.draftId } : {}),
        ...(typeof d.cost === "number" ? { costUsd: d.cost } : {}),
        ...(typeof d.seed === "number" ? { seed: d.seed } : {}),
      }));
    if (!outputs.length)
      throw failureError(
        classifyReported("runware", `no video in result: ${JSON.stringify(items).slice(0, 400)}`),
      );
    return outputs;
  }
}

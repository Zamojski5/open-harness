// Replicate (480p/720p route for Seedance 2.5): create a prediction on the official model, poll its
// get URL, cancel on abort. Fields from https://replicate.com/bytedance/seedance-2.5/api/schema
// (checked 2026-11-05). Without a token the route is skipped.

import { classifyReported, failureError, makeFailure, MediaError } from "./failures.ts";
import { call, pollWithRetry, sleep } from "./http.ts";
import type {
  GenerateRequest,
  Prepared,
  ProviderContext,
  ProviderHandle,
  ProviderOutput,
} from "./providers.ts";

export const REPLICATE_API = "https://api.replicate.com/v1";
const ASPECTS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);

const toUri = (ref: string, toDataUri: (r: string) => string) =>
  /^(https?:|data:)/.test(ref) ? ref : toDataUri(ref);

export function prepareReplicate(
  req: GenerateRequest,
  model: string,
  toDataUri: (ref: string) => string,
): Prepared {
  const endpoint = model.replace(/^replicate:/, "");
  if (req.finishDraft || req.parameters?.draft)
    throw failureError(
      makeFailure("invalid_input", "local", {
        message: "incompatible: Replicate has no Seedance draft mode",
      }),
    );
  const p = req.parameters ?? {};
  const adjustments: string[] = [];
  const input: Record<string, unknown> = {};
  if (req.prompt) input.prompt = req.prompt;
  if (p.duration !== undefined) {
    const d = Math.round(Math.min(30, Math.max(4, p.duration)));
    if (d !== p.duration) adjustments.push(`duration ${p.duration} → ${d} s`);
    input.duration = d;
  }
  const res = String(p.resolution ?? "720p").toLowerCase();
  if (res !== "480p" && res !== "720p")
    throw failureError(
      makeFailure("invalid_input", "local", {
        message: `incompatible: Replicate offers 480p and 720p, not ${res}`,
      }),
    );
  input.resolution = res;
  if (p.audio !== undefined) input.generate_audio = p.audio;
  if (p.seed !== undefined) input.seed = p.seed;
  const refs = (req.references ?? []).map((r) => toUri(r, toDataUri));
  const frames = !!req.endImage || refs.length === 1;
  if (frames) {
    if (refs[0]) input.image = refs[0];
    if (req.endImage) input.last_frame_image = toUri(req.endImage, toDataUri);
  } else if (refs.length > 1) input.reference_images = refs;
  if (req.video) input.reference_videos = [req.video];
  if (p.aspect_ratio) {
    if (frames || req.video) {
      if (p.aspect_ratio !== "adaptive")
        adjustments.push(`aspect ${p.aspect_ratio} → adaptive (frame and video modes)`);
      input.aspect_ratio = "adaptive";
    } else if (ASPECTS.has(p.aspect_ratio)) input.aspect_ratio = p.aspect_ratio;
    else adjustments.push(`aspect ${p.aspect_ratio} not offered; 16:9 used`);
  } else if (frames || req.video) input.aspect_ratio = "adaptive";
  Object.assign(input, req.input ?? {});
  return { provider: "replicate", model, endpoint, kind: "video", native: input, adjustments };
}

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
});

/** The token goes only to Replicate's own API, whatever URL a response hands back. */
export function replicateUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "api.replicate.com" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export async function replicateSubmit(
  p: Prepared,
  ctx: ProviderContext,
): Promise<ProviderHandle & { provider: "replicate" }> {
  const key = ctx.keys.replicateApiKey;
  if (!key)
    throw failureError(
      makeFailure("auth", "replicate", {
        message: "No Replicate token configured (media_set_key).",
      }),
    );
  ctx.onStatus("queued", p.endpoint);
  const body = await call(
    "replicate",
    `${REPLICATE_API}/models/${p.endpoint}/predictions`,
    {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify({ input: p.native }),
      signal: ctx.signal,
    },
    "submit",
    false,
  );
  const id = body.id as string | undefined;
  const getUrl =
    replicateUrl(body.urls?.get as string | undefined) ??
    (id ? `${REPLICATE_API}/predictions/${encodeURIComponent(id)}` : undefined);
  if (!id || !getUrl)
    throw failureError(
      makeFailure("ambiguous", "replicate", {
        accepted: true,
        detail: JSON.stringify(body).slice(0, 300),
      }),
    );
  const handle = {
    provider: "replicate" as const,
    id,
    getUrl,
    ...(replicateUrl(body.urls?.cancel as string | undefined)
      ? { cancelUrl: replicateUrl(body.urls.cancel as string)! }
      : {}),
  };
  ctx.onHandle?.(handle);
  return handle;
}

export async function replicatePoll(
  h: ProviderHandle & { provider: "replicate" },
  ctx: ProviderContext,
  intervalMs = Number(process.env.OH_POLL_MS) || 3000,
): Promise<ProviderOutput[]> {
  const key = ctx.keys.replicateApiKey;
  const onAbort = () =>
    h.cancelUrl &&
    void fetch(h.cancelUrl, { method: "POST", headers: headers(key) }).catch(() => {});
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  for (;;) {
    await sleep(intervalMs, ctx.signal);
    const body = await pollWithRetry(
      () =>
        call("replicate", h.getUrl, { headers: headers(key), signal: ctx.signal }, "poll", true),
      ctx.signal,
    );
    const status = body.status as string;
    if (status === "starting") ctx.onStatus("queued");
    else if (status === "processing") ctx.onStatus("running");
    else if (status === "failed")
      throw failureError(classifyReported("replicate", String(body.error ?? "failed")));
    else if (status === "canceled") throw new MediaError("Cancelled at Replicate", "cancelled");
    else if (status === "succeeded") {
      const urls = (Array.isArray(body.output) ? body.output : [body.output]).filter(
        (u): u is string => typeof u === "string" && /^https?:/.test(u),
      );
      if (!urls.length)
        throw failureError(
          classifyReported(
            "replicate",
            `no files in result: ${JSON.stringify(body.output).slice(0, 300)}`,
          ),
        );
      return urls.map((url) => ({ url, ext: ".mp4" }));
    }
  }
}

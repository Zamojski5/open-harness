// Media generation providers, all on the user's own API keys.
// Model ids:
//   <fal endpoint id>                         e.g. fal-ai/nano-banana-2, fal-ai/veo3.1/fast
//   openai:<model>                            e.g. openai:gpt-image-1
//   google:<model>                            Gemini image models or Veo video models
//   elevenlabs:tts[/<voiceId>] | elevenlabs:sfx | elevenlabs:music
//
// Each call is split into prepare (generic request → the provider's native input, with adjustment
// notes; throws invalid_input for impossible requests) and execute (submit → handle → poll), so jobs
// can persist the provider handle and resume polling after a restart.

import { ohHome } from "../home.ts";
import { call, pollWithRetry, sleep } from "./http.ts";
import { prepareReplicate, replicatePoll, replicateSubmit } from "./replicate.ts";
import { prepareRunware, runwarePoll, runwareSubmit } from "./runware.ts";
import { basename, extname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  classifyException,
  classifyHttp,
  classifyReported,
  failureError,
  makeFailure,
  MediaError,
  type Failure,
  type Provider,
} from "./failures.ts";
import {
  convertForFal,
  falEndpointSchema,
  hasImageInput,
  hasVideoInput,
  kindFromCategory,
  resolutionPixels,
  snapDuration,
  type Converted,
  type EndpointSchema,
  type GenericParams,
} from "./schema.ts";

export { MediaError } from "./failures.ts";
export type { MediaErrorCode } from "./failures.ts";

/** API keys: ~/.open-herness/keys.json, overridden by environment variables. */
export interface Keys {
  falApiKey: string;
  openaiApiKey: string;
  googleApiKey: string;
  elevenLabsApiKey: string;
  runwareApiKey: string;
  replicateApiKey: string;
}

const KEYS_FILE = () => ohHome("keys.json");

export function loadKeys(): Keys {
  let file: Partial<Keys> = {};
  try {
    file = JSON.parse(readFileSync(KEYS_FILE(), "utf8")) as Partial<Keys>;
  } catch {
    // no keys yet
  }
  return {
    falApiKey: process.env.FAL_KEY || file.falApiKey || "",
    openaiApiKey: process.env.OPENAI_API_KEY || file.openaiApiKey || "",
    googleApiKey:
      process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || file.googleApiKey || "",
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || file.elevenLabsApiKey || "",
    runwareApiKey: process.env.RUNWARE_API_KEY || file.runwareApiKey || "",
    replicateApiKey: process.env.REPLICATE_API_TOKEN || file.replicateApiKey || "",
  };
}

export function saveKey(name: keyof Keys, value: string) {
  let file: Partial<Keys> = {};
  try {
    file = JSON.parse(readFileSync(KEYS_FILE(), "utf8")) as Partial<Keys>;
  } catch {
    // new file
  }
  file[name] = value;
  mkdirSync(ohHome(), { recursive: true });
  writeFileSync(KEYS_FILE(), JSON.stringify(file, null, 2), { mode: 0o600 });
}

export const KEY_OF: Record<Provider, keyof Keys> = {
  fal: "falApiKey",
  openai: "openaiApiKey",
  google: "googleApiKey",
  elevenlabs: "elevenLabsApiKey",
  runware: "runwareApiKey",
  replicate: "replicateApiKey",
};
export const PAYER: Record<Provider, string> = {
  fal: "your fal key",
  openai: "your OpenAI key",
  google: "your Google (Gemini API) key",
  elevenlabs: "your ElevenLabs plan (credits)",
  runware: "your Runware key",
  replicate: "your Replicate token",
};

export type MediaKind = "image" | "video" | "speech" | "music" | "sfx" | "other";

export interface GenerateRequest {
  model: string;
  prompt?: string;
  /** Native provider input; merged over the mapped prompt/parameters. */
  input?: Record<string, unknown>;
  /** Local file paths or URLs used as reference images (image-to-image / image-to-video). */
  references?: string[];
  /** Local path or URL of the last frame (video models with first/last frame). */
  endImage?: string;
  /** Local path or URL of a source video (video-to-video: restyle, edit, render-to-real). */
  video?: string;
  /** auto: may switch to an equivalent route on another provider if this one fails before acceptance. */
  route?: string;
  parameters?: {
    aspect_ratio?: string;
    resolution?: string;
    duration?: number;
    num_outputs?: number;
    voice?: string;
    seed?: number;
    negative_prompt?: string;
    audio?: boolean;
    loop?: boolean;
    /** Seedance 2.5: a cheap 480p draft that media_finish_draft can finish at 1080p */
    draft?: boolean;
  };
  /** Seconds of the source video (measured), for prices billed on input length. */
  inputSeconds?: number;
  /** Seconds a per-second price applies to when the model has no duration field (upscalers). */
  meterSeconds?: number;
  /** Finish an earlier draft (same provider, same take) instead of generating a new one. */
  finishDraft?: {
    draftId: string;
    provider: string;
    seconds: number;
    ofJob: string;
    /** the draft was made from a source/reference clip (its seconds are billed on finishing too) */
    videoInput?: boolean;
    inputSeconds?: number;
  };
}

/** One produced file, either as bytes or as a URL to download. */
export interface ProviderOutput {
  url?: string;
  data?: Buffer;
  ext: string;
  /** auth headers needed to download the url */
  headers?: Record<string, string>;
  /** a finishable draft (Seedance 2.5 draft mode) */
  draftId?: string;
  /** the charge the provider reported for this output, USD */
  costUsd?: number;
  seed?: number;
}

/** What is needed to find a submitted job again (persisted right after submit). */
export type ProviderHandle =
  | {
      provider: "fal";
      endpoint: string;
      requestId: string;
      statusUrl: string;
      responseUrl: string;
      cancelUrl?: string;
    }
  | { provider: "google"; operation: string; model: string }
  | { provider: "runware"; taskUUID: string; model: string }
  | { provider: "replicate"; id: string; getUrl: string; cancelUrl?: string };

export interface ProviderContext {
  keys: Keys;
  signal: AbortSignal;
  onStatus: (status: string, detail?: string) => void;
  /** called as soon as the provider accepted the job */
  onHandle?: (handle: ProviderHandle) => void;
}

/** A request translated for one concrete route. */
export interface Prepared {
  provider: Provider;
  /** the route's model id (what the user would pass as model) */
  model: string;
  /** the endpoint actually called (fal sub-route, Google model name, ElevenLabs path) */
  endpoint: string;
  kind: MediaKind;
  /** native body sent to the provider */
  native: Record<string, unknown>;
  adjustments: string[];
  /** Gemini image: number of parallel calls */
  count?: number;
}

export const DEFAULT_MODELS: Record<
  string,
  { fal?: string; openai?: string; google?: string; elevenlabs?: string }
> = {
  image: {
    fal: "google/nano-banana-2.1",
    openai: "openai:gpt-image-1",
    google: "google:gemini-3.1-flash-image",
  },
  video: { fal: "minimax/h3-max/text-to-video", google: "google:veo-3.1-fast-generate-preview" },
  speech: { elevenlabs: "elevenlabs:tts", openai: "openai:gpt-4o-mini-tts" },
  music: { elevenlabs: "elevenlabs:music", fal: "fal-ai/lyria3" },
  sfx: { elevenlabs: "elevenlabs:sfx", fal: "fal-ai/elevenlabs/sound-effects/v2" },
};

const GPT_IMAGE_FAL = {
  generate: "openai/gpt-image-2.5/flare/text-to-image",
  edit: "openai/gpt-image-2.5/flare/edit",
};

/** Pick a default model for a kind based on which keys exist. */
export function defaultModel(
  kind: string,
  keys: Keys,
  opts: { edit?: boolean } = {},
): string | undefined {
  const d = DEFAULT_MODELS[kind];
  if (!d) return undefined;
  // The user prefers GPT Image for photos: an OpenAI key (generation only - that route takes no
  // references), else fal's GPT Image routes (edit takes up to 16 references); Nano Banana otherwise.
  // OH_IMAGE_PREFER=nano-banana restores the old default.
  if (kind === "image" && process.env.OH_IMAGE_PREFER !== "nano-banana") {
    if (keys.openaiApiKey && !opts.edit && d.openai) return d.openai;
    if (keys.falApiKey) return GPT_IMAGE_FAL[opts.edit ? "edit" : "generate"];
  }
  if (d.fal && keys.falApiKey) return d.fal;
  if (d.elevenlabs && keys.elevenLabsApiKey) return d.elevenlabs;
  if (d.google && keys.googleApiKey) return d.google;
  if (d.openai && keys.openaiApiKey) return d.openai;
  return undefined;
}

export function providerOf(model: string): Provider {
  if (model.startsWith("openai:")) return "openai";
  if (model.startsWith("google:")) return "google";
  if (model.startsWith("elevenlabs:")) return "elevenlabs";
  if (model.startsWith("runware:")) return "runware";
  if (model.startsWith("replicate:")) return "replicate";
  return "fal";
}

// ---------------- equivalent routes (fallback) ----------------
// The same underlying model sold by two providers. Google ids are data, not guesses in code: if Google
// retires one (the Gemini API pulled veo-3.1-*-preview on 2026-10-22), the route fails with
// model_unavailable, gets a 60 min cooldown and auto mode falls back to fal.
export const EQUIVALENT_ROUTES: { label: string; fal: string; google: string }[] = [
  {
    label: "Veo 3.1 Fast",
    fal: "fal-ai/veo3.1/fast",
    google: "google:veo-3.1-fast-generate-preview",
  },
  { label: "Veo 3.1", fal: "fal-ai/veo3.1", google: "google:veo-3.1-generate-preview" },
  {
    label: "Nano Banana 2 (Gemini 3.1 Flash Image)",
    fal: "fal-ai/nano-banana-2",
    google: "google:gemini-3.1-flash-image",
  },
  {
    label: "Nano Banana Pro (Gemini 3 Pro Image)",
    fal: "fal-ai/nano-banana-pro",
    google: "google:gemini-3-pro-image",
  },
  {
    label: "Nano Banana (Gemini 2.5 Flash Image)",
    fal: "fal-ai/nano-banana",
    google: "google:gemini-2.5-flash-image",
  },
];

const FAL_SUBROUTE =
  /\/(image-to-video|first-last-frame-to-video|reference-to-video|text-to-video|edit)$/;

export function equivalentGroup(model: string) {
  const base = model.replace(FAL_SUBROUTE, "");
  return EQUIVALENT_ROUTES.find(
    (g) =>
      g.fal === base ||
      model === g.google ||
      (model.startsWith(`${g.google}-`) && /-preview$|-\d+$/.test(model)),
  );
}

/**
 * Candidate routes in order. route: "exact" → only the model; "fal"/"google" → the equivalent on that
 * provider; "auto" (default) → the model, then its equivalent on the other provider.
 */
export function routeCandidates(model: string, route = "auto"): string[] {
  const group = equivalentGroup(model);
  if (route === "exact") return [model];
  if (route === "fal" || route === "google") {
    if (providerOf(model) === route) return [model];
    if (!group)
      throw failureError(
        makeFailure("invalid_input", "local", {
          message: `No ${route} route for ${model}.`,
          hint: `Equivalent routes exist only for: ${EQUIVALENT_ROUTES.map((g) => g.label).join(", ")}. Use route "auto" or pick a ${route} model.`,
        }),
      );
    return [group[route]];
  }
  if (!group) return [model];
  return [model, providerOf(model) === "fal" ? group.google : group.fal];
}

// ---------------- kinds ----------------

const KNOWN_KINDS: [RegExp, MediaKind][] = [
  [/^google:veo/, "video"],
  [/^google:.*image/, "image"],
  [/^openai:.*tts/, "speech"],
  [/^openai:(gpt-image|dall-e)/, "image"],
  [/^elevenlabs:tts/, "speech"],
  [/^elevenlabs:sfx/, "sfx"],
  [/^elevenlabs:music/, "music"],
];

/** Offline guess (catalogue, then whole id tokens). Prefer resolveKind, which reads the fal category. */
export function guessKind(model: string): MediaKind {
  const known = KNOWN_KINDS.find(([re]) => re.test(model));
  if (known) return known[1];
  const tokens = model.toLowerCase().split(/[/:._-]+/);
  const any = (words: string[]) =>
    tokens.some((t) => words.some((w) => t === w || t.startsWith(w)));
  if (model.includes("sound-effects") || any(["sfx"])) return "sfx";
  if (any(["tts", "speech"])) return "speech";
  if (any(["music", "lyria", "song"])) return "music";
  if (
    /to-video|video/.test(model) ||
    any(["veo", "kling", "hailuo", "luma", "wan", "seedance", "sora", "pixverse", "runway", "ltxv"])
  )
    return "video";
  if (
    /to-image|image/.test(model) ||
    any(["flux", "banana", "recraft", "ideogram", "imagen", "seedream", "sdxl", "qwen"])
  )
    return "image";
  return "other";
}

/** Kind from the fal catalogue category when available (the caller's kind breaks text-to-audio ties). */
export async function resolveKind(model: string, hint?: string): Promise<MediaKind> {
  if (providerOf(model) === "fal") {
    try {
      const schema = await falEndpointSchema(model);
      const k = kindFromCategory(schema?.category, hint && hint !== "image" ? hint : model);
      if (k) return k;
    } catch {
      // offline: fall through
    }
  }
  return guessKind(model);
}

// ---------------- helpers ----------------

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** Local file → data URI (fal and others accept data URIs for inputs). URLs pass through. */
export function toDataUri(ref: string): string {
  if (/^(https?:|data:)/.test(ref)) return ref;
  const mime = MIME[extname(ref).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${readFileSync(ref).toString("base64")}`;
}

/** Google wants inline bytes; URLs are downloaded first. */
async function inlineImage(
  ref: string,
  signal: AbortSignal,
): Promise<{ bytesBase64Encoded: string; mimeType: string }> {
  if (/^https?:/.test(ref)) {
    const res = await fetch(ref, { signal });
    if (!res.ok)
      throw failureError(
        makeFailure("invalid_input", "local", {
          message: `Could not download reference ${ref} (${res.status}).`,
        }),
      );
    return {
      bytesBase64Encoded: Buffer.from(await res.arrayBuffer()).toString("base64"),
      mimeType: res.headers.get("content-type") ?? "image/png",
    };
  }
  const [, mime, b64] = toDataUri(ref).match(/^data:([^;]+);base64,(.*)$/s) ?? [];
  return { bytesBase64Encoded: b64 ?? "", mimeType: mime ?? "image/png" };
}

export function requireKey(key: string, name: string, provider: Provider = "fal") {
  if (!key)
    throw new MediaError(
      `No ${name} key configured.`,
      "missing_key",
      `Ask the user for a ${name} key (they can paste it in the chat; save it with media_set_key) or pick another model.`,
      makeFailure("auth", provider, { message: `No ${name} key configured.` }),
    );
  return key;
}

const generic = (req: GenerateRequest): GenericParams => {
  const p = req.parameters ?? {};
  const g: GenericParams = {};
  if (req.prompt !== undefined) g.prompt = req.prompt;
  if (req.references?.length) g.references = req.references.map(toDataUri);
  if (req.endImage) g.endImage = toDataUri(req.endImage);
  // Videos are too big for data URIs; local paths stay paths and are uploaded at submit.
  if (req.video) g.video = req.video;
  for (const k of [
    "duration",
    "aspect_ratio",
    "resolution",
    "audio",
    "negative_prompt",
    "seed",
    "num_outputs",
    "loop",
  ] as const)
    if (p[k] !== undefined) (g as Record<string, unknown>)[k] = p[k];
  return g;
};

const incompatible = (items: string[], model: string) =>
  failureError(
    makeFailure("invalid_input", "local", {
      message: `incompatible: ${items.join("; ")}`,
      hint: `${model} can't do this. Drop the feature, pass native fields via input (media_model_schema), or pick a model that supports it (media_models).`,
    }),
  );

// ---------------- fal ----------------

function urlsIn(value: unknown, out: { url: string; ext: string }[] = []) {
  if (Array.isArray(value)) value.forEach((v) => urlsIn(v, out));
  else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === "string" && /^https?:/.test(obj.url)) {
      const fromName = typeof obj.file_name === "string" ? extname(obj.file_name) : "";
      const fromUrl = extname(new URL(obj.url).pathname);
      const fromType =
        typeof obj.content_type === "string"
          ? Object.entries(MIME).find(([, m]) => m === obj.content_type)?.[0]
          : undefined;
      out.push({ url: obj.url, ext: fromName || fromUrl || fromType || ".bin" });
    } else for (const [k, v] of Object.entries(obj)) if (k !== "timings") urlsIn(v, out);
  }
  return out;
}

/** Sibling endpoints to try when references / an end frame need an image route. */
function falSiblings(model: string, kind: MediaKind, g: GenericParams): string[] {
  const out = [model];
  const base = model.replace(FAL_SUBROUTE, "");
  const many = (g.references?.length ?? 0) > 1;
  if (kind === "image")
    out.push(
      `${base}/edit`,
      model.replace(/text-to-image$/, "image-to-image"),
      model.replace(/text-to-image$/, "edit"),
    );
  if (kind === "video" && g.video) {
    out.push(
      `${base}/video-to-video`,
      `${base}/edit`,
      `${base}/video-to-video/edit`,
      model.replace(/(text|image)-to-video$/, "video-to-video"),
    );
  }
  if (kind === "video" && !g.video) {
    if (g.endImage) out.push(`${base}/first-last-frame-to-video`);
    if (many && !g.endImage) out.push(`${base}/reference-to-video`);
    out.push(`${base}/image-to-video`, model.replace(/text-to-video$/, "image-to-video"));
  }
  return [...new Set(out)];
}

async function prepareFal(
  req: GenerateRequest,
  model: string,
  kindHint?: string,
): Promise<Prepared> {
  if (req.finishDraft)
    // Same take, finished at 1080p by the account that made the draft (fal: within 14 days, 7 for US).
    return {
      provider: "fal",
      model,
      endpoint: "bytedance/seedance-2.5/draft/complete",
      kind: "video",
      native: { draft_id: req.finishDraft.draftId, resolution: "1080p" },
      adjustments: ["finishing the draft at 1080p"],
    };
  const g = generic(req);
  // Seedance 2.5 draft mode: fal renders 480p and returns a draft_id.
  const native = req.parameters?.draft ? { ...req.input, draft: true } : (req.input ?? {});
  let base: EndpointSchema | null;
  try {
    base = await falEndpointSchema(model);
  } catch {
    // Schema unreachable and not cached: send what we can, and say so.
    const body: Record<string, unknown> = {
      ...(g.prompt !== undefined ? { prompt: g.prompt } : {}),
      ...native,
    };
    return {
      provider: "fal",
      model,
      endpoint: model,
      kind: guessKind(model),
      native: body,
      adjustments: [
        "fal schema unavailable (offline?): only prompt + native input were sent; generic parameters were not mapped",
      ],
    };
  }
  if (!base)
    throw failureError(
      makeFailure("model_unavailable", "fal", { message: `fal has no endpoint ${model}.` }),
    );
  const kind =
    kindFromCategory(base.category, kindHint && kindHint !== "image" ? kindHint : model) ??
    guessKind(model);
  const needsImageRoute =
    ((g.references?.length || g.endImage) && !hasImageInput(native)) ||
    (g.video && !hasVideoInput(native));
  let first: Converted | undefined;
  for (const candidate of needsImageRoute ? falSiblings(model, kind, g) : [model]) {
    const schema =
      candidate === model ? base : await falEndpointSchema(candidate).catch(() => null);
    if (!schema) continue;
    const conv = convertForFal(schema, g, kind, native);
    first ??= conv;
    if (!conv.incompatible.length) {
      const adjustments =
        candidate === model
          ? conv.adjustments
          : [
              `routed to ${candidate} (takes the ${g.video ? "source video" : "reference images"})`,
              ...conv.adjustments,
            ];
      // Veo reference-to-video has a free-form duration string but only renders 8 s.
      if (
        /veo3.*reference-to-video$/.test(candidate) &&
        "duration" in conv.input &&
        conv.input.duration !== "8s" &&
        !("duration" in native)
      ) {
        adjustments.push(
          `duration ${conv.input.duration} → 8s (Veo reference-to-video renders 8 s only)`,
        );
        conv.input.duration = "8s";
      }
      return { provider: "fal", model, endpoint: candidate, kind, native: conv.input, adjustments };
    }
  }
  throw incompatible(first!.incompatible, model);
}

const UPLOAD_EXT =
  /\.(mp4|mov|webm|m4v|mkv|png|jpe?g|webp|exr|tiff?|wav|mp3|m4a|aac|flac|glb|obj|zip)$/i;

/** Local file paths left in a fal input (source videos, native *_url fields) → fal CDN URLs. */
async function uploadLocalFiles(value: unknown, key: string, signal: AbortSignal): Promise<any> {
  if (typeof value === "string") {
    if (/^(https?:|data:)/.test(value) || !UPLOAD_EXT.test(value) || !existsSync(value))
      return value;
    return falUpload(value, key, signal);
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => uploadLocalFiles(v, key, signal)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await uploadLocalFiles(v, key, signal);
    return out;
  }
  return value;
}

export async function falUpload(path: string, key: string, signal: AbortSignal): Promise<string> {
  const ext = extname(path).toLowerCase();
  const contentType =
    MIME[ext] ??
    (ext === ".mov"
      ? "video/quicktime"
      : ext === ".webm"
        ? "video/webm"
        : "application/octet-stream");
  const init = await call(
    "fal",
    "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
    {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: contentType, file_name: basename(path) }),
      signal,
    },
    "submit",
    false,
  );
  const { upload_url, file_url } = init as { upload_url?: string; file_url?: string };
  if (!upload_url || !file_url)
    throw failureError(
      makeFailure("ambiguous", "fal", {
        detail: `upload initiate: ${JSON.stringify(init).slice(0, 200)}`,
      }),
    );
  const put = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: readFileSync(path),
    signal,
  });
  if (!put.ok)
    throw failureError(
      classifyHttp("fal", put.status, await put.text(), { accepted: false, retryAfter: null }),
    );
  return file_url;
}

async function falSubmit(
  p: Prepared,
  ctx: ProviderContext,
): Promise<ProviderHandle & { provider: "fal" }> {
  const key = requireKey(ctx.keys.falApiKey, "fal.ai", "fal");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  ctx.onStatus("queued", p.endpoint);
  const body = await uploadLocalFiles(p.native, key, ctx.signal);
  const submit = await call(
    "fal",
    `https://queue.fal.run/${p.endpoint}`,
    { method: "POST", headers, body: JSON.stringify(body), signal: ctx.signal },
    "submit",
    false,
  );
  const { request_id, status_url, response_url, cancel_url } = submit as {
    request_id: string;
    status_url: string;
    response_url: string;
    cancel_url?: string;
  };
  if (!status_url || !response_url)
    throw failureError(
      makeFailure("ambiguous", "fal", {
        accepted: true,
        detail: JSON.stringify(submit).slice(0, 300),
      }),
    );
  const handle = {
    provider: "fal" as const,
    endpoint: p.endpoint,
    requestId: request_id,
    statusUrl: status_url,
    responseUrl: response_url,
    ...(cancel_url ? { cancelUrl: cancel_url } : {}),
  };
  ctx.onHandle?.(handle);
  return handle;
}

async function falPoll(
  h: ProviderHandle & { provider: "fal" },
  ctx: ProviderContext,
): Promise<ProviderOutput[]> {
  const key = requireKey(ctx.keys.falApiKey, "fal.ai", "fal");
  const headers = { Authorization: `Key ${key}` };
  const onAbort = () =>
    h.cancelUrl && void fetch(h.cancelUrl, { method: "PUT", headers }).catch(() => {});
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  for (;;) {
    await sleep(2000, ctx.signal);
    const status = await pollWithRetry(
      () => call("fal", `${h.statusUrl}?logs=1`, { headers, signal: ctx.signal }, "poll", true),
      ctx.signal,
    );
    if (status.status === "IN_QUEUE")
      ctx.onStatus(
        "queued",
        status.queue_position !== undefined ? `pozycja ${status.queue_position}` : undefined,
      );
    if (status.status === "IN_PROGRESS") ctx.onStatus("running", status.logs?.at?.(-1)?.message);
    if (status.status === "FAILED" || (status.error && status.status !== "COMPLETED"))
      throw failureError(classifyReported("fal", JSON.stringify(status.error ?? status)));
    if (status.status === "COMPLETED") {
      if (status.error)
        throw failureError(
          classifyReported(
            "fal",
            JSON.stringify(status.error) + JSON.stringify(status.error_type ?? ""),
          ),
        );
      break;
    }
  }
  // fal reports runtime validation/moderation errors as an error status on the response URL.
  const result = await pollWithRetry(
    () => call("fal", h.responseUrl, { headers, signal: ctx.signal }, "result", true),
    ctx.signal,
  );
  const outputs: ProviderOutput[] = urlsIn(result);
  if (typeof result.draft_id === "string" && outputs[0]) outputs[0].draftId = result.draft_id;
  if (typeof result.seed === "number" && outputs[0]) outputs[0].seed = result.seed;
  if (!outputs.length)
    throw failureError(
      classifyReported(
        "fal",
        `${result.has_nsfw_concepts?.some?.(Boolean) ? "nsfw content flagged; " : ""}no files in result: ${JSON.stringify(result).slice(0, 400)}`,
      ),
    );
  return outputs;
}

export async function falSearchModels(key: string, q: string, category?: string, limit = 20) {
  const url = new URL("https://api.fal.ai/v1/models");
  if (q) url.searchParams.set("q", q);
  if (category) url.searchParams.set("category", category);
  url.searchParams.set("limit", String(limit));
  const data = await call(
    "fal",
    url.toString(),
    { headers: key ? { Authorization: `Key ${key}` } : {} },
    "sync",
    false,
  );
  const models = (data.models ?? data.items ?? data.data ?? []) as Record<string, any>[];
  return models.map((m) => ({
    id: m.endpoint_id ?? m.id,
    name: m.metadata?.display_name ?? m.display_name ?? m.title,
    category: m.metadata?.category ?? m.category,
    description: (m.metadata?.description ?? m.description ?? "").slice(0, 200),
  }));
}

export async function falModelSchema(model: string) {
  const schema = await falEndpointSchema(model);
  if (!schema) throw new Error(`fal has no endpoint ${model}`);
  return {
    model,
    category: schema.category,
    kind: kindFromCategory(schema.category, model),
    input: schema.raw,
  };
}

// ---------------- OpenAI ----------------

function prepareOpenai(req: GenerateRequest, model: string): Prepared {
  const name = model.slice("openai:".length);
  const p = req.parameters ?? {};
  const adjustments: string[] = [];
  if (/tts/.test(name)) {
    if (req.references?.length) throw incompatible(["references (text-to-speech)"], model);
    return {
      provider: "openai",
      model,
      endpoint: "audio/speech",
      kind: "speech",
      native: { model: name, voice: p.voice ?? "alloy", input: req.prompt ?? "", ...req.input },
      adjustments,
    };
  }
  if (req.references?.length)
    throw incompatible(
      [
        "references (this route only generates; use an edit model such as fal-ai/nano-banana-2 with references)",
      ],
      model,
    );
  const sizes: Record<string, string> = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "3:2": "1536x1024",
    "9:16": "1024x1536",
    "2:3": "1024x1536",
  };
  const size = sizes[p.aspect_ratio ?? "1:1"] ?? "auto";
  if (p.aspect_ratio && !sizes[p.aspect_ratio])
    adjustments.push(`aspect_ratio ${p.aspect_ratio} → size auto (gpt-image takes 1:1, 3:2, 2:3)`);
  if (p.seed !== undefined) adjustments.push("seed not supported by OpenAI images");
  if (p.negative_prompt)
    adjustments.push("negative_prompt not supported; put exclusions in the prompt");
  return {
    provider: "openai",
    model,
    endpoint: "images/generations",
    kind: "image",
    native: { model: name, prompt: req.prompt, size, n: p.num_outputs ?? 1, ...req.input },
    adjustments,
  };
}

async function runOpenai(p: Prepared, ctx: ProviderContext): Promise<ProviderOutput[]> {
  const key = requireKey(ctx.keys.openaiApiKey, "OpenAI", "openai");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  ctx.onStatus("running", p.endpoint);
  if (p.endpoint === "audio/speech") {
    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers,
        signal: ctx.signal,
        body: JSON.stringify(p.native),
      });
    } catch (error) {
      if (ctx.signal.aborted) throw new MediaError("Anulowano", "cancelled");
      throw failureError(classifyException("openai", error, { phase: "sync" }));
    }
    if (!res.ok)
      throw failureError(
        classifyHttp("openai", res.status, await res.text(), {
          retryAfter: res.headers.get("retry-after"),
        }),
      );
    return [{ data: Buffer.from(await res.arrayBuffer()), ext: ".mp3" }];
  }
  const data = await call(
    "openai",
    "https://api.openai.com/v1/images/generations",
    { method: "POST", headers, signal: ctx.signal, body: JSON.stringify(p.native) },
    "sync",
    false,
  );
  return (data.data as { b64_json?: string; url?: string }[]).map((d) =>
    d.b64_json
      ? { data: Buffer.from(d.b64_json, "base64"), ext: ".png" }
      : { url: d.url!, ext: ".png" },
  );
}

// ---------------- Google (Gemini image, Veo video) ----------------

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VEO_DURATIONS = { type: "integer", nullable: false, enum: [4, 6, 8] };

async function prepareGoogle(
  req: GenerateRequest,
  model: string,
  signal: AbortSignal,
): Promise<Prepared> {
  const name = model.slice("google:".length);
  const p = req.parameters ?? {};
  const adjustments: string[] = [];
  const refs = req.references ?? [];
  if (/veo/.test(name)) {
    const instance: Record<string, unknown> = { prompt: req.prompt };
    if (req.endImage) {
      if (refs.length !== 1)
        throw incompatible(["end_image needs exactly one start reference on Google Veo"], model);
      instance.image = await inlineImage(refs[0]!, signal);
      instance.lastFrame = await inlineImage(req.endImage, signal);
    } else if (refs.length === 1) instance.image = await inlineImage(refs[0]!, signal);
    else if (refs.length > 1) {
      if (refs.length > 3)
        adjustments.push(
          `Veo takes at most 3 reference images; used the first 3, dropped ${refs.length - 3}`,
        );
      instance.referenceImages = await Promise.all(
        refs
          .slice(0, 3)
          .map(async (r) => ({ image: await inlineImage(r, signal), referenceType: "asset" })),
      );
    }
    const parameters: Record<string, unknown> = {};
    if (p.aspect_ratio) {
      const [w, h] = p.aspect_ratio.split(":").map(Number);
      parameters.aspectRatio = ["16:9", "9:16"].includes(p.aspect_ratio)
        ? p.aspect_ratio
        : (w ?? 1) >= (h ?? 1)
          ? "16:9"
          : "9:16";
      if (parameters.aspectRatio !== p.aspect_ratio)
        adjustments.push(
          `aspect_ratio ${p.aspect_ratio} → ${parameters.aspectRatio} (Veo: 16:9 or 9:16)`,
        );
    }
    let resolution = p.resolution?.toLowerCase();
    if (resolution && !["720p", "1080p", "4k"].includes(resolution)) {
      const px = resolutionPixels(p.resolution!);
      const snapped = px >= 1500 ? "4k" : px >= 900 ? "1080p" : "720p";
      adjustments.push(`resolution ${p.resolution} → ${snapped} (Veo: 720p, 1080p, 4k)`);
      resolution = snapped;
    }
    if (resolution) parameters.resolution = resolution;
    let seconds = p.duration;
    if (seconds !== undefined) {
      const snapped = snapDuration(VEO_DURATIONS, seconds).seconds;
      if (snapped !== seconds)
        adjustments.push(`duration ${seconds}s → ${snapped}s (Veo: 4, 6, 8)`);
      seconds = snapped;
    }
    // Veo rule: 1080p/4k and reference images only at 8 s.
    const needs8 =
      resolution === "1080p" || resolution === "4k"
        ? resolution
        : instance.referenceImages
          ? "reference images"
          : "";
    if (needs8 && seconds !== undefined && seconds !== 8) {
      adjustments.push(
        `duration ${seconds}s → 8s (Veo allows ${needs8} only at 8 s; trim with ffmpeg afterwards)`,
      );
      seconds = 8;
    } else if (needs8 && seconds === undefined) seconds = 8;
    if (seconds !== undefined) parameters.durationSeconds = seconds;
    if (p.negative_prompt) parameters.negativePrompt = p.negative_prompt;
    if (p.seed !== undefined) parameters.seed = p.seed;
    if (p.audio === false)
      adjustments.push("Google Veo always generates audio; strip it with ffmpeg -an if needed");
    if (p.num_outputs && p.num_outputs > 1)
      adjustments.push(
        `Veo makes one video per request; submit ${p.num_outputs} jobs for ${p.num_outputs} variants`,
      );
    return {
      provider: "google",
      model,
      endpoint: name,
      kind: "video",
      native: { instances: [instance], parameters, ...req.input },
      adjustments,
    };
  }
  // Gemini image
  if (req.endImage) throw incompatible(["end_image (image model)"], model);
  let prompt = req.prompt ?? "";
  if (p.negative_prompt) {
    prompt += `\nAvoid: ${p.negative_prompt}`;
    adjustments.push(
      "negative_prompt appended to the prompt as 'Avoid: …' (Gemini has no negative prompt field)",
    );
  }
  const parts: Record<string, unknown>[] = [{ text: prompt }];
  for (const ref of refs) {
    const img = await inlineImage(ref, signal);
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.bytesBase64Encoded } });
  }
  const imageConfig: Record<string, unknown> = {};
  if (p.aspect_ratio) imageConfig.aspectRatio = p.aspect_ratio;
  if (p.resolution) {
    if (/2\.5/.test(name)) adjustments.push(`${name} has a fixed ~1K output; resolution ignored`);
    else {
      // imageSize is "1K" | "2K" | "4K"; video-style labels map 720p→1K, 1080p→2K, 4k/2160p→4K.
      const r = p.resolution.trim();
      const px = resolutionPixels(r);
      const size = /K$/.test(r)
        ? px >= 3000
          ? "4K"
          : px >= 1500
            ? "2K"
            : "1K"
        : px >= 1500
          ? "4K"
          : px >= 900
            ? "2K"
            : "1K";
      imageConfig.imageSize = size;
      if (size !== r) adjustments.push(`resolution ${p.resolution} → imageSize ${size}`);
    }
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ["IMAGE", "TEXT"] };
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  if (p.seed !== undefined) generationConfig.seed = p.seed;
  if (p.duration !== undefined) adjustments.push("duration ignored (image model)");
  const count = Math.min(4, p.num_outputs ?? 1);
  if (count > 1)
    adjustments.push(`${count} outputs = ${count} parallel Gemini calls (each billed)`);
  return {
    provider: "google",
    model,
    endpoint: name,
    kind: "image",
    native: { contents: [{ parts }], generationConfig, ...req.input },
    adjustments,
    count,
  };
}

async function googleVeoSubmit(
  p: Prepared,
  ctx: ProviderContext,
): Promise<ProviderHandle & { provider: "google" }> {
  const key = requireKey(ctx.keys.googleApiKey, "Google AI (Gemini)", "google");
  ctx.onStatus("queued", p.endpoint);
  const op = await call(
    "google",
    `${GOOGLE_BASE}/models/${p.endpoint}:predictLongRunning`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      signal: ctx.signal,
      body: JSON.stringify(p.native),
    },
    "submit",
    false,
  );
  if (typeof op.name !== "string")
    throw failureError(
      makeFailure("ambiguous", "google", {
        accepted: true,
        detail: JSON.stringify(op).slice(0, 300),
      }),
    );
  const handle = { provider: "google" as const, operation: op.name, model: p.endpoint };
  ctx.onHandle?.(handle);
  return handle;
}

/** Google operation error → failure (gRPC codes; the text wins for moderation/billing). */
function googleOpFailure(error: { code?: number; message?: string }): Failure {
  const text = JSON.stringify(error);
  const byCode: Record<number, Failure["category"]> = {
    3: "invalid_input",
    5: "model_unavailable",
    7: "auth",
    8: "capacity",
    13: "outage",
    14: "outage",
  };
  const reported = classifyReported("google", text);
  const category =
    reported.category === "moderation" || reported.category === "billing"
      ? reported.category
      : (byCode[error.code ?? -1] ?? reported.category);
  return makeFailure(category, "google", {
    accepted: true,
    retryable: false,
    detail: text.slice(0, 600),
  });
}

async function googleVeoPoll(
  h: ProviderHandle & { provider: "google" },
  ctx: ProviderContext,
): Promise<ProviderOutput[]> {
  const key = requireKey(ctx.keys.googleApiKey, "Google AI (Gemini)", "google");
  const headers = { "x-goog-api-key": key };
  let op: Record<string, any> = { done: false };
  while (!op.done) {
    await sleep(5000, ctx.signal);
    ctx.onStatus("running", h.model);
    op = await pollWithRetry(
      () =>
        call(
          "google",
          `${GOOGLE_BASE}/${h.operation}`,
          { headers, signal: ctx.signal },
          "poll",
          true,
        ),
      ctx.signal,
    );
  }
  if (op.error) throw failureError(googleOpFailure(op.error));
  const resp = op.response?.generateVideoResponse ?? {};
  const samples = resp.generatedSamples ?? [];
  if (!samples.length) {
    const reasons = resp.raiMediaFilteredReasons ?? resp.raiMediaFilteredCount;
    throw failureError(
      reasons
        ? makeFailure("moderation", "google", {
            accepted: true,
            detail: JSON.stringify(reasons).slice(0, 400),
          })
        : classifyReported(
            "google",
            `no video in response: ${JSON.stringify(op.response).slice(0, 400)}`,
          ),
    );
  }
  return samples.map((s: { video: { uri: string } }) => ({
    url: s.video.uri,
    ext: ".mp4",
    headers: { "x-goog-api-key": key },
  }));
}

const GEMINI_BLOCKED = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION|IMAGE_OTHER/;

async function runGeminiImage(p: Prepared, ctx: ProviderContext): Promise<ProviderOutput[]> {
  const key = requireKey(ctx.keys.googleApiKey, "Google AI (Gemini)", "google");
  ctx.onStatus("running", p.endpoint);
  const one = async (): Promise<ProviderOutput[]> => {
    const data = await call(
      "google",
      `${GOOGLE_BASE}/models/${p.endpoint}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        signal: ctx.signal,
        body: JSON.stringify(p.native),
      },
      "sync",
      false,
    );
    if (data.promptFeedback?.blockReason)
      throw failureError(
        makeFailure("moderation", "google", {
          accepted: true,
          detail: `blockReason ${data.promptFeedback.blockReason}`,
        }),
      );
    const cand = data.candidates?.[0];
    const out: ProviderOutput[] = [];
    for (const part of cand?.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      if (inline?.data)
        out.push({
          data: Buffer.from(inline.data, "base64"),
          ext: (inline.mimeType ?? inline.mime_type ?? "").includes("jpeg") ? ".jpg" : ".png",
        });
    }
    if (!out.length) {
      if (GEMINI_BLOCKED.test(cand?.finishReason ?? ""))
        throw failureError(
          makeFailure("moderation", "google", {
            accepted: true,
            detail: `finishReason ${cand.finishReason}`,
          }),
        );
      const said = (cand?.content?.parts ?? [])
        .map((x: { text?: string }) => x.text ?? "")
        .join(" ")
        .slice(0, 300);
      throw failureError(
        makeFailure("ambiguous", "google", {
          accepted: true,
          message: "Gemini answered without an image.",
          detail: said || JSON.stringify(data).slice(0, 300),
          hint: 'Rephrase as an explicit image request ("Generate an image of …") and retry once.',
        }),
      );
    }
    return out;
  };
  const results = await Promise.allSettled(Array.from({ length: p.count ?? 1 }, one));
  const ok = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!ok.length)
    throw (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
  return ok;
}

// ---------------- ElevenLabs ----------------

/** Max characters per TTS request by model (ElevenLabs docs, 2026). */
export const TTS_CHAR_LIMITS: Record<string, number> = {
  eleven_v3: 5000,
  eleven_multilingual_v2: 10000,
  eleven_flash_v2_5: 40000,
  eleven_turbo_v2_5: 40000,
  eleven_flash_v2: 30000,
  eleven_turbo_v2: 30000,
};
const voiceCache = new Map<string, { id: string; name: string }[]>();
const VOICE_ID = /^[A-Za-z0-9]{20}$/;

/** Voice id from an id or a (partial) voice name in the user's ElevenLabs library. */
export async function resolveVoice(
  voice: string,
  key: string,
  signal: AbortSignal,
): Promise<string> {
  if (VOICE_ID.test(voice)) return voice;
  let voices = voiceCache.get(key);
  if (!voices) {
    const all = await call(
      "elevenlabs",
      "https://api.elevenlabs.io/v1/voices",
      { headers: { "xi-api-key": key }, signal },
      "sync",
      false,
    );
    voices = ((all.voices ?? []) as { voice_id: string; name: string }[]).map((v) => ({
      id: v.voice_id,
      name: v.name,
    }));
    voiceCache.set(key, voices);
  }
  const v = voice.toLowerCase();
  const match =
    voices.find((x) => x.name.toLowerCase() === v) ??
    voices.find((x) => x.name.toLowerCase().split(/\s*[-–(]\s*/)[0] === v) ??
    voices.find((x) => x.name.toLowerCase().startsWith(v)) ??
    voices.find((x) => x.name.toLowerCase().includes(v));
  if (match) return match.id;
  throw failureError(
    makeFailure("invalid_input", "elevenlabs", {
      message: `No ElevenLabs voice named "${voice}".`,
      hint: `Available: ${
        voices
          .slice(0, 20)
          .map((x) => x.name)
          .join(", ") || "(none found)"
      }. Pass a voice name from this list or a voice id.`,
    }),
  );
}

async function prepareElevenLabs(
  req: GenerateRequest,
  model: string,
  keys: Keys,
  signal: AbortSignal,
): Promise<Prepared> {
  const [, op, voiceFromId] = model.match(/^elevenlabs:(\w+)(?:\/(.+))?$/) ?? [];
  const p = req.parameters ?? {};
  const adjustments: string[] = [];
  if (req.references?.length || req.endImage)
    throw incompatible(["references (audio model)"], model);
  if (op === "sfx") {
    if (p.duration !== undefined && (p.duration < 0.5 || p.duration > 30))
      throw failureError(
        makeFailure("invalid_input", "elevenlabs", {
          message: `Sound effects are 0.5-30 s (asked ${p.duration} s).`,
          hint: "Use 0.5-30 s; for longer beds generate a loop (parameters.loop=true) and repeat it with ffmpeg -stream_loop.",
        }),
      );
    const body: Record<string, unknown> = { text: req.prompt };
    if (p.duration !== undefined) body.duration_seconds = p.duration;
    if (p.loop) {
      body.loop = true;
      body.model_id = "eleven_text_to_sound_v2";
    }
    return {
      provider: "elevenlabs",
      model,
      endpoint: "v1/sound-generation",
      kind: "sfx",
      native: { ...body, ...req.input },
      adjustments,
    };
  }
  if (op === "music") {
    if (p.duration !== undefined && (p.duration < 3 || p.duration > 600))
      throw failureError(
        makeFailure("invalid_input", "elevenlabs", {
          message: `Music length must be 3-600 s (asked ${p.duration} s).`,
          hint: "Use 3-600 s; for longer pieces generate sections and join them with ffmpeg (crossfade).",
        }),
      );
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (p.duration !== undefined) body.music_length_ms = Math.round(p.duration * 1000);
    return {
      provider: "elevenlabs",
      model,
      endpoint: "v1/music",
      kind: "music",
      native: { ...body, ...req.input },
      adjustments,
    };
  }
  const modelId = String(req.input?.model_id ?? "eleven_multilingual_v2");
  const limit = TTS_CHAR_LIMITS[modelId];
  const length = (req.prompt ?? "").length;
  if (limit && length > limit)
    throw failureError(
      makeFailure("invalid_input", "elevenlabs", {
        message: `Text is ${length} characters; ${modelId} takes at most ${limit} per request.`,
        hint: "Split the text at sentence/paragraph boundaries into several speech jobs (same voice, same seed), then concatenate with ffmpeg.",
      }),
    );
  const wanted = voiceFromId ?? p.voice ?? "21m00Tcm4TlvDq8ikWAM";
  const voice = await resolveVoice(
    wanted,
    requireKey(keys.elevenLabsApiKey, "ElevenLabs", "elevenlabs"),
    signal,
  );
  if (voice !== wanted) adjustments.push(`voice "${wanted}" → ${voice}`);
  const body: Record<string, unknown> = { text: req.prompt, model_id: modelId };
  if (p.seed !== undefined) body.seed = p.seed;
  return {
    provider: "elevenlabs",
    model,
    endpoint: `v1/text-to-speech/${voice}`,
    kind: "speech",
    native: { ...body, ...req.input },
    adjustments,
  };
}

async function runElevenLabs(p: Prepared, ctx: ProviderContext): Promise<ProviderOutput[]> {
  const key = requireKey(ctx.keys.elevenLabsApiKey, "ElevenLabs", "elevenlabs");
  ctx.onStatus("running", p.model);
  let res: Response;
  try {
    res = await fetch(`https://api.elevenlabs.io/${p.endpoint}`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      signal: ctx.signal,
      body: JSON.stringify(p.native),
    });
  } catch (error) {
    if (ctx.signal.aborted) throw new MediaError("Anulowano", "cancelled");
    throw failureError(classifyException("elevenlabs", error, { phase: "sync" }));
  }
  if (!res.ok)
    throw failureError(
      classifyHttp("elevenlabs", res.status, await res.text(), {
        retryAfter: res.headers.get("retry-after"),
      }),
    );
  return [{ data: Buffer.from(await res.arrayBuffer()), ext: ".mp3" }];
}

// ---------------- entry points ----------------

/** Translate the generic request for one route. Throws MediaError (invalid_input "incompatible: …", model_unavailable, auth). */
export async function prepare(
  req: GenerateRequest,
  model: string,
  keys: Keys,
  signal: AbortSignal,
  kindHint?: string,
): Promise<Prepared> {
  switch (providerOf(model)) {
    case "openai":
      return prepareOpenai(req, model);
    case "google":
      return prepareGoogle(req, model, signal);
    case "elevenlabs":
      return prepareElevenLabs(req, model, keys, signal);
    case "runware":
      return prepareRunware(req, model, toDataUri);
    case "replicate":
      return prepareReplicate(req, model, toDataUri);
    default:
      return prepareFal(req, model, kindHint);
  }
}

/** Submit and wait. Async providers report their handle via ctx.onHandle right after acceptance. */
export async function execute(p: Prepared, ctx: ProviderContext): Promise<ProviderOutput[]> {
  switch (p.provider) {
    case "openai":
      return runOpenai(p, ctx);
    case "google":
      return p.kind === "video"
        ? googleVeoPoll(await googleVeoSubmit(p, ctx), ctx)
        : runGeminiImage(p, ctx);
    case "elevenlabs":
      return runElevenLabs(p, ctx);
    case "runware":
      return runwarePoll(await runwareSubmit(p, ctx), ctx);
    case "replicate":
      return replicatePoll(await replicateSubmit(p, ctx), ctx);
    default:
      return falPoll(await falSubmit(p, ctx), ctx);
  }
}

/** Continue polling a job submitted earlier (after a restart, or to recollect results). */
export async function resume(
  handle: ProviderHandle,
  ctx: ProviderContext,
): Promise<ProviderOutput[]> {
  switch (handle.provider) {
    case "fal":
      return falPoll(handle, ctx);
    case "runware":
      return runwarePoll(handle, ctx);
    case "replicate":
      return replicatePoll(handle, ctx);
    default:
      return googleVeoPoll(handle, ctx);
  }
}

/** Back-compat one-shot: prepare + execute on exactly this model. */
export async function runProvider(
  req: GenerateRequest,
  ctx: ProviderContext,
): Promise<ProviderOutput[]> {
  return execute(await prepare(req, req.model, ctx.keys, ctx.signal), ctx);
}

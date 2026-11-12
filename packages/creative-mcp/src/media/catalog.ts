// Same model, several sellers: dated public list prices per route, and what each route cannot carry.
// Every rate cites the provider's own public page and the day it was read; nothing here is guessed.
// A route with no published rate for an operation quotes usd=null (unknown, needs the user's OK).

import type { GenerateRequest } from "./providers.ts";

export type RouteProvider = "fal" | "runware" | "replicate" | "higgsfield";
type Res = "480p" | "720p" | "1080p";

export interface RouteRate {
  provider: RouteProvider;
  /** model id as media_generate takes it */
  model: string;
  /** USD per output second by resolution (text/image/reference to video) */
  perSecond: Partial<Record<Res, number>>;
  /** USD per output second when a source/reference video is an input */
  videoInPerSecond?: Partial<Record<Res, number>>;
  /** fal style: price × factor, and the input video's seconds are billed too */
  videoInFactor?: number;
  /** native 480p draft that can be finished later */
  drafts: boolean;
  /** USD per second to finish a draft at 1080p; null = not published */
  finishPerSecond?: number | null;
  /** days a draft stays finishable (conservative) */
  draftDays?: number;
  /** false = shown for comparison only (e.g. a prepaid plan used through another app) */
  callable: boolean;
  source: string;
  checked: string;
  note?: string;
}

export interface ModelGroup {
  id: string;
  label: string;
  /** does this model id belong to the group */
  matches: (model: string) => boolean;
  defaultSeconds: number;
  maxSeconds: number;
  routes: RouteRate[];
}

export const SEEDANCE_25: ModelGroup = {
  id: "seedance-2.5",
  label: "Seedance 2.5",
  matches: (m) =>
    m.startsWith("bytedance/seedance-2.5") ||
    m === "runware:bytedance:seedance@2.5" ||
    m === "replicate:bytedance/seedance-2.5",
  defaultSeconds: 5,
  maxSeconds: 30,
  routes: [
    {
      provider: "fal",
      model: "bytedance/seedance-2.5/text-to-video",
      // $0.0214 per 1k tokens (480p/720p), $0.0234 (1080p); fal states the per-second figures.
      perSecond: { "480p": 0.2205, "720p": 0.473, "1080p": 1.164 },
      videoInFactor: 0.6,
      drafts: true,
      finishPerSecond: 1.164,
      draftDays: 7,
      callable: true,
      source: "https://fal.ai/models/bytedance/seedance-2.5/text-to-video/llms.txt",
      checked: "2026-11-05",
      note: "draft/complete: https://fal.ai/models/bytedance/seedance-2.5/draft/complete/llms.txt (1080p only, 14 days, 7 for US drafts; with a source clip ×0.6 over clip + output seconds). The draft price is our assumption: fal bills a draft as a 480p render and publishes no separate draft rate",
    },
    {
      provider: "runware",
      model: "runware:bytedance:seedance@2.5",
      perSecond: { "480p": 0.1025, "720p": 0.2304, "1080p": 0.61354 },
      videoInPerSecond: { "480p": 0.1313, "720p": 0.2953, "1080p": 0.73415 },
      drafts: true,
      // Runware lists no separate finish price; its published 1080p token rate ($12.52 per 1M
      // tokens, 48,600 tokens per 16:9 second) is what a finish is billed at.
      finishPerSecond: 0.6085,
      draftDays: 7,
      callable: true,
      source: "https://runware.ai/docs/models/bytedance-seedance-2-5/schema.json",
      checked: "2026-11-05",
      note: "finish priced at the published 1080p token rate $12.52/M tokens (no separate finish price listed); draft lifetime not published",
    },
    {
      provider: "replicate",
      model: "replicate:bytedance/seedance-2.5",
      perSecond: { "480p": 0.1028, "720p": 0.2312 },
      videoInPerSecond: { "480p": 0.4304, "720p": 0.9676 },
      drafts: false,
      callable: true,
      source: "https://replicate.com/bytedance/seedance-2.5",
      checked: "2026-11-05",
      note: "480p and 720p only, no drafts",
    },
  ],
};

export const GROUPS: ModelGroup[] = [SEEDANCE_25];

export function groupOf(model: string): ModelGroup | undefined {
  return GROUPS.find((g) => g.matches(model));
}

export function routeOf(model: string): RouteRate | undefined {
  const group = groupOf(model);
  if (!group) return undefined;
  const provider: RouteProvider = model.startsWith("runware:")
    ? "runware"
    : model.startsWith("replicate:")
      ? "replicate"
      : "fal";
  return group.routes.find((r) => r.provider === provider);
}

export interface Quote {
  provider: RouteProvider;
  model: string;
  /** expected USD for all takes; null = unknown */
  usd: number | null;
  /** worst case for all takes ("up to"); null = no bound */
  usdMax: number | null;
  /** human rate line, e.g. "$0.2304/s at 720p" */
  rate: string;
  source: string;
  checked: string;
  /** why this route can't take the request (it is then skipped, never silently trimmed) */
  cannotCarry?: string;
  note?: string;
}

const isLocal = (p: string) => !/^(https?:|data:)/.test(p);
const round = (n: number) => Math.round(n * 1000) / 1000;

function wantedResolution(req: GenerateRequest): Res {
  const r = String(req.parameters?.resolution ?? req.input?.resolution ?? "720p").toLowerCase();
  return r === "480p" || r === "1080p" ? r : "720p";
}

/** Seconds asked for; null = the model picks ("auto"), so the price is unknown. */
export function wantedSeconds(req: GenerateRequest, group: ModelGroup): number | null {
  const raw = req.parameters?.duration ?? req.input?.duration;
  if (raw === undefined) return req.finishDraft?.seconds ?? group.defaultSeconds;
  if (raw === "auto" || raw === -1 || raw === "-1") return null;
  const n = Number(String(raw).match(/\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, group.maxSeconds) : group.defaultSeconds;
}

const hasVideoInput = (req: GenerateRequest) =>
  !!req.video ||
  ["video_urls", "reference_video_urls", "video_url"].some((k) => req.input?.[k] !== undefined);

/** What a route cannot take from this request (undefined = it can carry all of it). */
export function cannotCarry(route: RouteRate, req: GenerateRequest): string | undefined {
  if (!route.callable) return "not callable from Open Herness (shown for comparison)";
  const native = Object.keys(req.input ?? {}).filter(
    (k) => !["duration", "resolution"].includes(k),
  );
  const askedProvider = routeOf(req.model)?.provider;
  if (native.length && askedProvider && askedProvider !== route.provider)
    return `native ${askedProvider} fields (${native.join(", ")}) have no ${route.provider} equivalent`;
  const draft = req.parameters?.draft === true;
  if (req.finishDraft && req.finishDraft.provider !== route.provider)
    return `the draft was made on ${req.finishDraft.provider}; only that provider can finish it`;
  if (draft && !route.drafts) return `${route.provider} has no draft mode`;
  const res = wantedResolution(req);
  if (!req.finishDraft && !draft && route.perSecond[res] === undefined)
    return `${route.provider} has no ${res} output`;
  if (route.provider === "runware" || route.provider === "replicate") {
    if (req.video && isLocal(req.video))
      return `a local source video must be uploaded first; ${route.provider} takes video by URL`;
    if (req.parameters?.seed !== undefined && route.provider === "runware")
      return "Runware's Seedance 2.5 schema has no seed input";
  }
  if (route.provider === "replicate" && req.endImage && !req.references?.length)
    return "Replicate needs a first frame with a last frame";
  if (route.provider !== "fal" && (req.references?.length ?? 0) > 1 && req.endImage !== undefined)
    return `${route.provider} cannot mix reference images with a last frame`;
  return undefined;
}

/** Price of one request (all `count` takes) on one route. Pure: no network. */
export function quoteRoute(
  route: RouteRate,
  group: ModelGroup,
  req: GenerateRequest,
  count = 1,
  opts: { inputVideoSeconds?: number } = {},
): Quote {
  const base = {
    provider: route.provider,
    model: route.model,
    source: route.source,
    checked: route.checked,
    ...(route.note ? { note: route.note } : {}),
  };
  const blocked = cannotCarry(route, req);
  const seconds = wantedSeconds(req, group);
  const takes = Math.max(1, count) * Math.max(1, Number(req.parameters?.num_outputs ?? 1));
  let perSecond: number | null | undefined;
  let rate: string;
  if (req.finishDraft) {
    perSecond = route.finishPerSecond;
    rate =
      perSecond === null || perSecond === undefined
        ? `finish at 1080p: price not published (up to $${route.perSecond["1080p"]}/s)`
        : `finish at 1080p: $${perSecond}/s${req.finishDraft.videoInput ? " (draft made from a clip: clip seconds billed too)" : ""}`;
  } else {
    const res: Res = req.parameters?.draft ? "480p" : wantedResolution(req);
    const video = hasVideoInput(req);
    perSecond =
      video && route.videoInPerSecond ? route.videoInPerSecond[res] : route.perSecond[res];
    if (video && route.videoInFactor && perSecond !== undefined)
      perSecond = perSecond * route.videoInFactor;
    rate =
      perSecond === undefined
        ? `no ${res} rate`
        : `$${round(perSecond)}/s at ${res}${req.parameters?.draft ? " (draft)" : ""}${video ? " with video input" : ""}`;
  }
  // Input video seconds are billed too (fal for any run, and for finishing a draft made from a
  // clip; Runware for finishing, billed by tokens over clip + output); unknown = longest input.
  const finishFromClip = !!req.finishDraft?.videoInput;
  if (finishFromClip && perSecond !== null && perSecond !== undefined && route.videoInFactor)
    perSecond = perSecond * route.videoInFactor;
  const inputSeconds = finishFromClip
    ? (req.finishDraft!.inputSeconds ?? null)
    : !req.finishDraft && hasVideoInput(req) && route.videoInFactor
      ? (opts.inputVideoSeconds ?? null)
      : 0;
  const ceiling =
    perSecond ?? (req.finishDraft ? route.perSecond["1080p"] : undefined) ?? undefined;
  const one =
    perSecond === null || perSecond === undefined || seconds === null || inputSeconds === null
      ? null
      : perSecond * (seconds + inputSeconds);
  const worst =
    ceiling === undefined
      ? null
      : ceiling * ((seconds ?? group.maxSeconds) + (inputSeconds ?? group.maxSeconds));
  return {
    ...base,
    usd: one === null ? null : round(one * takes),
    usdMax: worst === null ? null : round(Math.max(worst, one ?? 0) * takes),
    rate,
    ...(blocked ? { cannotCarry: blocked } : {}),
  };
}

/** The request as it would run on another route of the same group. */
export function onRoute(req: GenerateRequest, route: RouteRate): GenerateRequest {
  // A fal sub-route the caller picked (image-to-video, reference-to-video…) stays as asked.
  const keep = route.provider === "fal" && routeOf(req.model)?.provider === "fal";
  return { ...req, model: keep ? req.model : route.model };
}

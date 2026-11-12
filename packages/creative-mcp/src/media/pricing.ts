// Price estimates (USD, always approximate). Sources in order: fal pricing API (with a fal key),
// the dated static table below, the fal model page, else unknown (null, never 0). Multi-provider
// models (Seedance 2.5) are priced per route in catalog.ts; spend limits live in ledger.ts/spend.ts.

import { ohHome } from "../home.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Provider } from "./failures.ts";
import * as ledger from "./ledger.ts";
import * as spend from "./spend.ts";
import { resolutionPixels } from "./schema.ts";

export const PRICES_AS_OF = "2026-10-28";

interface PriceRule {
  unit: "second" | "image" | "video" | "1k_chars" | "megapixel" | "video_megapixel" | "1k_tokens";
  usd: number;
  /** per-second price with audio on (video models that charge more for sound) */
  usdAudio?: number;
  /** resolution label (lowercase) → [usd, usdAudio] or a multiplier */
  byResolution?: Record<string, [number, number] | number>;
  /** fixed price per clip length (Hailuo style) */
  byDuration?: Record<number, number>;
  defaultSeconds?: number;
  /** worst-case multiplier for quality tiers we can't see (e.g. gpt-image quality=high) */
  worstFactor?: number;
  note?: string;
}

// fal prices read from the model pages, Google/OpenAI from their price lists; all dated PRICES_AS_OF.
const STATIC: Record<string, PriceRule> = {
  "fal-ai/veo3.1/fast": {
    unit: "second",
    usd: 0.1,
    usdAudio: 0.15,
    byResolution: { "4k": [0.3, 0.35] },
    defaultSeconds: 8,
  },
  "fal-ai/veo3.1": {
    unit: "second",
    usd: 0.2,
    usdAudio: 0.4,
    byResolution: { "4k": [0.4, 0.6] },
    defaultSeconds: 8,
  },
  // fal bills GPT Image per token ("units" in the API, so the page parser misreads it as $30); estimate
  // for quality=high at ~1 MP from OpenAI's list, +50% worst case for 16 reference images / xhigh.
  "openai/gpt-image-2.5": {
    unit: "image",
    usd: 0.22,
    worstFactor: 1.5,
    byResolution: { "1k": 1, "2k": 2 },
    note: "token-billed; quality=high ~1 MP, estimate",
  },
  "openai/gpt-image-2": {
    unit: "image",
    usd: 0.22,
    worstFactor: 1.5,
    byResolution: { "1k": 1, "2k": 2 },
    note: "token-billed; quality=high ~1 MP, estimate",
  },
  "fal-ai/nano-banana-2": { unit: "image", usd: 0.08, byResolution: { "2k": 1.5, "4k": 2 } },
  "fal-ai/nano-banana-pro": { unit: "image", usd: 0.15, byResolution: { "4k": 2 } },
  "google/nano-banana-2.1": {
    unit: "image",
    usd: 0.04,
    byResolution: { "1k": 1, "2k": 0.059 / 0.04, "4k": 0.134 / 0.04 },
    note: "token-billed; short prompt, medium thinking",
  },
  "minimax/h3-max": {
    unit: "second",
    usd: 0.08,
    byResolution: { "480p": 0.05 / 0.08, "768p": 1, "1080p": 2 },
    defaultSeconds: 5,
    note: "audio included",
  },
  "minimax/h3-max-turbo": {
    unit: "second",
    usd: 0.04,
    byResolution: { "480p": 0.025 / 0.04, "768p": 1, "1080p": 2 },
    defaultSeconds: 5,
    note: "audio included",
  },
  // https://fal.ai/models/fal-ai/topaz/upscale/video/llms.txt (checked 2026-11-05): $0.01/s up to
  // 720p, $0.02/s 720p–1080p, $0.08/s above 1080p output; double at 60 fps.
  "fal-ai/topaz/upscale/video": {
    unit: "second",
    usd: 0.02,
    // resolution = output size; the static rule wins over fal's flat API price
    byResolution: { "720p": 0.5, "1080p": 1, "4k": 4 },
    worstFactor: 4,
    note: "by output size: $0.01 ≤720p, $0.02 ≤1080p, $0.08 above (up to = 4K); ×2 at 60 fps",
  },
  "fal-ai/kling-video/v3/pro": { unit: "second", usd: 0.112, usdAudio: 0.168, defaultSeconds: 5 },
  "fal-ai/minimax/hailuo-2.3/standard": {
    unit: "video",
    usd: 0.28,
    byDuration: { 6: 0.28, 10: 0.56 },
    defaultSeconds: 6,
  },
  "fal-ai/flux-2-pro": {
    unit: "megapixel",
    usd: 0.03,
    worstFactor: 2.5,
    note: "$0.03 first MP + $0.015 per extra MP",
  },
  "google:veo-3.1-fast-generate-preview": {
    unit: "second",
    usd: 0.15,
    defaultSeconds: 8,
    note: "audio always on",
  },
  "google:veo-3.1-generate-preview": {
    unit: "second",
    usd: 0.4,
    defaultSeconds: 8,
    note: "audio always on",
  },
  "google:gemini-3-pro-image": { unit: "image", usd: 0.134, byResolution: { "4k": 0.24 / 0.134 } },
  "google:gemini-3.1-flash-image": {
    unit: "image",
    usd: 0.067,
    byResolution: { "2k": 1.5, "4k": 2 },
    note: "approximate",
  },
  "google:gemini-2.5-flash-image": { unit: "image", usd: 0.039 },
  "openai:gpt-image-1": {
    unit: "image",
    usd: 0.042,
    worstFactor: 4,
    note: "medium quality 1024px; high quality up to ~$0.17",
  },
  "openai:gpt-4o-mini-tts": { unit: "1k_chars", usd: 0.017, note: "≈ $0.015 per minute of audio" },
};

export interface Estimate {
  /** expected USD for all `count` jobs; null = unknown */
  usd: number | null;
  /** worst case (reserved against the spend cap) */
  usdMax: number | null;
  payer: string;
  approximate: true;
  basis: string;
}

const PAYER: Record<Provider, string> = {
  fal: "your fal key",
  openai: "your OpenAI key",
  google: "your Google (Gemini API) key",
  elevenlabs: "your ElevenLabs plan (credits)",
  runware: "your Runware key",
  replicate: "your Replicate token",
};
const SUBROUTE =
  /\/(image-to-video|first-last-frame-to-video|reference-to-video|text-to-video|image-to-image|edit)$/;

const cacheFile = () => ohHome("cache", "pricing.json");
let cache: Record<string, { at: number; rule: PriceRule | null; source: string }> | undefined;
function priceCache() {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
    } catch {
      cache = {};
    }
  }
  return cache!;
}
function remember(id: string, rule: PriceRule | null, source: string) {
  priceCache()[id] = { at: Date.now(), rule, source };
  try {
    mkdirSync(ohHome("cache"), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(cache));
  } catch {
    // best effort
  }
}

function staticRule(id: string): PriceRule | undefined {
  const base = id.replace(SUBROUTE, "");
  return (
    STATIC[id] ?? STATIC[base] ?? Object.entries(STATIC).find(([k]) => id.startsWith(`${k}/`))?.[1]
  );
}

/** Parse fal's pricing sentence ("**$0.10** without audio or **$0.15** with audio", "**$0.08** per image"). */
export function parsePricingText(text: string): PriceRule | null {
  const amounts = [...text.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  if (!amounts.length) return null;
  if (/per (generated )?second|every second/i.test(text)) {
    const audio = /with audio|audio on/i.test(text) && amounts.length > 1 ? amounts[1] : undefined;
    return {
      unit: "second",
      usd: amounts[0]!,
      ...(audio ? { usdAudio: audio } : {}),
      note: "from the fal model page",
    };
  }
  if (/per image|per output/i.test(text))
    return { unit: "image", usd: amounts[0]!, note: "from the fal model page" };
  if (/megapixel/i.test(text))
    return {
      unit: "megapixel",
      usd: amounts[0]!,
      worstFactor: 2.5,
      note: "from the fal model page",
    };
  return {
    unit: "video",
    usd: Math.max(...amounts),
    note: "from the fal model page (per request, worst listed)",
  };
}

async function falLivePrice(
  id: string,
  falKey: string,
): Promise<{ rule: PriceRule; source: string } | null> {
  if (falKey) {
    try {
      const res = await fetch(
        `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(id)}`,
        { headers: { Authorization: `Key ${falKey}` }, signal: AbortSignal.timeout(10_000) },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          prices?: { endpoint_id: string; unit_price: number; unit: string; currency?: string }[];
        };
        const p = data.prices?.find((x) => x.endpoint_id === id) ?? data.prices?.[0];
        // "units" is an opaque billing unit (not per image or per video), so the page price is used instead.
        if (p && p.unit_price > 0 && p.unit !== "units") {
          // Video models bill tokens or megapixels over every output frame (width × height × fps × seconds).
          const video = /to-video|video-to|\/video\b/.test(id);
          if (/token/.test(p.unit)) {
            const per1k = /1000|1k/i.test(p.unit) ? p.unit_price : p.unit_price * 1000;
            return {
              rule: {
                unit: "1k_tokens",
                usd: per1k,
                note: `fal pricing API (${p.unit}); tokens ≈ width × height × 24 fps × seconds / 1024`,
              },
              source: "fal pricing API",
            };
          }
          if (video && /megapixel/.test(p.unit))
            return {
              rule: {
                unit: "video_megapixel",
                usd: p.unit_price,
                note: `fal pricing API (${p.unit} over all output frames, 24 fps assumed)`,
              },
              source: "fal pricing API",
            };
          const unit = /second/.test(p.unit)
            ? "second"
            : /image/.test(p.unit)
              ? "image"
              : /megapixel/.test(p.unit)
                ? "megapixel"
                : "video";
          return {
            rule: { unit, usd: p.unit_price, note: `fal pricing API (${p.unit})` },
            source: "fal pricing API",
          };
        }
      }
    } catch {
      // fall through to the page
    }
  }
  try {
    const res = await fetch(`https://fal.ai/models/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const page = (await res.text()).replace(/\\"/g, '"');
    // The page also carries sibling endpoints' prices: take the text whose nearest preceding endpointId is ours.
    for (
      let i = page.indexOf("pricingInfoOverride");
      i >= 0;
      i = page.indexOf("pricingInfoOverride", i + 1)
    ) {
      const ids = [
        ...page.slice(Math.max(0, i - 4000), i).matchAll(/"(?:endpointId|id)":"([^"]+)"/g),
      ].map((m) => m[1]);
      if (ids.at(-1) !== id) continue;
      const text = page.slice(i + 22, i + 600).split('","')[0] ?? "";
      const rule = parsePricingText(text);
      if (rule) return { rule, source: "fal model page" };
    }
  } catch {
    // unknown
  }
  return null;
}

async function ruleFor(
  id: string,
  provider: Provider,
  falKey: string,
): Promise<{ rule: PriceRule | null; source: string }> {
  const fixed = staticRule(id);
  // A hand-checked entry knows resolution tiers the flat API price lacks, so it wins when present.
  if (fixed?.byResolution) return { rule: fixed, source: `static table ${PRICES_AS_OF}` };
  if (provider === "fal" && (falKey || !fixed)) {
    const cached = priceCache()[id];
    if (cached?.rule && Date.now() - cached.at < 24 * 3600_000) return cached;
    const live = await falLivePrice(id, falKey);
    if (live) {
      remember(id, live.rule, live.source);
      return live;
    }
  }
  return fixed
    ? { rule: fixed, source: `static table ${PRICES_AS_OF}` }
    : { rule: null, source: "unknown" };
}

export interface EstimateInput {
  /** route model / served endpoint (fal sub-route ok) */
  model: string;
  provider: Provider;
  kind: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  audio?: boolean;
  num_outputs?: number;
  count?: number;
}

export async function estimate(e: EstimateInput, falKey = ""): Promise<Estimate> {
  const count = Math.max(1, e.count ?? 1);
  const payer = PAYER[e.provider];
  if (e.provider === "elevenlabs") {
    const chars = e.prompt?.length ?? 0;
    const basis =
      e.kind === "speech"
        ? `ElevenLabs credits: ~${chars} (1 credit/char on multilingual v2, ~0.5 on flash); USD depends on the plan`
        : "ElevenLabs credits; USD depends on the plan";
    return { usd: null, usdMax: null, payer, approximate: true, basis };
  }
  const found = await ruleFor(e.model, e.provider, falKey);
  // A megapixel price on a video job is billed over every output frame.
  const rule =
    found.rule && found.rule.unit === "megapixel" && e.kind === "video"
      ? { ...found.rule, unit: "video_megapixel" as const }
      : found.rule;
  const source = found.source;
  if (!rule)
    return {
      usd: null,
      usdMax: null,
      payer,
      approximate: true,
      basis: `no price found for ${e.model} - check its pricing page before running`,
    };
  const outputs = Math.max(1, e.num_outputs ?? 1);
  const res = e.resolution?.toLowerCase();
  let one: number;
  let worst: number;
  if (rule.unit === "second") {
    const seconds = e.duration ?? rule.defaultSeconds ?? 8;
    const tier = res ? rule.byResolution?.[res] : undefined;
    const [base, withAudio] = Array.isArray(tier)
      ? tier
      : [
          rule.usd * (typeof tier === "number" ? tier : 1),
          (rule.usdAudio ?? rule.usd) * (typeof tier === "number" ? tier : 1),
        ];
    const perSecond = e.audio === false ? base : withAudio; // most audio models default to audio on
    one = perSecond * seconds;
    worst = Math.max(base, withAudio) * seconds;
  } else if (rule.unit === "video") {
    const seconds = e.duration ?? rule.defaultSeconds ?? 0;
    const options = Object.entries(rule.byDuration ?? {}).map(
      ([s, usd]) => [Number(s), usd] as const,
    );
    one = options.length ? (options.find(([s]) => s >= seconds) ?? options.at(-1)!)[1] : rule.usd;
    worst = one;
  } else if (rule.unit === "video_megapixel" || rule.unit === "1k_tokens") {
    const seconds = e.duration ?? rule.defaultSeconds ?? 5;
    const height = res ? resolutionPixels(res) : 720;
    const pixels = (Number.isFinite(height) && height > 0 ? height : 720) ** 2 * (16 / 9);
    const frames = 24 * seconds;
    one =
      rule.unit === "1k_tokens"
        ? (rule.usd * pixels * frames) / 1024 / 1000
        : (rule.usd * pixels * frames) / 1e6;
    worst = one * 1.25;
  } else if (rule.unit === "1k_chars") {
    one = ((e.prompt?.length ?? 1000) / 1000) * rule.usd;
    worst = one;
  } else {
    const tier = res ? rule.byResolution?.[res] : undefined;
    one = rule.usd * (typeof tier === "number" ? tier : 1) * outputs;
    worst = one;
  }
  worst = Math.max(one, worst) * (rule.worstFactor ?? 1);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    usd: round(one * count),
    usdMax: round(worst * count),
    payer,
    approximate: true,
    basis: `${rule.unit === "second" ? `$${rule.usd}${rule.usdAudio ? `/$${rule.usdAudio} with audio` : ""} per second` : `$${rule.usd} per ${rule.unit}`}${rule.note ? ` (${rule.note})` : ""}; source: ${source}`,
  };
}

/** Daily cap (OH_SPEND_CAP_USD) and today's spend; the ledger itself lives in ledger.ts. */
export { dailyCap as spendCap } from "./spend.ts";
export { spentToday } from "./ledger.ts";

/** Reserve a paid call that is not a media job (VLM judges, media_watch) against the caps. */
export function reserve(key: string, est: Estimate, allowUnpriced = false) {
  const chat = spend.chatId();
  const refusal = ledger.reserveAll(
    [{ key, payer: est.payer, estimateUsd: est.usd, maxUsd: est.usdMax }],
    chat,
    spend.caps(chat),
    { allowUnpriced },
  );
  if (refusal) throw ledger.refusalError(refusal, 1);
}

/** spent with the amount actually used (calls made × price), or released when nothing ran. */
export function settle(key: string, outcome: "spent" | "released", usd?: number | null) {
  ledger.settle(
    key,
    outcome,
    outcome === "spent" && typeof usd === "number" ? { usd, source: "measured" } : undefined,
  );
}

// Which provider runs a request. Every route that sells the same model is priced; with the
// default policy the cheapest route that has a key and can carry the request goes first, the rest
// stay as fallbacks (used only when a route refuses before accepting). Routes without a key or
// that can't carry the request are listed with the reason, never silently changed.

import * as NodeFS from "node:fs";
import { ohHome } from "../home.ts";
import { groupOf, onRoute, quoteRoute, type Quote } from "./catalog.ts";
import { activeCooldown, type Provider } from "./failures.ts";
import * as pricing from "./pricing.ts";
import {
  EQUIVALENT_ROUTES,
  equivalentGroup,
  KEY_OF,
  PAYER,
  providerOf,
  routeCandidates,
  type GenerateRequest,
  type Keys,
} from "./providers.ts";

export type RoutePolicy = "cheapest" | "pinned" | "quality";

export interface RankedRoute {
  provider: Provider;
  model: string;
  request: GenerateRequest;
  quote: Quote | null;
  estimate: pricing.Estimate;
  hasKey: boolean;
  /** why this route will not be tried (no key, cannot carry, cooling down) */
  skip?: string;
}

interface OrderFile {
  policy?: RoutePolicy;
  /** model group id (e.g. "seedance-2.5", "veo-3.1-fast") → provider */
  pins?: Record<string, string>;
}

export function orderFile(): OrderFile {
  try {
    return JSON.parse(
      NodeFS.readFileSync(ohHome("media", "provider-order.json"), "utf8"),
    ) as OrderFile;
  } catch {
    return {};
  }
}

const groupKey = (model: string) =>
  groupOf(model)?.id ?? equivalentGroup(model)?.label.toLowerCase().replace(/\W+/g, "-");

/** Routes for a model, with prices: catalog groups, equivalent fal/Google pairs, or just the model. */
async function candidates(req: GenerateRequest, keys: Keys): Promise<RankedRoute[]> {
  const group = groupOf(req.model);
  if (group)
    return group.routes.map((route) => {
      const quote = quoteRoute(
        route,
        group,
        req,
        1,
        req.inputSeconds !== undefined ? { inputVideoSeconds: req.inputSeconds } : {},
      );
      const provider = route.provider as Provider;
      const r = onRoute(req, route);
      return {
        provider,
        model: r.model,
        request: r,
        quote,
        estimate: {
          usd: quote.usd,
          usdMax: quote.usdMax,
          payer: PAYER[provider],
          approximate: true,
          basis: `${quote.rate}; source: ${quote.source} (checked ${quote.checked})${quote.note ? `; ${quote.note}` : ""}`,
        },
        hasKey: !!keys[KEY_OF[provider]],
        ...(quote.cannotCarry ? { skip: quote.cannotCarry } : {}),
      };
    });
  const models = routeCandidates(req.model, "auto");
  return Promise.all(
    models.map(async (model) => {
      const provider = providerOf(model);
      const p = req.parameters ?? {};
      const estimate = await pricing.estimate(
        {
          model,
          provider,
          kind: req.meterSeconds !== undefined || /veo|video/.test(model) ? "video" : "image",
          ...(req.prompt ? { prompt: req.prompt } : {}),
          ...((p.duration ?? req.meterSeconds) !== undefined
            ? { duration: (p.duration ?? req.meterSeconds)! }
            : {}),
          ...(p.resolution ? { resolution: p.resolution } : {}),
          ...(p.audio !== undefined ? { audio: p.audio } : {}),
          ...(p.num_outputs ? { num_outputs: p.num_outputs } : {}),
        },
        keys.falApiKey,
      );
      const native = Object.keys(req.input ?? {});
      return {
        provider,
        model,
        request: { ...req, model },
        quote: null,
        estimate,
        hasKey: !!keys[KEY_OF[provider]],
        ...(native.length && model !== req.model
          ? {
              skip: `native ${providerOf(req.model)} fields (${native.join(", ")}) don't carry over`,
            }
          : {}),
      };
    }),
  );
}

const cost = (r: RankedRoute) => r.estimate.usdMax ?? r.estimate.usd ?? Number.POSITIVE_INFINITY;

/**
 * Ranked routes for a request. route: "exact" = only this model; a provider name pins that provider;
 * "quality" keeps the model's own provider first; "auto"/"cheapest" (default) sorts by worst-case
 * price. A pin in provider-order.json applies to auto. Routes to skip come last with their reason.
 */
export async function rankRoutes(
  req: GenerateRequest,
  keys: Keys,
  route = req.route ?? "auto",
): Promise<{ policy: RoutePolicy; routes: RankedRoute[] }> {
  const all = await candidates(req, keys);
  const own = all.find((r) => r.model === req.model) ?? all[0]!;
  const providerNames = ["fal", "google", "runware", "replicate", "openai", "elevenlabs"];
  if (providerNames.includes(route) && !all.some((r) => r.provider === route)) {
    // A pin is never ignored quietly: nothing runs, and the reason says why.
    for (const r of all)
      r.skip = `route "${route}" was asked for, but ${route} does not sell ${req.model}`;
    return { policy: "pinned", routes: all };
  }
  const file = orderFile();
  const pin = file.pins?.[groupKey(req.model) ?? ""];
  let policy: RoutePolicy = route === "quality" ? "quality" : (file.policy ?? "cheapest");
  let ordered: RankedRoute[];
  if (route === "exact") {
    ordered = [own];
    policy = "pinned";
  } else if (all.some((r) => r.provider === route) || (route === "auto" && pin)) {
    const provider = route === "auto" ? pin : route;
    ordered = all.filter((r) => r.provider === provider);
    if (!ordered.length) ordered = [own];
    policy = "pinned";
  } else if (policy === "quality") {
    ordered = [own, ...all.filter((r) => r !== own).sort((a, b) => cost(a) - cost(b))];
  } else ordered = [...all].sort((a, b) => cost(a) - cost(b));
  for (const r of ordered) {
    if (r.skip) continue;
    if (!r.hasKey) r.skip = `no ${r.provider} key (media_set_key ${r.provider})`;
    else {
      const c = activeCooldown(r.provider, r.model, keys[KEY_OF[r.provider]]);
      if (c) r.skip = `cooling down after ${c.category}`;
    }
  }
  const usable = ordered.filter((r) => !r.skip);
  const skipped = all.filter((r) => !usable.includes(r));
  for (const r of skipped) if (!r.skip) r.skip = "not in this route policy";
  return { policy, routes: [...usable, ...skipped] };
}

/** Text lines for media_estimate: every route with its price, the chosen one first. */
export function describeRoutes(routes: RankedRoute[], count: number): string[] {
  const money = (n: number | null) => (n === null ? "?" : `$${n.toFixed(2)}`);
  return routes.map((r, i) => {
    const e = r.estimate;
    const price =
      e.usd === null
        ? e.usdMax === null
          ? "price unknown"
          : `up to ${money(e.usdMax)}`
        : `${money(e.usd)}${e.usdMax !== null && e.usdMax !== e.usd ? ` (up to ${money(e.usdMax)})` : ""}`;
    const tag = r.skip ? `skipped: ${r.skip}` : i === 0 ? "chosen" : "fallback";
    return `${i === 0 && !r.skip ? "→" : " "} ${r.provider} ${r.model}: ${price} for ${count} take(s), ${e.payer} [${tag}]. ${e.basis}`;
  });
}

export const ROUTE_NAMES = [
  "auto",
  "cheapest",
  "quality",
  "exact",
  "fal",
  "google",
  "runware",
  "replicate",
] as const;
export const EQUIVALENT_LABELS = EQUIVALENT_ROUTES.map((g) => g.label);

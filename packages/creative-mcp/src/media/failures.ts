// Failure taxonomy for media providers: every HTTP error, provider-reported failure or exception
// becomes { category, accepted, retryable } plus a short message for the user and a hint for the agent.
//
// "accepted" is the line that decides fallback and automatic retries (pinned here, tested in media2):
//   fal          accepted once the queue submit returned a request_id
//   Google Veo   accepted once predictLongRunning returned an operation name
//   sync calls   (OpenAI, Gemini image, ElevenLabs) accepted on 2xx; a connection reset after the
//                request was sent is "ambiguous" and counts as accepted (it may have been charged)
// Not accepted → safe to retry (capacity/outage) or fall back to an equivalent route.
// Accepted → never auto-retried and never sent elsewhere (could double-charge).

import { createHash } from "node:crypto";

export type FailureCategory =
  | "auth"
  | "billing"
  | "capacity"
  | "outage"
  | "moderation"
  | "invalid_input"
  | "model_unavailable"
  | "ambiguous";
export type Provider = "fal" | "openai" | "google" | "elevenlabs" | "runware" | "replicate";

export interface Failure {
  category: FailureCategory;
  accepted: boolean;
  retryable: boolean;
  provider: Provider | "local";
  /** short, user-facing */
  message: string;
  /** what the agent should do next */
  hint: string;
  status?: number;
  retryAfterMs?: number;
  /** first ~600 chars of the provider's answer, for debugging */
  detail?: string;
}

/** Legacy codes kept for job records / callers that switch on them. */
export type MediaErrorCode =
  | "missing_key"
  | "bad_request"
  | "provider_error"
  | "timeout"
  | "cancelled";

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly hint: string | undefined;
  readonly failure: Failure | undefined;
  constructor(message: string, code: MediaErrorCode, hint?: string, failure?: Failure) {
    super(message);
    this.code = code;
    this.hint = hint ?? failure?.hint;
    this.failure = failure;
  }
}

const KEY_PAGES: Record<Provider, { key: string; billing: string }> = {
  fal: { key: "fal.ai key (FAL_KEY)", billing: "https://fal.ai/dashboard/billing" },
  google: {
    key: "Google AI / Gemini key (GEMINI_API_KEY)",
    billing: "https://aistudio.google.com/ (Billing / plan)",
  },
  openai: {
    key: "OpenAI key (OPENAI_API_KEY)",
    billing: "https://platform.openai.com/settings/organization/billing",
  },
  elevenlabs: {
    key: "ElevenLabs key (ELEVENLABS_API_KEY)",
    billing: "https://elevenlabs.io/app/subscription",
  },
  runware: { key: "Runware key (RUNWARE_API_KEY)", billing: "https://my.runware.ai/" },
  replicate: {
    key: "Replicate token (REPLICATE_API_TOKEN)",
    billing: "https://replicate.com/account/billing",
  },
};

export const CATEGORY_DEFAULTS: Record<
  FailureCategory,
  { retryable: boolean; message: string; hint: (p: Provider | "local") => string }
> = {
  auth: {
    retryable: false,
    message: "The API key was rejected.",
    hint: (p) =>
      `The ${p === "local" ? "" : KEY_PAGES[p].key + " "}is missing, wrong or revoked. Ask the user for a valid key (store it with media_set_key) or use another provider/local route. Don't retry with the same key.`,
  },
  billing: {
    retryable: false,
    message: "The account has no credit or quota left.",
    hint: (p) =>
      `Tell the user their ${p === "local" ? "provider" : KEY_PAGES[p].key} is out of credit/quota${p === "local" ? "" : ` (top up / check plan: ${KEY_PAGES[p].billing})`}. Offer a cheaper model (media_estimate) or a local route (Blender render, EffectCraft, speak_local). Don't retry until they confirm.`,
  },
  capacity: {
    retryable: true,
    message: "The provider is busy or rate-limited.",
    hint: () => "Already retried with backoff. Wait a minute and try again, or pick another model.",
  },
  outage: {
    retryable: true,
    message: "The provider had a server error or could not be reached.",
    hint: () =>
      "Already retried with backoff. Try again in a few minutes or switch to another model/provider.",
  },
  moderation: {
    retryable: false,
    message: "The provider's safety filter refused this request.",
    hint: () =>
      "You may retry ONCE: reword the prompt (remove or soften the element that likely triggered it - real people, minors, violence, nudity, brands) or try another model. Never disable or lower safety settings (safety_tolerance, enable_safety_checker). If it is refused again, stop and tell the user.",
  },
  invalid_input: {
    retryable: false,
    message: "The provider rejected the input.",
    hint: () =>
      "Fix the parameters (check media_model_schema for allowed values) and resubmit. Don't switch models for this.",
  },
  model_unavailable: {
    retryable: false,
    message: "This model/endpoint is not available (retired, renamed or not enabled for this key).",
    hint: () => "Pick a current model with media_models (search) and resubmit.",
  },
  ambiguous: {
    retryable: false,
    message: "The request may or may not have gone through (it may have been charged).",
    hint: () =>
      "Check jobs_status {collect:true} first. Only resubmit (fresh=true) after telling the user it might cost twice.",
  },
};

export function makeFailure(
  category: FailureCategory,
  provider: Provider | "local",
  extra: Partial<Failure> = {},
): Failure {
  const d = CATEGORY_DEFAULTS[category];
  return {
    category,
    accepted: false,
    retryable: d.retryable,
    provider,
    message: d.message,
    hint: d.hint(provider),
    ...extra,
  };
}

export function failureError(f: Failure): MediaError {
  const code: MediaErrorCode =
    f.category === "auth"
      ? "missing_key"
      : f.category === "invalid_input"
        ? "bad_request"
        : "provider_error";
  return new MediaError(
    `${f.message}${f.detail ? ` (${f.provider}${f.status ? ` ${f.status}` : ""}: ${f.detail.slice(0, 300)})` : ""}`,
    code,
    f.hint,
    f,
  );
}

const MODERATION_RE =
  /(content[ _-]?policy|safety|moderation|nsfw|flagged|prohibited|blocked|responsible ?ai|rai[A-Z_]|unsafe|harmful|sexual|violat|celebrity|public figure|minor|blocklist|IMAGE_SAFETY|PROHIBITED_CONTENT|SPII|RECITATION)/i;
/** pydantic/fal-style field validation errors: treated as invalid_input even if a field name says "safety". */
const VALIDATION_RE =
  /("loc"\s*:|Input should be|field required|value_error|literal_error|type_error|less than or equal|greater than or equal)/i;
const STRONG_MODERATION_RE =
  /(content[ _-]?policy|moderation|nsfw|flagged|has_nsfw|responsible ?ai|raiMedia|IMAGE_SAFETY|PROHIBITED_CONTENT|blocked by|safety (system|filter|checker)|violat)/i;
const BILLING_RE =
  /(exhausted balance|insufficient[ _](funds|quota|balance|credits?)|quota[ _]exceeded|quota_exceeded|out of credits|payment required|billing|check your plan|credit balance|user is locked|top[ -]?up|subscription)/i;
const UNAVAILABLE_RE =
  /(model .*not found|not found|does not exist|no longer (available|supported)|deprecated|decommissioned|unknown model|is not supported for|unsupported model|not enabled|model_not_found|application .* not found)/i;
const CAPACITY_RE =
  /(rate.?limit|too many (concurrent )?requests|overloaded|resource[ _]exhausted|capacity|system_busy|try again later|concurrent)/i;

/** Retry-After as seconds or an HTTP date → ms. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Classify an HTTP error response (status + body text) from a provider. */
export function classifyHttp(
  provider: Provider,
  status: number,
  body: string,
  opts: { accepted?: boolean; retryAfter?: string | null } = {},
): Failure {
  const detail = body.slice(0, 600);
  const accepted = opts.accepted ?? false;
  const retryAfterMs = parseRetryAfter(opts.retryAfter);
  const base = {
    status,
    detail,
    accepted,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  let category: FailureCategory;
  if (status === 402) category = "billing";
  else if (status === 401 || status === 403) category = BILLING_RE.test(body) ? "billing" : "auth";
  else if (status === 429)
    category = BILLING_RE.test(body) && !/per.?minute|rate/i.test(body) ? "billing" : "capacity";
  else if (status === 404 || status === 410) category = "model_unavailable";
  else if (status === 400 || status === 422 || status === 413) {
    if (STRONG_MODERATION_RE.test(body) || (!VALIDATION_RE.test(body) && MODERATION_RE.test(body)))
      category = "moderation";
    else if (VALIDATION_RE.test(body)) category = "invalid_input";
    else if (UNAVAILABLE_RE.test(body) && /model|endpoint|application/i.test(body))
      category = "model_unavailable";
    else if (/api key not valid|invalid api key|API_KEY_INVALID/i.test(body)) category = "auth";
    else if (BILLING_RE.test(body) && /billing|quota|credit/i.test(body)) category = "billing";
    else category = "invalid_input";
  } else if (status === 503 || status === 529)
    category = CAPACITY_RE.test(body) ? "capacity" : "outage";
  else if (status >= 500) category = "outage";
  else category = "ambiguous";
  const f = makeFailure(category, provider, base);
  // Once the provider took the job, nothing is auto-retried.
  if (accepted) f.retryable = false;
  return f;
}

/** Classify a provider-reported failure that came back inside a 200 (fal FAILED, Veo op.error, Gemini blockReason...). */
export function classifyReported(provider: Provider, text: string, accepted = true): Failure {
  const detail = text.slice(0, 600);
  let category: FailureCategory = "ambiguous";
  if (MODERATION_RE.test(text)) category = "moderation";
  else if (BILLING_RE.test(text)) category = "billing";
  else if (
    /INVALID_ARGUMENT|invalid|validation|unprocessable|must be|not allowed|unsupported/i.test(text)
  )
    category = "invalid_input";
  else if (CAPACITY_RE.test(text)) category = "capacity";
  else if (/internal|server error|UNAVAILABLE|timeout|timed out/i.test(text)) category = "outage";
  const f = makeFailure(category, provider, { detail, accepted });
  if (accepted) f.retryable = false;
  return f;
}

/** Classify a thrown exception (network errors, aborts, our own MediaErrors). */
export function classifyException(
  provider: Provider,
  error: unknown,
  opts: { phase: "submit" | "poll" | "result" | "download" | "sync" },
): Failure {
  if (error instanceof MediaError && error.failure) return error.failure;
  const err = error as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = err?.cause?.code ?? "";
  const msg = `${err?.message ?? String(error)} ${code} ${err?.cause?.message ?? ""}`.trim();
  if (error instanceof MediaError) {
    const cat: FailureCategory =
      error.code === "missing_key"
        ? "auth"
        : error.code === "bad_request"
          ? "invalid_input"
          : "ambiguous";
    return makeFailure(cat, provider, {
      detail: error.message,
      accepted: cat === "ambiguous" && opts.phase !== "submit",
    });
  }
  // Connection never established → certainly not accepted.
  const notSent =
    /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|CERT|UND_ERR_CONNECT/i.test(msg);
  if (opts.phase === "submit" || opts.phase === "sync") {
    if (notSent) return makeFailure("outage", provider, { detail: msg.slice(0, 300) });
    return makeFailure("ambiguous", provider, { detail: msg.slice(0, 300), accepted: true });
  }
  // Poll/result/download: the job exists at the provider; transport trouble is transient.
  return makeFailure(
    notSent || /ECONNRESET|ETIMEDOUT|socket|fetch failed|terminated|UND_ERR/i.test(msg)
      ? "outage"
      : "ambiguous",
    provider,
    { detail: msg.slice(0, 300), accepted: true, retryable: false },
  );
}

// ---------------- retry with jittered backoff ----------------

export const RETRY = { maxRetries: 2, baseMs: 4000, capMs: 120_000 };

/** Delay before retry number `attempt` (0-based): honours Retry-After, else exponential with jitter, capped at 2 min. */
export function backoffMs(attempt: number, failure?: Failure): number {
  if (failure?.retryAfterMs !== undefined)
    return Math.min(RETRY.capMs, failure.retryAfterMs + Math.random() * 500);
  const exp = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

// ---------------- cooldowns ----------------
// billing 10 min (whole provider), model_unavailable 60 min (that endpoint), outage 2 min (provider),
// auth until the key changes (we remember a hash of the rejected key).

interface Cooldown {
  until: number;
  category: FailureCategory;
  keyHash?: string;
  message: string;
}

const cooldowns = new Map<string, Cooldown>();
const COOLDOWN_MS: Partial<Record<FailureCategory, number>> = {
  billing: 10 * 60_000,
  model_unavailable: 60 * 60_000,
  outage: 2 * 60_000,
};

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

export function noteCooldown(f: Failure, provider: Provider, model: string, key: string) {
  if (f.accepted) return;
  if (f.category === "auth")
    cooldowns.set(provider, {
      until: Infinity,
      category: "auth",
      keyHash: keyHash(key),
      message: f.message,
    });
  else if (f.category === "model_unavailable")
    cooldowns.set(`${provider}:${model}`, {
      until: Date.now() + COOLDOWN_MS.model_unavailable!,
      category: f.category,
      message: f.message,
    });
  else if (f.category === "billing" || f.category === "outage")
    cooldowns.set(provider, {
      until: Date.now() + COOLDOWN_MS[f.category]!,
      category: f.category,
      message: f.message,
    });
}

/** Active cooldown for a provider/model, if any. Auth cooldowns lift as soon as the key changes. */
export function activeCooldown(
  provider: Provider,
  model: string,
  key: string,
): (Cooldown & { scope: string }) | undefined {
  for (const scope of [`${provider}:${model}`, provider]) {
    const c = cooldowns.get(scope);
    if (!c) continue;
    if (c.category === "auth" ? c.keyHash !== keyHash(key) : c.until < Date.now()) {
      cooldowns.delete(scope);
      continue;
    }
    return { ...c, scope };
  }
  return undefined;
}

/** Active cooldowns; keyOf gives the current key per provider so lifted auth cooldowns are hidden. */
export function listCooldowns(keyOf: (provider: string) => string = () => "") {
  return [...cooldowns.entries()]
    .filter(([scope, c]) =>
      c.category === "auth"
        ? c.keyHash === keyHash(keyOf(scope.split(":")[0]!))
        : c.until > Date.now(),
    )
    .map(
      ([scope, c]) =>
        `${scope}: ${c.category}${c.until === Infinity ? " (until the key changes)" : ` for ${Math.ceil((c.until - Date.now()) / 60_000)} more min`}`,
    );
}

export function clearCooldowns() {
  cooldowns.clear();
}

// One paid submission = one batch: priced as a whole (every take, every request), approved by the
// user when it is above the ask-before limit, reserved against the caps all at once (or not at
// all), then submitted together. A single media_generate call is a batch of one.

import * as NodeCrypto from "node:crypto";
import * as jobs from "./jobs.ts";
import * as ledger from "./ledger.ts";
import { loadKeys, type GenerateRequest } from "./providers.ts";
import { rankRoutes, type RankedRoute } from "./route.ts";
import * as spend from "./spend.ts";

export interface BatchItem {
  request: GenerateRequest;
  kind: string;
  title?: string;
  /** takes of this request (each is its own job) */
  count?: number;
  requestId?: string;
  cast?: unknown[];
  /** the failed job this one retries */
  retryOf?: string;
}

export interface ItemQuote {
  item: BatchItem;
  count: number;
  routes: RankedRoute[];
  /** the route that will run (first usable) */
  chosen: RankedRoute | undefined;
  /** expected: the chosen route */
  usd: number | null;
  /** worst case: the dearest route it may fall back to (null = unbounded) */
  usdMax: number | null;
  /** per take: no route dearer than this may run it (set on the jobs) */
  ceiling: number | null;
}

export interface BatchQuoteResult {
  items: ItemQuote[];
  usd: number | null;
  usdMax: number | null;
  payers: string[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const times = (n: number | null, k: number) => (n === null ? null : round(n * k));
const sum = (xs: (number | null)[]) =>
  xs.some((x) => x === null) ? null : round(xs.reduce((s, x) => s! + x!, 0)!);

export async function quoteBatch(items: BatchItem[]): Promise<BatchQuoteResult> {
  const keys = loadKeys();
  const quoted: ItemQuote[] = [];
  for (const item of items) {
    const count = Math.max(1, item.count ?? 1);
    const { routes } = await rankRoutes(item.request, keys);
    const usable = routes.filter((r) => !r.skip);
    const chosen = usable[0] ?? routes.find((r) => r.model === item.request.model);
    // A fallback may run on a dearer route, so the worst case is the dearest usable one.
    const maxes = (usable.length ? usable : chosen ? [chosen] : []).map((r) => r.estimate.usdMax);
    const ceiling =
      !maxes.length || maxes.some((m) => m === null) ? null : Math.max(...(maxes as number[]));
    quoted.push({
      item,
      count,
      routes,
      chosen,
      usd: chosen ? times(chosen.estimate.usd, count) : null,
      usdMax: times(ceiling, count),
      ceiling,
    });
  }
  return {
    items: quoted,
    usd: sum(quoted.map((q) => q.usd)),
    usdMax: sum(quoted.map((q) => q.usdMax)),
    payers: [...new Set(quoted.flatMap((q) => (q.chosen ? [q.chosen.estimate.payer] : [])))],
  };
}

/** What an approval is bound to: every request, the route that runs it and the price shown. */
export const fingerprintOf = (quote: BatchQuoteResult) =>
  spend.batchFingerprint([
    quote.items.map((q) => ({
      r: q.item.request,
      n: q.count,
      k: q.item.kind,
      c: q.item.cast ?? null,
      route: q.chosen?.model ?? null,
      usd: q.usd,
      max: q.usdMax,
    })),
  ]);

export type BatchResult =
  | {
      status: "approval_required";
      quote: BatchQuoteResult;
      approval: spend.Approval;
      card: ReturnType<typeof spend.approvalCard>;
    }
  | { status: "refused"; quote: BatchQuoteResult; message: string; hint: string }
  | { status: "invalid"; message: string }
  | {
      status: "submitted";
      quote: BatchQuoteResult;
      jobs: { job: jobs.MediaJob; reused: boolean }[];
      note?: string;
    };

export function itemLabel(q: ItemQuote) {
  const r = q.item.request;
  const p = r.parameters ?? {};
  const bits = [
    q.count > 1 ? `${q.count}×` : "",
    r.finishDraft ? "finish draft" : p.draft ? "draft" : "",
    q.chosen?.model ?? r.model,
    p.duration ? `${p.duration}s` : r.meterSeconds ? `${r.meterSeconds}s` : "",
    p.draft ? "480p" : (p.resolution ?? ""),
    q.item.title ? `"${q.item.title}"` : "",
  ];
  return bits.filter(Boolean).join(" ");
}

/**
 * Price → approval (above the ask-before limit) → reserve every take against the caps or none →
 * submit. Takes after the first of the same request are fresh jobs (never deduplicated).
 */
export async function submitBatch(
  items: BatchItem[],
  opts: {
    projectPath: string;
    approvalId?: string;
    fresh?: boolean;
    allowUnpriced?: boolean;
    title?: string;
    /** an unknown price needs the user's OK even when its "up to" bound is under the limit */
    askIfUnpriced?: boolean;
  },
): Promise<BatchResult> {
  const quote = await quoteBatch(items);
  // No route that has a key and can carry the request: nothing can run, so don't ask to pay.
  const stuck = quote.items.find((q) => q.routes.every((r) => r.skip));
  if (stuck)
    return {
      status: "invalid",
      message: `No route can run ${stuck.item.request.model} now: ${stuck.routes.map((r) => `${r.provider}: ${r.skip}`).join("; ")}. Nothing was submitted. Ask the user for a key (media_set_key), or offer another model / a local route.`,
    };
  const fp = fingerprintOf(quote);
  let note: string | undefined;
  const chat = spend.chatId();
  // The limit counts this batch together with what the chat spent without approval since the last
  // approval, so splitting a batch into small calls still asks.
  const unapproved = ledger.unapprovedInChat(chat, spend.lastApprovalAt(chat));
  let approvalId: string | undefined;
  if (
    spend.needsApproval(quote, spend.settings().askAboveUsd, unapproved) ||
    (opts.askIfUnpriced && quote.usd === null)
  ) {
    if (!opts.approvalId) {
      const approval = spend.issueApproval(
        fp,
        quote,
        [
          ...quote.items.map((q) => ({ label: itemLabel(q), usd: q.usd })),
          ...(unapproved.usd > 0 || unapproved.unknown
            ? [
                {
                  label: "already spent in this chat since the last approval",
                  usd: unapproved.unknown ? null : unapproved.usd,
                },
              ]
            : []),
        ],
        quote.payers.join(" + ") || "unknown",
        opts.title,
      );
      return { status: "approval_required", quote, approval, card: spend.approvalCard(approval) };
    }
    const used = spend.useApproval(opts.approvalId, fp, quote, ledger.approvalUsed);
    if (!used.ok) return { status: "invalid", message: used.reason };
    approvalId = opts.approvalId;
  }
  const slots = quote.items.flatMap((q) =>
    Array.from({ length: q.count }, () => ({
      key: `slot-${NodeCrypto.randomUUID().slice(0, 12)}`,
      ...(approvalId ? { approvalId } : {}),
      ...(q.chosen
        ? { provider: q.chosen.provider, model: q.chosen.model, payer: q.chosen.estimate.payer }
        : {}),
      estimateUsd: q.chosen?.estimate.usd ?? null,
      maxUsd: q.ceiling,
    })),
  );
  const refusal = ledger.reserveAll(
    slots,
    chat,
    spend.caps(chat),
    opts.allowUnpriced ? { allowUnpriced: true } : {},
  );
  if (refusal) {
    const err = ledger.refusalError(refusal, slots.length);
    return { status: "refused", quote, message: err.message, hint: err.hint ?? "" };
  }
  const submitted: { job: jobs.MediaJob; reused: boolean }[] = [];
  let slot = 0;
  try {
    for (const q of quote.items) {
      for (let take = 0; take < q.count; take++) {
        const key = slots[slot++]!.key;
        const { job, reused } = jobs.submit(q.item.request, {
          projectPath: opts.projectPath,
          kind: q.item.kind,
          fresh: (opts.fresh ?? false) || take > 0,
          reservationKey: key,
          chatId: chat,
          priceCeiling: q.ceiling,
          ...(approvalId ? { approvalId } : {}),
          ...(q.item.retryOf ? { retryOf: q.item.retryOf } : {}),
          ...(q.item.title ? { title: q.item.title } : {}),
          ...(q.item.requestId
            ? { requestId: q.count > 1 ? `${q.item.requestId}-t${take + 1}` : q.item.requestId }
            : {}),
          ...(opts.allowUnpriced ? { allowUnpriced: true } : {}),
          ...(q.item.cast?.length ? { cast: q.item.cast } : {}),
        });
        // A reused job costs nothing new: its slot's room returns.
        if (reused) ledger.release(key);
        submitted.push({ job, reused });
      }
    }
  } catch (error) {
    for (const s of slots.slice(slot)) ledger.release(s.key);
    if (!submitted.length) {
      for (const s of slots.slice(0, slot)) ledger.release(s.key);
      return { status: "invalid", message: (error as Error).message };
    }
    note = `${note ? `${note}; ` : ""}stopped after ${submitted.length} take(s): ${(error as Error).message}`;
  }
  return { status: "submitted", quote, jobs: submitted, ...(note ? { note } : {}) };
}

export function money(usd: number | null, max: number | null = usd) {
  if (usd === null) return max === null ? "price unknown" : `up to $${max.toFixed(2)}`;
  return `$${usd.toFixed(2)}${max !== null && max > usd + 0.005 ? ` (up to $${max.toFixed(2)})` : ""}`;
}

/** Agent-facing text for a batch that was not submitted. */
export function explain(result: Exclude<BatchResult, { status: "submitted" }>): string {
  if (result.status === "invalid") return result.message;
  if (result.status === "refused") return `${result.message}\nhint: ${result.hint}`;
  const q = result.quote;
  return [
    `APPROVAL_REQUIRED: this batch costs ${money(q.usd, q.usdMax)}; with this chat's unapproved spend it is above the ask-before limit ($${spend.settings().askAboveUsd}), or its price is unknown. Nothing was submitted.`,
    "Ask the user with AskUserQuestion using exactly this card (same question text and labels, no option marked recommended), then call again with approval_id after they pick Approve. Only that card counts:",
    JSON.stringify(result.card),
    `approval_id: ${result.approval.id}`,
  ].join("\n");
}

/** The request that finishes a draft job's take at 1080p on the provider that made it. */
export function finishRequest(
  jobId: string,
): { request: GenerateRequest; job: jobs.MediaJob } | { error: string } {
  const job = jobs.get(jobId);
  if (!job) return { error: `Unknown job '${jobId}'.` };
  if (!job.draft)
    return {
      error: `Job ${jobId} is not a finishable draft (only Seedance 2.5 drafts made with parameters.draft on fal or Runware are). To get a bigger version of a kept take use media_upscale.`,
    };
  if (job.state !== "completed")
    return { error: `Draft job ${jobId} is ${job.state}, not completed.` };
  if (Date.now() > job.draft.expiresAt)
    return {
      error: `Draft ${job.draft.id} expired on ${new Date(job.draft.expiresAt).toISOString().slice(0, 10)}. Ask the user: upscale the draft (media_upscale) or regenerate the shot at 1080p (a new take, needs approval again).`,
    };
  const r = job.request;
  const videoInput =
    !!r.video ||
    ["video_urls", "reference_video_urls", "video_url"].some((k) => r.input?.[k] !== undefined);
  return {
    job,
    request: {
      model: job.draft.model,
      route: "exact",
      parameters: { duration: job.draft.seconds },
      finishDraft: {
        draftId: job.draft.id,
        provider: job.draft.provider,
        seconds: job.draft.seconds,
        ofJob: job.id,
        // A draft made from a source clip is finished with that clip's seconds billed too.
        ...(videoInput ? { videoInput: true } : {}),
        ...(videoInput && r.inputSeconds !== undefined ? { inputSeconds: r.inputSeconds } : {}),
      },
    },
  };
}

/** Ask-before limit, chat cap and daily cap, as lines for the agent. */
export function spendLines(quote?: { usd: number | null; usdMax: number | null }): string[] {
  const s = spend.settings();
  const chat = spend.chatId();
  const cap = spend.effectiveCap(chat);
  const unapproved = ledger.unapprovedInChat(chat, spend.lastApprovalAt(chat));
  const out: string[] = [];
  if (quote)
    out.push(
      spend.needsApproval(quote, s.askAboveUsd, unapproved)
        ? `Ask first: yes. ${quote.usd === null && quote.usdMax === null ? "The price is unknown" : `It is above the ask-before limit ($${s.askAboveUsd}${s.askAboveUsd === 0 ? ": every paid generation" : ""})`}; media_generate returns an approval card.`
        : `Ask first: no (within the ask-before limit of $${s.askAboveUsd}).`,
    );
  out.push(
    `Spent in this chat since the last approval: ${unapproved.unknown ? "some of unknown price, so the next paid batch asks" : `$${unapproved.usd.toFixed(2)}`} (counts toward the ask-before limit).`,
  );
  if (cap)
    out.push(
      `Chat cap: $${cap.usd}${cap.usd === 0 ? " (free tools only)" : ""}, from ${cap.source}; counted so far ≈ $${ledger.spentInChat(chat, cap.since).toFixed(2)} (reserved worst case until each job settles).`,
    );
  else
    out.push(
      spend.threadId()
        ? "No chat cap (raise one only from the user's own words: spend_cap_set; lowering is always allowed)."
        : "No chat caps here (no chat id from the app); only the daily cap applies.",
    );
  const daily = spend.dailyCap();
  out.push(
    daily
      ? `Daily cap: $${daily} (OH_SPEND_CAP_USD); used today ≈ $${ledger.spentToday().toFixed(2)}.`
      : "No daily cap (OH_SPEND_CAP_USD).",
  );
  return out;
}

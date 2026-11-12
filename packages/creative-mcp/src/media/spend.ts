// Spend rules per chat: the ask-before limit (counted over the chat's unapproved spend), the
// chat's cap (raised only by the user's own signed words, lowered by anyone), and approvals bound
// to the exact card the tool issued and the batch, route and price it showed.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { ohHome } from "../home.ts";
import { checkCapQuote, latestMoneyWords } from "./capwords.ts";
import type { Caps } from "./ledger.ts";
import { verifiedWords, wordsChannel, type SignedWords } from "./words.ts";

export interface SpendSettings {
  /** ask before a paid batch above this (USD), counted with the chat's unapproved spend; 0 = always */
  askAboveUsd: number;
  /** offer 2–3 video models with whole-piece totals before the first paid video of a chat */
  confirmVideoModel: boolean;
  /** a saved preferred video model (then no options are offered) */
  videoModel?: string;
}

const DEFAULT_ASK_ABOVE = 5;
const settingsFile = () => ohHome("media", "spend.json");
const validLimit = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000;

export function settings(): SpendSettings {
  let saved: Partial<SpendSettings> = {};
  try {
    saved = JSON.parse(NodeFS.readFileSync(settingsFile(), "utf8")) as Partial<SpendSettings>;
  } catch {
    // defaults
  }
  const env = process.env.OH_ASK_ABOVE_USD ? Number(process.env.OH_ASK_ABOVE_USD) : undefined;
  return {
    askAboveUsd: validLimit(env)
      ? env
      : validLimit(saved.askAboveUsd)
        ? saved.askAboveUsd
        : DEFAULT_ASK_ABOVE,
    confirmVideoModel: saved.confirmVideoModel !== false,
    ...(saved.videoModel ? { videoModel: saved.videoModel } : {}),
  };
}

/** The agent may only lower the limit; raising it is the user's edit of spend.json or env. */
export function lowerAskAbove(usd: number): { ok: true } | { ok: false; reason: string } {
  const now = settings().askAboveUsd;
  if (!(usd >= 0) || usd > now)
    return {
      ok: false,
      reason: `Only the user can raise the ask-before limit (now $${now}): they edit ${settingsFile()} ("askAboveUsd") or set OH_ASK_ABOVE_USD.`,
    };
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(NodeFS.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    // new file
  }
  NodeFS.mkdirSync(ohHome("media"), { recursive: true });
  NodeFS.writeFileSync(settingsFile(), JSON.stringify({ ...saved, askAboveUsd: usd }, null, 2));
  return { ok: true };
}

export function dailyCap(): number | undefined {
  const cap = Number(process.env.OH_SPEND_CAP_USD);
  return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

/** The app thread this server works for; undefined when the app gave none (chat features off). */
export function threadId(): string | undefined {
  return process.env.OH_THREAD_ID || undefined;
}

/** Ledger key for spend: the thread, or this process when there is no thread (never shared). */
export function chatId(): string {
  return threadId() ?? `process-${process.pid}`;
}

/** The user's verified words in this chat (prompts and card answers), oldest first. */
export function userWords(): SignedWords[] {
  return verifiedWords();
}

export interface Approval {
  id: string;
  fingerprint: string;
  totalUsd: number | null;
  maxUsd: number | null;
  /** the exact card the tool issued: question body and the Approve label */
  question: string;
  approveLabel: string;
  issuedAt: number;
  usedAt?: number;
}

interface CapRecord {
  usd: number;
  via: "quote" | "card";
  /** the user's signed words that state it, and when they said it (start of the budget) */
  sig: string;
  at: number;
}

export interface ChatState {
  cap?: CapRecord;
  /** lower caps set without the user's words (local_only, agent lowering); they only ever lower */
  lowered?: { usd: number; at: number }[];
  approvals: Approval[];
}

const chatFile = (id: string) => ohHome("media", "chats", `${id.replace(/[^\w.-]+/g, "_")}.json`);

export function chatState(id = chatId()): ChatState {
  try {
    const saved = JSON.parse(NodeFS.readFileSync(chatFile(id), "utf8")) as Partial<ChatState>;
    return { ...saved, approvals: saved.approvals ?? [] };
  } catch {
    return { approvals: [] };
  }
}

function saveChat(state: ChatState, id = chatId()) {
  NodeFS.mkdirSync(ohHome("media", "chats"), { recursive: true });
  NodeFS.writeFileSync(chatFile(id), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export interface EffectiveCap {
  usd: number;
  /** spend is counted from here */
  since: number;
  /** what set it, for the agent */
  source: string;
}

/**
 * This chat's cap: the lowest of the recorded cap (backed by the user's signed words; $0 if they no
 * longer verify), caps lowered since, and the cap the user's latest money words state. Spend counts
 * from the words that set the budget, so re-quoting them never restarts it.
 */
export function effectiveCap(id = chatId()): EffectiveCap | undefined {
  if (!threadId()) return undefined;
  const state = chatState(id);
  const words = userWords();
  const found: EffectiveCap[] = [];
  let base: EffectiveCap | undefined;
  if (state.cap) {
    const record = words.find((w) => w.sig === state.cap!.sig);
    base = record
      ? {
          usd: state.cap.usd,
          since: record.at,
          source: `the user's words ("${record.text.slice(0, 80)}")`,
        }
      : {
          usd: 0,
          since: state.cap.at,
          source:
            "a recorded cap whose words can't be verified any more (app restarted or the record changed); ask the user to state the cap again",
        };
    found.push(base);
  }
  const after = base?.since ?? 0;
  for (const l of state.lowered ?? [])
    if (l.at >= after) found.push({ usd: l.usd, since: l.at, source: "lowered in this chat" });
  const latest = latestMoneyWords(words);
  if (latest?.cap !== undefined && latest.words.at >= after) {
    found.push({
      usd: latest.cap,
      since: latest.words.at,
      source: `the user's latest words ("${latest.sentence.slice(0, 80)}")`,
    });
    // Keep it: after an app restart those words no longer verify, and a cap must never vanish.
    const kept = (state.lowered ?? []).some(
      (l) => l.usd === latest.cap && l.at === latest.words.at,
    );
    if (!kept) {
      state.lowered = [...(state.lowered ?? []), { usd: latest.cap, at: latest.words.at }];
      saveChat(state, id);
    }
  }
  if (!found.length) return undefined;
  const lowest = found.reduce((a, b) => (b.usd < a.usd ? b : a));
  return { ...lowest, since: base?.since ?? Math.min(...found.map((f) => f.since)) };
}

export function caps(id = chatId()): Caps {
  const daily = dailyCap();
  const cap = effectiveCap(id);
  return {
    ...(daily !== undefined ? { daily } : {}),
    ...(cap ? { chat: { usd: cap.usd, since: cap.since } } : {}),
  };
}

export type CapResult = { ok: true; usd: number; note?: string } | { ok: false; reason: string };

/**
 * Set this chat's cap. Lowering (or a first cap) always applies. Raising needs the user's own words
 * that state the new cap: usd + quote of their whole sentences or of the card option they picked.
 * local_only = $0. The budget starts when the user said it, so a repeated quote changes nothing.
 */
export function setChatCap(a: { usd?: number; quote?: string; localOnly?: boolean }): CapResult {
  if (!threadId())
    return {
      ok: false,
      reason:
        "This server has no chat id from the app (e.g. a shared Codex server), so a chat cap would be shared between chats. Use OH_SPEND_CAP_USD (per day) instead.",
    };
  const askHow =
    'Ask once with a question card: one option per cap, each label naming it (e.g. "Free only ($0)", "Up to $5", "Up to $20"), none marked recommended, free text allowed. A plain "yes" to a cap you proposed does not count.';
  const state = chatState();
  const now = effectiveCap();
  const lower = (usd: number) => {
    state.lowered = [...(state.lowered ?? []), { usd, at: Date.now() }];
    saveChat(state);
    return { ok: true as const, usd: Math.min(usd, now?.usd ?? usd) };
  };
  if (a.localOnly) {
    if ((a.usd ?? 0) > 0)
      return {
        ok: false,
        reason: "local_only means a $0 cap; drop usd, or quote the user's cap without local_only.",
      };
    return lower(0);
  }
  if (a.usd === undefined) return { ok: false, reason: `Name the cap (usd). ${askHow}` };
  if (!a.quote) {
    if (!now || a.usd <= now.usd) return lower(a.usd);
    return {
      ok: false,
      reason: `Raising the cap above $${now.usd} needs the user's own words stating $${a.usd} (quote). ${askHow}`,
    };
  }
  if (!wordsChannel())
    return {
      ok: false,
      reason:
        "This chat has no verified record of the user's words (no app hooks, e.g. Codex), so a cap can only be lowered here. Use OH_SPEND_CAP_USD for a daily cap.",
    };
  const check = checkCapQuote(a.usd, a.quote, userWords());
  if (!check.ok) return { ok: false, reason: `${check.reason} ${askHow}` };
  const record = check.words as SignedWords;
  if (state.cap?.sig === record.sig)
    return {
      ok: true,
      usd: a.usd,
      note: "already set from these words; the budget did not restart",
    };
  state.cap = { usd: a.usd, via: check.via, sig: record.sig, at: record.at };
  saveChat(state);
  return { ok: true, usd: a.usd };
}

export interface BatchQuote {
  /** expected total (null = unknown) */
  usd: number | null;
  /** worst case / "up to" (null = unbounded) */
  usdMax: number | null;
}

/** When the chat's last approval was used (unapproved spend is counted from then). */
export function lastApprovalAt(id = chatId()): number {
  return Math.max(0, ...chatState(id).approvals.map((a) => a.usedAt ?? 0));
}

/**
 * Must the user approve this batch first? Its price plus what the chat spent since the last
 * approval without one is compared with the limit: strictly above it, any paid batch at limit 0,
 * or an unknown price (an "up to" bound is compared instead when there is one).
 */
export function needsApproval(
  q: BatchQuote,
  askAbove = settings().askAboveUsd,
  unapproved: { usd: number; unknown: boolean } = { usd: 0, unknown: false },
): boolean {
  const paid = q.usd === null || q.usdMax === null || q.usd > 0 || q.usdMax > 0;
  if (!paid) return false;
  if (askAbove === 0 || unapproved.unknown) return true;
  if (q.usd !== null) return unapproved.usd + q.usd > askAbove;
  if (q.usdMax !== null) return unapproved.usd + q.usdMax > askAbove;
  return true;
}

export function batchFingerprint(parts: unknown): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

const APPROVAL_TTL_MS = 6 * 3600_000;

/** The card's last line: the signed answer carries it, binding the pick to this exact batch. */
export const approvalMarker = (id: string, fingerprint: string) =>
  `(approval ${id} for batch ${fingerprint})`;
export const approveLabelFor = (q: BatchQuote) => `Approve ${money(q.usd, q.usdMax)}`;
const money = (n: number | null, max?: number | null) =>
  n === null ? (max != null ? `up to $${max.toFixed(2)}` : "price unknown") : `$${n.toFixed(2)}`;

/** Issue (or reuse, for the identical batch at the identical price) an approval and its card. */
export function issueApproval(
  fingerprint: string,
  q: BatchQuote,
  lines: { label: string; usd: number | null }[] = [],
  payer = "unknown",
  title = "Estimated cost",
): Approval {
  const state = chatState();
  const open = state.approvals.find(
    (a) => a.fingerprint === fingerprint && !a.usedAt && Date.now() - a.issuedAt < APPROVAL_TTL_MS,
  );
  if (open) return open;
  const id = `ap-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const total = money(q.usd, q.usdMax);
  const question = [
    `${title}: ${total}${q.usd === null ? " (actual cost known once it finishes)" : ""}${q.usdMax !== null && q.usd !== null && q.usdMax > q.usd + 0.005 ? `, up to $${q.usdMax.toFixed(2)} if it falls back to a dearer route` : ""} · billed to ${payer}`,
    ...lines.map((l) => `- ${l.label}: ${money(l.usd)}`),
    approvalMarker(id, fingerprint),
  ].join("\n");
  const approval: Approval = {
    id,
    fingerprint,
    totalUsd: q.usd,
    maxUsd: q.usdMax,
    question,
    approveLabel: approveLabelFor(q),
    issuedAt: Date.now(),
  };
  state.approvals = [...state.approvals.slice(-40), approval];
  saveChat(state);
  return approval;
}

const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

/**
 * An approval pays for the batch it was issued for (same requests, same routes, same price) once,
 * after the user picked its Approve option on the exact card the tool issued. Typed text, other
 * cards and anything not recorded and signed by the app don't count. It is spent even if a cap then
 * refuses the submission.
 */
export function useApproval(
  id: string,
  fingerprint: string,
  quote: BatchQuote,
  usedInLedger: (id: string) => boolean = () => false,
): ApprovalCheck {
  if (!threadId() || !wordsChannel())
    return {
      ok: false,
      reason:
        "This chat can't record the user's answer to an approval card (no app hooks or chat id, e.g. Codex), so batches above the ask-before limit can't run here. Ask the user to raise the limit in ~/.open-herness/media/spend.json, or run it from a Claude chat.",
    };
  const state = chatState();
  const a = state.approvals.find((x) => x.id === id);
  if (!a)
    return {
      ok: false,
      reason: `Unknown approval ${id}; only approvals issued by the spend tools count.`,
    };
  // The ledger is append-only: a pick already spent there stays spent, whatever the chat file says.
  if (a.usedAt || usedInLedger(id))
    return { ok: false, reason: `Approval ${id} was already used for a submission.` };
  if (Date.now() - a.issuedAt > APPROVAL_TTL_MS)
    return { ok: false, reason: `Approval ${id} expired; quote again and ask.` };
  // What the user signed must name this batch and this price; nothing is taken from the chat file.
  const marker = approvalMarker(id, fingerprint);
  const label = approveLabelFor(quote);
  const approved = userWords().some(
    (w) =>
      w.at >= a.issuedAt &&
      w.source === "card" &&
      w.picked === true &&
      sameText(w.question ?? "", a.question) &&
      (w.question ?? "").includes(marker) &&
      w.text === label,
  );
  if (!approved)
    return {
      ok: false,
      reason:
        a.fingerprint !== fingerprint || a.approveLabel !== label
          ? `Approval ${id} was for a different batch, route or price (something changed since the card). Quote again and ask.`
          : `The user has not picked "${label}" on the card of ${id}. Show that card (unchanged) and wait for their answer.`,
    };
  a.usedAt = Date.now();
  saveChat(state);
  return { ok: true };
}

/** The question-card payload for an approval (AskUserQuestion shape; nothing pre-selected). */
export function approvalCard(a: Approval) {
  return {
    questions: [
      {
        header: "Approve cost",
        question: a.question,
        multiSelect: false,
        options: [
          { label: a.approveLabel, description: "Submit this batch now" },
          { label: "Cancel", description: "Submit nothing" },
        ],
      },
    ],
  };
}

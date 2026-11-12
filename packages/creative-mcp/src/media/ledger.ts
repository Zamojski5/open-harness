// Generation spend ledger v2: append-only JSON lines under a cross-process lock. A job's worst
// case is reserved before it is sent, then settled to the provider's reported charge (else kept at
// the worst case) or released when nothing could have been charged, which frees its room.

import * as NodeFS from "node:fs";
import { ohHome } from "../home.ts";
import { failureError, makeFailure } from "./failures.ts";

export type LedgerState = "reserved" | "spent" | "released";

export interface LedgerLine {
  v: 2;
  /** job id, or a batch slot id before the job exists */
  key: string;
  chatId: string;
  day: string;
  at: number;
  state: LedgerState;
  provider?: string;
  model?: string;
  payer?: string;
  /** expected price (null = unknown) */
  estimateUsd: number | null;
  /** worst case reserved against caps (null = unbounded: never allowed under a cap) */
  maxUsd: number | null;
  chargeUsd?: number;
  chargeSource?: "provider" | "measured" | "worst_case" | "none";
  /** the approval that paid for it (spend without one counts toward the ask-before limit) */
  approvalId?: string;
}

const file = () => ohHome("media", "ledger.jsonl");
const lockDir = () => ohHome("media", "ledger.lock");
const legacyFile = () => ohHome("media", "ledger.json");
export const today = () => new Date().toLocaleDateString("sv-SE");
const round = (n: number) => Math.round(n * 1000) / 1000;

function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Exclusive section across processes: mkdir is atomic; a lock older than 10 s is stale. The lock
 * carries an owner token so a holder only removes its own lock. Waiting blocks this process for at
 * most a few seconds, which is acceptable for appending a few lines.
 */
export function withLock<T>(fn: () => T): T {
  NodeFS.mkdirSync(ohHome("media"), { recursive: true, mode: 0o700 });
  try {
    NodeFS.chmodSync(ohHome("media"), 0o700);
  } catch {
    // not ours to change
  }
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const owner = () => `${lockDir()}/owner`;
  for (let attempt = 0; ; attempt++) {
    try {
      NodeFS.mkdirSync(lockDir());
      NodeFS.writeFileSync(owner(), token);
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - NodeFS.statSync(lockDir()).mtimeMs > 10_000)
          NodeFS.rmSync(lockDir(), { recursive: true, force: true });
      } catch {
        // someone else removed it
      }
      if (attempt >= 100)
        throw failureError(
          makeFailure("outage", "local", {
            message: "The spend ledger is locked by another Open Herness process.",
            hint: "Try again in a few seconds; nothing was submitted.",
          }),
        );
      pause(10 + Math.random() * 90);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (NodeFS.readFileSync(owner(), "utf8") === token)
        NodeFS.rmSync(lockDir(), { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}

export function readLines(): LedgerLine[] {
  let text = "";
  try {
    text = NodeFS.readFileSync(file(), "utf8");
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerLine);
    } catch {
      // a torn line from a crash: skip it
    }
  }
  return out;
}

/** Has any reservation been made under this approval (it paid for a submission)? */
export function approvalUsed(approvalId: string, lines = readLines()): boolean {
  return lines.some((l) => l.approvalId === approvalId);
}

/** Latest line per key. */
export function current(lines = readLines()): Map<string, LedgerLine> {
  const map = new Map<string, LedgerLine>();
  for (const l of lines) map.set(l.key, l);
  return map;
}

function append(line: LedgerLine) {
  NodeFS.mkdirSync(ohHome("media"), { recursive: true });
  NodeFS.appendFileSync(file(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** What a line counts: reserved = worst case, spent = charge (or worst case); null = unknown. */
export function counted(l: LedgerLine): number | null {
  if (l.state === "released") return 0;
  if (l.state === "spent") return l.chargeUsd ?? l.maxUsd ?? l.estimateUsd;
  return l.maxUsd ?? l.estimateUsd;
}

export interface SpendTotal {
  usd: number;
  /** some of it has no known price (never taken as $0) */
  unknown: boolean;
}

function total(lines: Iterable<LedgerLine>): SpendTotal {
  let usd = 0;
  let unknown = false;
  for (const l of lines) {
    const c = counted(l);
    if (c === null) unknown = true;
    else usd += c;
  }
  return { usd: round(usd), unknown };
}

/** Today's total from the v1 ledger (kept so switching versions mid-day loses nothing). */
function legacyToday(): number {
  try {
    const old = JSON.parse(NodeFS.readFileSync(legacyFile(), "utf8")) as {
      day: string;
      usd: number;
      state: string;
    }[];
    return old
      .filter((e) => e.day === today() && e.state !== "released")
      .reduce((s, e) => s + e.usd, 0);
  } catch {
    return 0;
  }
}

function firstAt(lines: LedgerLine[], key: string) {
  return lines.find((l) => l.key === key)?.at ?? 0;
}

export function spentTodayTotal(lines = readLines()): SpendTotal {
  const t = total([...current(lines).values()].filter((l) => l.day === today()));
  return { usd: round(t.usd + legacyToday()), unknown: t.unknown };
}

export function spentToday(lines = readLines()): number {
  return spentTodayTotal(lines).usd;
}

export function spentInChatTotal(chatId: string, since = 0, lines = readLines()): SpendTotal {
  return total(
    [...current(lines).values()].filter(
      (l) => l.chatId === chatId && firstAt(lines, l.key) >= since,
    ),
  );
}

export function spentInChat(chatId: string, since = 0, lines = readLines()): number {
  return spentInChatTotal(chatId, since, lines).usd;
}

/** Chat spend since `since` that no approval paid for (it counts toward the ask-before limit). */
export function unapprovedInChat(chatId: string, since = 0, lines = readLines()): SpendTotal {
  return total(
    [...current(lines).values()].filter(
      (l) => l.chatId === chatId && !l.approvalId && firstAt(lines, l.key) >= since,
    ),
  );
}

export interface Caps {
  /** USD per calendar day for this machine (OH_SPEND_CAP_USD) */
  daily?: number;
  /** USD for this chat, counted from `since` */
  chat?: { usd: number; since: number };
}

export interface ReserveItem {
  key: string;
  approvalId?: string;
  provider?: string;
  model?: string;
  payer?: string;
  estimateUsd: number | null;
  maxUsd: number | null;
}

export interface CapRefusal {
  cap: "daily" | "chat";
  capUsd: number;
  spentUsd: number;
  neededUsd: number | null;
  /** how many of the items would fit in what is left (0 when the price is unknown) */
  fits: number;
}

export function refusalError(r: CapRefusal, count: number) {
  const which =
    r.cap === "chat" ? "this chat's spend cap" : "the daily spend cap (OH_SPEND_CAP_USD)";
  const need =
    r.neededUsd === null
      ? "an unknown price (never allowed under a cap)"
      : `up to $${r.neededUsd.toFixed(2)}`;
  return failureError(
    makeFailure("billing", "local", {
      message: `LIMIT ${which}: $${r.spentUsd.toFixed(2)} of $${r.capUsd} used, this needs ${need}. Nothing was submitted.`,
      hint:
        r.capUsd === 0 && r.cap === "chat"
          ? "The user asked for free tools only. Make it locally (Blender, EffectCraft, speak_local) or ask them whether to allow paid generations."
          : `Tell the user in one sentence what is short and which shots are saved vs not started, then ask (one question card): ${r.fits > 0 && r.fits < count ? `shrink the batch to ${r.fits} take(s) that fit, ` : ""}a cheaper model or a draft tier with a known price (media_estimate), raise the cap (their own words, spend_cap_set), or skip. Submit nothing until they answer.`,
    }),
  );
}

/**
 * Reserve every item or none (a key already reserved costs nothing twice; `fromKeys` hands slots
 * over to their jobs). Under a cap an unknown price never fits, whatever `allowUnpriced` says.
 * Returns the refusal, with how many items would fit, instead of throwing.
 */
export function reserveAll(
  items: ReserveItem[],
  chatId: string,
  caps: Caps,
  opts: { allowUnpriced?: boolean; fromKeys?: (string | undefined)[] } = {},
): CapRefusal | undefined {
  return withLock(() => {
    const lines = readLines();
    const now = current(lines);
    const fresh = items.filter((it) => now.get(it.key)?.state !== "reserved");
    const handedOver = new Set((opts.fromKeys ?? []).filter((k): k is string => !!k));
    const credit = (pred: (l: LedgerLine) => boolean) =>
      [...handedOver].reduce((s, k) => {
        const l = now.get(k);
        return l && l.state === "reserved" && pred(l) ? s + (counted(l) ?? 0) : s;
      }, 0);
    const unknown = fresh.some((it) => it.maxUsd === null);
    const needed = unknown ? null : round(fresh.reduce((s, it) => s + (it.maxUsd ?? 0), 0));
    const perTake = fresh.length ? (needed ?? 0) / fresh.length : 0;
    const check = (
      cap: "daily" | "chat",
      capUsd: number,
      spent: SpendTotal,
    ): CapRefusal | undefined => {
      if (!fresh.length) return undefined;
      const paid = unknown || (needed ?? 0) > 0;
      if (unknown || (spent.unknown && paid))
        return { cap, capUsd, spentUsd: spent.usd, neededUsd: needed, fits: 0 };
      // A $0 cap means nothing paid at all; otherwise reserved worst case must stay within the cap.
      if ((capUsd === 0 && paid) || spent.usd + (needed ?? 0) > capUsd + 1e-9)
        return {
          cap,
          capUsd,
          spentUsd: spent.usd,
          neededUsd: needed,
          fits: perTake > 0 ? Math.max(0, Math.floor((capUsd - spent.usd) / perTake + 1e-9)) : 0,
        };
      return undefined;
    };
    if (caps.daily !== undefined) {
      const t = spentTodayTotal(lines);
      const r = check("daily", caps.daily, {
        usd: round(t.usd - credit((l) => l.day === today())),
        unknown: t.unknown,
      });
      if (r) return r;
    }
    if (caps.chat) {
      const since = caps.chat.since;
      const t = spentInChatTotal(chatId, since, lines);
      const r = check("chat", caps.chat.usd, {
        usd: round(t.usd - credit((l) => l.chatId === chatId && firstAt(lines, l.key) >= since)),
        unknown: t.unknown,
      });
      if (r) return r;
    }
    const at = Date.now();
    for (const k of handedOver) {
      const l = now.get(k);
      if (l && l.state === "reserved") append({ ...l, state: "released", at });
    }
    for (const it of fresh)
      append({
        v: 2,
        key: it.key,
        chatId,
        day: today(),
        at,
        state: "reserved",
        ...(it.provider ? { provider: it.provider } : {}),
        ...(it.model ? { model: it.model } : {}),
        ...(it.payer ? { payer: it.payer } : {}),
        ...(it.approvalId ? { approvalId: it.approvalId } : {}),
        estimateUsd: it.estimateUsd,
        maxUsd: it.maxUsd,
      });
    return undefined;
  });
}

/**
 * spent: the job ran (or was accepted and may be charged): the provider's charge when it reported
 * one, otherwise the worst case stays. released: nothing was charged (never sent, refused before
 * acceptance, or the provider reported $0), so the room returns.
 */
export function settle(
  key: string,
  outcome: "spent" | "released",
  charge?: { usd: number; source: "provider" | "measured" },
) {
  withLock(() => {
    const l = current().get(key);
    if (!l || l.state !== "reserved") return;
    const released = outcome === "released" || charge?.usd === 0;
    append({
      ...l,
      at: Date.now(),
      state: released ? "released" : "spent",
      ...(released
        ? { chargeUsd: 0, chargeSource: charge ? charge.source : "none" }
        : charge
          ? { chargeUsd: charge.usd, chargeSource: charge.source }
          : { chargeSource: "worst_case" }),
    });
  });
}

/** Drop a reservation without a job (e.g. a batch slot that resolved to a reused job). */
export function release(key: string) {
  settle(key, "released");
}

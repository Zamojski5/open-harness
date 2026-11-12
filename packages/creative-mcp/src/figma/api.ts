// Figma REST client for the token connection: serialised calls with a per-minute ceiling, error
// classification with rate-limit headers, size caps, and token-free downloads from signed URLs.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { redact } from "./token.ts";

export const API_BASE = "https://api.figma.com/v1";
const JSON_CAP = 50 * 1024 * 1024;
const DOWNLOAD_CAP = 200 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export type FigmaErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "ACCESS_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "RESPONSE_TOO_LARGE"
  | "TRANSPORT"
  | "INVALID_RESPONSE";

export interface RateLimitInfo {
  retryAfterSeconds?: number;
  rateLimitType?: string;
  planTier?: string;
  upgradeLink?: string;
}

const HINTS: Record<FigmaErrorCode, string> = {
  AUTH_REQUIRED:
    "No Figma token. Work from a paste or a saved local copy; ask the user to store a token only if the live file is needed.",
  AUTH_INVALID:
    "The token was rejected (bad, expired or revoked). Ask the user for a new token; do not retry with this one.",
  ACCESS_DENIED:
    "This account cannot open the file. Ask for access or for a saved local copy (.fig).",
  NOT_FOUND: "No such file or node. Check the key: a branch is a separate file with its own key.",
  RATE_LIMITED:
    "Figma rate limit hit. With limit type 'low' the month's allowance is probably gone: tell the user and switch to the local-file route. Otherwise wait as told. Run Figma tools one at a time.",
  INVALID_INPUT: "Fix the arguments.",
  RESPONSE_TOO_LARGE: "Response over 50 MB: ask for fewer nodes or a smaller depth.",
  TRANSPORT: "Network or server trouble; retry shortly.",
  INVALID_RESPONSE: "Unexpected answer from Figma; retry, and report if it persists.",
};

export class FigmaError extends Error {
  readonly code: FigmaErrorCode;
  readonly hint: string;
  readonly status: number | undefined;
  readonly rateLimit: RateLimitInfo | undefined;
  constructor(
    code: FigmaErrorCode,
    message: string,
    opts: { hint?: string; status?: number; rateLimit?: RateLimitInfo } = {},
  ) {
    super(message);
    this.code = code;
    this.hint = opts.hint ?? HINTS[code];
    this.status = opts.status;
    this.rateLimit = opts.rateLimit;
  }
  toJSON() {
    return {
      error: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.status ? { status: this.status } : {}),
      ...this.rateLimit,
    };
  }
}

/** One call at a time, at most `perMinute` starts in any 60 s window. */
export class Limiter {
  private chain: Promise<unknown> = Promise.resolve();
  private starts: number[] = [];
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  constructor(
    perMinute = 60,
    now: () => number = Date.now,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.perMinute = perMinute;
    this.now = now;
    this.wait = wait;
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      for (;;) {
        const t = this.now();
        this.starts = this.starts.filter((s) => t - s < 60_000);
        if (this.starts.length < this.perMinute) break;
        await this.wait(60_000 - (t - this.starts[0]!) + 5);
      }
      this.starts.push(this.now());
      return fn();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export const limiter = new Limiter();

function rateLimitOf(h: Headers): RateLimitInfo {
  const info: RateLimitInfo = {};
  const ra = h.get("retry-after");
  if (ra && Number.isFinite(Number(ra))) info.retryAfterSeconds = Number(ra);
  const t = h.get("x-figma-rate-limit-type");
  if (t) info.rateLimitType = t;
  const tier = h.get("x-figma-plan-tier");
  if (tier) info.planTier = tier;
  const link = h.get("x-figma-upgrade-link");
  if (link) info.upgradeLink = link;
  return info;
}

async function readCapped(
  res: Response,
  cap: number,
  tooLarge: () => FigmaError,
): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export interface ApiResult {
  body: Record<string, unknown>;
  bytes: Uint8Array;
  rateLimit: RateLimitInfo;
}

/** Authenticated GET against api.figma.com, serialised through the limiter. */
export function apiGet(path: string, token: string | null): Promise<ApiResult> {
  if (!token) return Promise.reject(new FigmaError("AUTH_REQUIRED", "No Figma token is set"));
  // A token with spaces, newlines or non-ASCII would make fetch throw with the header value (the
  // token) inside its message; refuse it here without echoing it.
  if (!/^[\x21-\x7e]+$/.test(token))
    return Promise.reject(
      new FigmaError(
        "AUTH_INVALID",
        "The stored Figma token contains spaces, line breaks or non-ASCII characters",
        { hint: "Store the token again from the user's own terminal, pasting only the token." },
      ),
    );
  return limiter.run(async () => {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: { "X-Figma-Token": token },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new FigmaError(
        "TRANSPORT",
        `Figma request failed: ${redact(String((error as Error).message ?? error), token).slice(0, 200)}`,
      );
    }
    const rateLimit = rateLimitOf(res.headers);
    if (!res.ok) {
      const text = redact(await res.text().catch(() => ""), token).slice(0, 300);
      let detail = text;
      try {
        const j = JSON.parse(text) as { err?: string; message?: string };
        detail = j.err ?? j.message ?? text;
      } catch {
        // keep the raw (truncated) text
      }
      const msg = `Figma answered ${res.status}${detail ? `: ${detail}` : ""}`;
      const s = res.status;
      if (s === 401) throw new FigmaError("AUTH_INVALID", msg, { status: s });
      if (s === 403) throw new FigmaError("ACCESS_DENIED", msg, { status: s });
      if (s === 404) throw new FigmaError("NOT_FOUND", msg, { status: s });
      if (s === 429) throw new FigmaError("RATE_LIMITED", msg, { status: s, rateLimit });
      if (s >= 500) throw new FigmaError("TRANSPORT", msg, { status: s });
      throw new FigmaError("INVALID_INPUT", msg, { status: s });
    }
    const bytes = await readCapped(
      res,
      JSON_CAP,
      () => new FigmaError("RESPONSE_TOO_LARGE", "Figma's JSON answer is over 50 MB"),
    );
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new FigmaError("INVALID_RESPONSE", "Figma did not answer with JSON");
    }
    return { body, bytes, rateLimit };
  });
}

let loopbackHttpAllowed = false;
/** Tests serve downloads from a loopback http server; production requires https. */
export function allowLoopbackHttpForTests(on: boolean) {
  loopbackHttpAllowed = on;
}

export function checkDownloadUrl(raw: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new FigmaError("INVALID_RESPONSE", "Figma returned a download link that is not a URL");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  const okScheme =
    url.protocol === "https:" || (loopbackHttpAllowed && loopback && url.protocol === "http:");
  if (!okScheme || url.username || url.password)
    throw new FigmaError(
      "INVALID_RESPONSE",
      "Figma returned an unexpected download link (not https, or with credentials)",
    );
  return url;
}

export function atomicWrite(file: string, data: Uint8Array) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  NodeFS.writeFileSync(tmp, data);
  NodeFS.renameSync(tmp, file);
}

/** Fetches a signed CDN URL without the token (https only, 200 MB cap, 120 s). */
export async function download(
  raw: unknown,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const url = checkDownloadUrl(raw);
  const fail = (why: string) =>
    new FigmaError("TRANSPORT", `Download failed: ${why}`, { hint: "URLs expire; run again." });
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw fail(String((error as Error).message ?? error).slice(0, 160));
  }
  if (!res.ok) throw fail(`HTTP ${res.status}`);
  const bytes = await readCapped(res, DOWNLOAD_CAP, () => fail("file over 200 MB"));
  return { bytes, contentType: res.headers.get("content-type") };
}

/** Runs tasks with at most `n` in flight; returns settled results in input order. */
export async function pool<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

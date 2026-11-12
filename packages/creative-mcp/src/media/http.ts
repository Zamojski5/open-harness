// Provider HTTP plumbing shared by every adapter: JSON calls whose errors are classified for the
// phase they happen in, cancellable sleeps, and poll retries for transient trouble.

import {
  backoffMs,
  classifyException,
  classifyHttp,
  failureError,
  makeFailure,
  MediaError,
  type Provider,
} from "./failures.ts";

export async function sleep(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new MediaError("Anulowano", "cancelled"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => (clearTimeout(t), reject(new MediaError("Anulowano", "cancelled"))),
      { once: true },
    );
  });
}

/** fetch → JSON, classifying HTTP errors and transport exceptions for this phase. */
export async function call(
  provider: Provider,
  url: string,
  init: RequestInit,
  phase: "submit" | "poll" | "result" | "sync",
  accepted: boolean,
): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw new MediaError("Anulowano", "cancelled");
    throw failureError(classifyException(provider, error, { phase }));
  }
  const text = await res.text();
  if (!res.ok)
    throw failureError(
      classifyHttp(provider, res.status, text, {
        accepted,
        retryAfter: res.headers.get("retry-after"),
      }),
    );
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw failureError(
      makeFailure("ambiguous", provider, {
        accepted,
        detail: `invalid JSON: ${text.slice(0, 200)}`,
      }),
    );
  }
}

/** Poll loop helper: transient transport/5xx errors while polling are retried (the job exists at the provider). */
export async function pollWithRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const f = error instanceof MediaError ? error.failure : undefined;
      if (attempt < 6 && f && (f.category === "outage" || f.category === "capacity")) {
        await sleep(backoffMs(Math.min(attempt, 3), f), signal);
        continue;
      }
      throw error;
    }
  }
}

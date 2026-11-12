// Every test runs against a throwaway OH_HOME and a fetch that refuses unplanned network calls,
// so no test can read the user's keys, touch the live ledger/jobs or spend money.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { canonical, type Line } from "../src/media/words.ts";

export type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

export interface Isolation {
  home: string;
  /** Answer requests whose URL contains `match`; anything unmatched throws. */
  route(match: string | RegExp, handler: Route): void;
  calls: { url: string; init: RequestInit | undefined }[];
}

export function isolate(): Isolation {
  const state: Isolation & { routes: [string | RegExp, Route][] } = {
    home: "",
    routes: [],
    calls: [],
    route(match, handler) {
      state.routes.push([match, handler]);
    },
  };
  const savedEnv = { ...process.env };
  beforeEach(() => {
    state.home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-test-"));
    state.routes = [];
    state.calls = [];
    for (const k of [
      "FAL_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "ELEVENLABS_API_KEY",
      "RUNWARE_API_KEY",
      "REPLICATE_API_TOKEN",
      "OH_SPEND_CAP_USD",
      "OH_ASK_ABOVE_USD",
      "OH_THREAD_ID",
      "OH_SESSION_ID",
      "OH_WORDS_KEY",
      "FIGMA_TOKEN",
    ])
      delete process.env[k];
    process.env.OH_HOME = state.home;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      state.calls.push({ url, init });
      const hit = state.routes.find(([m]) =>
        typeof m === "string" ? url.includes(m) : m.test(url),
      );
      if (!hit) throw new Error(`unexpected network call in a test: ${url}`);
      return hit[1](url, init);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    NodeFS.rmSync(state.home, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });
  return state;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Plays the app's part: a signing key per "server run", records signed exactly as the app's hooks
 * sign them, and the env a Claude chat's creative server gets (thread, session, public key).
 */
export function appSession(session = "session-1", thread = "thread-1") {
  const keys = NodeCrypto.generateKeyPairSync("ed25519");
  process.env.OH_THREAD_ID = thread;
  process.env.OH_SESSION_ID = session;
  process.env.OH_WORDS_KEY = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const file = () => NodePath.join(process.env.OH_HOME!, "media", "user-words.jsonl");
  const sign = (r: Line) =>
    NodeCrypto.sign(null, Buffer.from(canonical(r)), keys.privateKey).toString("base64");
  return {
    /** the user said / picked something (signed like the app does) */
    say(
      text: string,
      at: number,
      extra: { source?: "prompt" | "card"; question?: string; picked?: boolean } = {},
    ) {
      const r: Line = {
        v: 2,
        at,
        session,
        cwd: process.cwd(),
        source: extra.source ?? "prompt",
        text,
        ...(extra.question !== undefined ? { question: extra.question } : {}),
        ...(extra.picked !== undefined ? { picked: extra.picked } : {}),
      };
      NodeFS.mkdirSync(NodePath.dirname(file()), { recursive: true });
      NodeFS.appendFileSync(file(), `${JSON.stringify({ ...r, sig: sign(r) })}\n`);
    },
    /** what the agent could do with its shell: append an unsigned or self-signed line */
    forge(line: Record<string, unknown>) {
      NodeFS.mkdirSync(NodePath.dirname(file()), { recursive: true });
      NodeFS.appendFileSync(file(), `${JSON.stringify(line)}\n`);
    },
    file,
  };
}

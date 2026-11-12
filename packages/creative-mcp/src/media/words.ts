// The user's own words for this chat, as recorded and signed by the app (apps/server hooks). Only
// lines that verify against the app's public key (OH_WORDS_KEY) and belong to this Claude session
// (OH_SESSION_ID) count; anything else in the file, e.g. a line the agent appended, is ignored.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { ohHome } from "../home.ts";
import type { UserWords } from "./capwords.ts";

export interface SignedWords extends UserWords {
  /** signature (base64); identifies the record */
  sig: string;
}

export interface Line {
  v: number;
  at: number;
  session: string;
  cwd: string;
  source: "prompt" | "card";
  text: string;
  question?: string;
  picked?: boolean;
  sig?: string;
}

// Same field order as the signer in apps/server/src/openHerness/hooks.ts.
export const canonical = (r: Line) =>
  JSON.stringify([
    r.v,
    r.at,
    r.session,
    r.cwd,
    r.source,
    r.text,
    r.question ?? null,
    r.picked ?? null,
  ]);

export const wordsFile = () => ohHome("media", "user-words.jsonl");

/** Can this server read verified words at all (a Claude chat with the app's key)? */
export function wordsChannel(): boolean {
  return !!process.env.OH_SESSION_ID && !!process.env.OH_WORDS_KEY;
}

let keyCache: { b64: string; key: NodeCrypto.KeyObject } | undefined;
function publicKey(): NodeCrypto.KeyObject | undefined {
  const b64 = process.env.OH_WORDS_KEY;
  if (!b64) return undefined;
  if (keyCache?.b64 !== b64)
    try {
      keyCache = {
        b64,
        key: NodeCrypto.createPublicKey({
          key: Buffer.from(b64, "base64"),
          format: "der",
          type: "spki",
        }),
      };
    } catch {
      return undefined;
    }
  return keyCache.key;
}

/** Verified words of this session, oldest first ([] without a channel). */
export function verifiedWords(): SignedWords[] {
  const session = process.env.OH_SESSION_ID;
  const key = publicKey();
  if (!session || !key) return [];
  let text = "";
  try {
    text = NodeFS.readFileSync(wordsFile(), "utf8");
  } catch {
    return [];
  }
  const out: SignedWords[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (line.v !== 2 || line.session !== session || typeof line.sig !== "string") continue;
    let ok = false;
    try {
      ok = NodeCrypto.verify(
        null,
        Buffer.from(canonical(line)),
        key,
        Buffer.from(line.sig, "base64"),
      );
    } catch {
      ok = false;
    }
    if (!ok) continue;
    out.push({
      at: line.at,
      source: line.source,
      text: line.text,
      sig: line.sig,
      ...(line.question !== undefined ? { question: line.question } : {}),
      ...(line.picked !== undefined ? { picked: line.picked } : {}),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

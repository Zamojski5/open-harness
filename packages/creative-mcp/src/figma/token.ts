// The Figma personal access token: env `FIGMA_TOKEN` first, else the macOS Keychain entry the user
// stores from their own terminal. The token stays in this process: never logged, written to files,
// returned by a tool or placed in a URL.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export const KEYCHAIN_SERVICE = "open-herness.figma";
export const KEYCHAIN_ACCOUNT = "FIGMA_TOKEN";
export const STORE_COMMAND = `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`;

export type TokenSource = "env" | "keychain" | "none";

export interface ResolvedToken {
  token: string | null;
  source: TokenSource;
  /** Set when the Keychain could not be read (locked, denied); never contains the token. */
  keychainError?: string;
}

const SECURITY = "/usr/bin/security";

type Reader = () => { token: string | null; error?: string };

function readKeychain(): { token: string | null; error?: string } {
  // No Keychain tool (not macOS): only FIGMA_TOKEN can supply a token.
  if (!NodeFS.existsSync(SECURITY)) return { token: null };
  try {
    const out = NodeChildProcess.execFileSync(
      SECURITY,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
    );
    const token = out.trim();
    return { token: token || null };
  } catch (error) {
    const status = (error as { status?: number }).status;
    // 44 = item not found: simply no token stored.
    if (status === 44) return { token: null };
    return {
      token: null,
      error: `Keychain could not be read (security exit ${status ?? "?"}); unlock it or use FIGMA_TOKEN`,
    };
  }
}

let reader: Reader = readKeychain;
/** Keychain token kept for the server's lifetime, so macOS asks for access once, not per call. */
let cached: string | null = null;

/** Tests replace the Keychain so they never touch the real one. */
export function setKeychainReader(next: Reader | null) {
  reader = next ?? readKeychain;
  cached = null;
}

/** Forget the cached Keychain token (after Figma rejects it, so a newly stored one is picked up). */
export function forgetCachedToken() {
  cached = null;
}

export function resolveToken(): ResolvedToken {
  const env = process.env.FIGMA_TOKEN?.trim();
  if (env) return { token: env, source: "env" };
  if (cached) return { token: cached, source: "keychain" };
  const k = reader();
  if (k.token) {
    cached = k.token;
    return { token: k.token, source: "keychain" };
  }
  return { token: null, source: "none", ...(k.error ? { keychainError: k.error } : {}) };
}

/** The token if already known (env or cached), without touching the Keychain; for redaction. */
export function knownToken(): string | null {
  return process.env.FIGMA_TOKEN?.trim() || cached;
}

/** Removes any accidental occurrence of the token from text that leaves this process. */
export function redact(text: string, token: string | null): string {
  return token && token.length >= 6 ? text.split(token).join("[redacted]") : text;
}

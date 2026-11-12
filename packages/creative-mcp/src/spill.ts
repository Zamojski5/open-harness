// Oversized text results go to a spill file; the model gets head + tail + the path.
// Adapted from DeepSeek Harness (MIT, (c) 2026 DeepSeek), packages/spill/spill-policy/src/retention.ts
// and spill-local/src/store.ts @ dsh-v0.2.2-rc.1, see LICENSE.deepseek-harness. Changes: text only,
// priced in UTF-8 bytes, own wording, spill root outside projects, 7-day/200 MB pruning, redaction.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Inline cap for one tool result's text, in UTF-8 bytes. */
export const RESULT_CAP_BYTES = 20_000;
const SPILL_MAX_AGE_MS = 7 * 24 * 3600_000;
const SPILL_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Keep a surrogate pair whole when a cut lands between its halves. */
function textSlice(text: string, length: number, tail: boolean): string {
  let cut = tail ? text.length - length : length;
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
    cut += tail ? 1 : -1;
  return tail ? text.slice(cut) : text.slice(0, cut);
}

/** Longest end of `text` (head or tail) whose UTF-8 size fits `budget` (binary search). */
function fitText(text: string, budget: number, tail: boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = textSlice(text, middle, tail);
    if (candidate.length === 0 || bytes(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  return textSlice(text, low, tail);
}

/** Head and tail of `text`, each getting half of `budget` bytes; reports the omitted bytes. */
export function retainText(
  text: string,
  budget: number,
): { head: string; tail: string; omittedBytes: number } {
  if (bytes(text) <= budget) return { head: text, tail: "", omittedBytes: 0 };
  const head = fitText(text, Math.ceil(budget / 2), false);
  const tail = fitText(text.slice(head.length), Math.floor(budget / 2), true);
  return { head, tail, omittedBytes: bytes(text) - bytes(head) - bytes(tail) };
}

/** One path segment from untrusted text (tool names, thread ids). */
function segment(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return clean.slice(0, 80) || "_";
}

/** Spill root outside every project: $OPEN_HERNESS_HOME/spill (default ~/.open-herness/spill). */
export function spillRoot(): string {
  const home = process.env.OPEN_HERNESS_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");
  return NodePath.join(home, "spill");
}

const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrune = 0;

/** Drops spill files older than the age limit, then the oldest ones until the root is under the cap. */
export function pruneSpills(now = Date.now(), root = spillRoot()): void {
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  let dirs: string[];
  try {
    dirs = NodeFS.readdirSync(root);
  } catch {
    return;
  }
  for (const dir of dirs) {
    const full = NodePath.join(root, dir);
    let names: string[];
    try {
      names = NodeFS.readdirSync(full);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = NodePath.join(full, name);
      try {
        const stat = NodeFS.statSync(path);
        if (now - stat.mtimeMs > SPILL_MAX_AGE_MS) NodeFS.rmSync(path, { force: true });
        else files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // already gone
      }
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.toSorted((x, y) => x.mtimeMs - y.mtimeMs)) {
    if (total <= SPILL_MAX_TOTAL_BYTES) break;
    NodeFS.rmSync(file.path, { force: true });
    total -= file.size;
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:api[_-]?key|secret|token|password|passwd|authorization|fal[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

/** Masks obvious credentials (API keys, tokens, private keys, key=value secrets). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) && prefix !== match
        ? `${prefix}[REDACTED]`
        : "[REDACTED]",
    );
  return out;
}

/** Writes the redacted full text to <spill root>/<thread>/<tool>-<time>-<hash>.txt (0600 in 0700). */
export function saveSpill(input: {
  tool: string;
  threadId?: string | undefined;
  text: string;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const root = spillRoot();
  const dir = NodePath.join(root, segment(input.threadId || "session"));
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(dir, 0o700);
  if (now - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = now;
    pruneSpills(now, root);
  }
  const hash = NodeCrypto.createHash("sha256").update(input.text).digest("hex").slice(0, 8);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const path = NodePath.join(dir, `${segment(input.tool)}-${stamp}-${hash}.txt`);
  NodeFS.writeFileSync(path, redactSecrets(input.text), { mode: 0o600 });
  return path;
}

type Block = { type: string; text?: string; [key: string]: unknown };
export interface ToolResultLike {
  content?: Block[];
  [key: string]: unknown;
}

/**
 * Bounds the text of one tool result. Under the cap it is returned unchanged. Over it, the full
 * text goes to a spill file and the text blocks are replaced by one block: head, an omission
 * line, tail and where the full result is. Non-text blocks (images) are kept in place after it.
 * When the spill file cannot be written the original result is returned.
 */
export function boundToolResult<T extends ToolResultLike>(
  result: T,
  input: { tool: string; cwd?: string; threadId?: string | undefined; capBytes?: number },
): T {
  const content = Array.isArray(result?.content) ? result.content : undefined;
  if (!content) return result;
  const texts = content.filter((block) => block.type === "text" && typeof block.text === "string");
  const full = texts.map((block) => block.text as string).join("\n");
  const cap = input.capBytes ?? RESULT_CAP_BYTES;
  if (bytes(full) <= cap) return result;
  let path: string;
  try {
    path = saveSpill({ tool: input.tool, threadId: input.threadId, text: full });
  } catch {
    return result;
  }
  const notice = (omitted: number) =>
    `\n\n[... ${omitted} bytes of ${bytes(full)} omitted from the middle ...]\n\n`;
  const footer = `\n\n(Result was ${bytes(full)} bytes, over the ${cap}-byte limit. Full text saved at: ${path} . Read it with Read offset/limit or search it with Grep instead of running the tool again.)`;
  const budget = Math.max(1024, cap - bytes(footer) - bytes(notice(full.length)));
  const { head, tail, omittedBytes } = retainText(full, budget);
  const bounded: Block = { type: "text", text: head + notice(omittedBytes) + tail + footer };
  const rest = content.filter((block) => !texts.includes(block));
  return { ...result, content: [bounded, ...rest] };
}

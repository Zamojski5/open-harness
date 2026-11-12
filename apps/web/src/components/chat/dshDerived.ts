/*
 * Portions adapted from DeepSeek Harness (https://github.com/deepseek-ai/deepseek-harness),
 * MIT License, Copyright (c) 2026 DeepSeek. See the "DeepSeek Harness" entry in
 * third-party-licenses.config.json.
 *
 * - headTailCap: packages/client/ui-primitives/src/head-tail-cap.ts (verbatim logic)
 * - latestCompletedParagraphFirstLine: packages/client/ui-chat/src/client/chat/ReasoningRow.tsx
 * - terminalExitLabel: packages/client/ui-tool/src/client/tool/components/ExitCodeBadge.tsx
 *   (exit code only; our command items carry no terminating signal)
 */

/** The head/tail split metrics for a capped list. */
export interface HeadTailCap {
  /** Rows beyond the cap (list length - maxLines); <= 0 means nothing is hidden. */
  readonly hidden: number;
  /** Whether the list is over the cap and not expanded, so it shows a head/tail slice. */
  readonly capped: boolean;
  /** Head-slice row count: `ceil(maxLines / 2)`. */
  readonly headLines: number;
  /** Tail-slice row count: the remainder after the head. */
  readonly tailLines: number;
}

/** Head/tail cap metrics for `total` rows against `maxLines`. Pure arithmetic. */
export function headTailCap(total: number, maxLines: number, expanded: boolean): HeadTailCap {
  const hidden = total - maxLines;
  const headLines = Math.ceil(maxLines / 2);
  return { hidden, capped: hidden > 0 && !expanded, headLines, tailLines: maxLines - headLines };
}

/** Longest line rendered as is; longer ones are clipped (a minified bundle in a diff). */
const MAX_LINE_CHARS = 2_000;

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line clipped)` : line;
}

/**
 * Splits text into the visible head, the hidden line count and the visible tail. Expanded text
 * still stops at `expandedLimit` lines (`omitted` counts the rest) and very long lines are clipped.
 */
export function headTailText(
  text: string,
  maxLines: number,
  expanded: boolean,
  expandedLimit = Number.POSITIVE_INFINITY,
): {
  readonly head: string;
  readonly hidden: number;
  readonly tail: string;
  readonly omitted: number;
} {
  const lines = text.split("\n").map(clipLine);
  if (lines.at(-1) === "") lines.pop();
  const cap = headTailCap(lines.length, maxLines, expanded);
  if (!cap.capped) {
    const omitted = Math.max(0, lines.length - expandedLimit);
    return {
      head: omitted > 0 ? lines.slice(0, expandedLimit).join("\n") : lines.join("\n"),
      hidden: 0,
      tail: "",
      omitted,
    };
  }
  return {
    head: lines.slice(0, cap.headLines).join("\n"),
    hidden: cap.hidden,
    tail: lines.slice(lines.length - cap.tailLines).join("\n"),
    omitted: 0,
  };
}

/**
 * First line of the latest paragraph whose first line has completed. It only changes when a
 * new paragraph's first line ends, so a streaming preview doesn't flicker on every chunk.
 */
export function latestCompletedParagraphFirstLine(text: string): string {
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  while (true) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd =
      nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (nextParagraph === null) return summary;
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Strips inline markdown decoration from one line (headings, bullets, emphasis, links, code). */
function plainPreviewLine(line: string): string {
  return line
    .replace(/<signature>[\s\S]*?(<\/signature>|$)/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]*)*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/, "")
    .replace(/`+|\*\*|~~|__/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The collapsed reasoning preview. Streaming: the first line of the latest paragraph whose first
 * line is complete. Settled: the first line. Never parses markdown, so it stays cheap per chunk.
 */
export function reasoningPreviewLine(text: string, running: boolean): string {
  const raw = running ? latestCompletedParagraphFirstLine(text) : firstNonEmptyLine(text);
  return plainPreviewLine(raw);
}

/** "exit 2" for a failed command, or null when it succeeded or the code is unknown. */
export function terminalExitLabel(exitCode: number | null | undefined): string | null {
  if (exitCode === null || exitCode === undefined || exitCode === 0) return null;
  return `exit ${exitCode}`;
}

/** The first line that looks like an error in tool output, for the collapsed row. */
export function firstErrorLine(output: string | null | undefined): string | null {
  if (!output) return null;
  const lines = output.split("\n");
  const marker = /\b(error|exception|traceback|failed|fatal|panic|denied|not found)\b/i;
  const hit = lines.find((line) => marker.test(line));
  // Without a marker, the last line is the likeliest summary of a failure.
  const line = (hit ?? lines.findLast((candidate) => candidate.trim() !== "") ?? "").trim();
  return line === "" ? null : line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

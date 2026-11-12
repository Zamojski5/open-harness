// Figma link and node-id parsing. Pure functions, no network.
//
// A link names a file (its key) and optionally a node. Branch links address the branch as a file
// of its own, so the branch key wins over the main file key.

export const LINK_KINDS = ["design", "file", "proto", "board", "slides", "make"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export interface FigmaLink {
  fileKey: string;
  nodeId: string | null;
  /** First path segment of the URL; absent for a bare file key. */
  kind?: LinkKind;
}

export class FigmaLinkError extends Error {}

const BARE_KEY = /^[A-Za-z0-9]{10,128}$/;
const KEY = /^[A-Za-z0-9]+$/;

/** `figma.com` itself or a real subdomain of it (dot boundary), nothing that merely ends in the letters. */
export function isFigmaHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "figma.com" || h.endsWith(".figma.com");
}

/** URL form of a node id (`7-21`, `I40-3%3B88-15`) → API form (`7:21`, `I40:3;88:15`). */
export function normalizeNodeId(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    // keep as typed
  }
  return s.trim().replaceAll("-", ":");
}

const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;

/** Validates a node id after normalising hyphens; returns the colon form or null. */
export function validNodeId(raw: string): string | null {
  const id = normalizeNodeId(raw);
  return NODE_ID.test(id) ? id : null;
}

/**
 * Parses a figma.com URL or (when `allowBareKey`) a bare file key.
 * Throws FigmaLinkError("Not a Figma link") or ("No file key in this link").
 */
export function parseFigmaLink(input: string, allowBareKey = true): FigmaLink {
  const text = input.trim();
  if (allowBareKey && BARE_KEY.test(text)) return { fileKey: text, nodeId: null };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new FigmaLinkError("Not a Figma link");
  }
  if (!/^https?:$/.test(url.protocol) || !isFigmaHost(url.hostname))
    throw new FigmaLinkError("Not a Figma link");
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[0] as LinkKind | undefined;
  if (!kind || !LINK_KINDS.includes(kind) || !parts[1] || !KEY.test(parts[1]))
    throw new FigmaLinkError("No file key in this link");
  let fileKey = parts[1];
  const branchAt = parts.indexOf("branch", 2);
  if (branchAt >= 0) {
    const branchKey = parts[branchAt + 1];
    if (!branchKey || !KEY.test(branchKey)) throw new FigmaLinkError("No file key in this link");
    fileKey = branchKey;
  }
  const rawNode = url.searchParams.get("node-id");
  const nodeId = rawNode ? normalizeNodeId(rawNode) : null;
  return { fileKey, nodeId: nodeId || null, kind };
}

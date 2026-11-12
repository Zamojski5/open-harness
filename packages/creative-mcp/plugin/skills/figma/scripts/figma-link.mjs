#!/usr/bin/env node
// Parse a figma.com link: prints {"fileKey","nodeId","kind"} as JSON. Zero dependencies.
// Usage: node figma-link.mjs '<figma.com URL>'
// Mirrors packages/creative-mcp/src/figma/link.ts (URL form only; bare keys need no parsing).

import * as NodeURL from "node:url";

const KINDS = ["design", "file", "proto", "board", "slides", "make"];
const KEY = /^[A-Za-z0-9]+$/;

export function parse(text) {
  let url;
  try {
    const t = text.trim();
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new Error("Not a Figma link");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^https?:$/.test(url.protocol) || !(host === "figma.com" || host.endsWith(".figma.com")))
    throw new Error("Not a Figma link");
  const parts = url.pathname.split("/").filter(Boolean);
  if (!KINDS.includes(parts[0]) || !parts[1] || !KEY.test(parts[1]))
    throw new Error("No file key in this link");
  let fileKey = parts[1];
  const b = parts.indexOf("branch", 2);
  if (b >= 0) {
    if (!parts[b + 1] || !KEY.test(parts[b + 1])) throw new Error("No file key in this link");
    fileKey = parts[b + 1];
  }
  let node = url.searchParams.get("node-id");
  if (node) {
    try {
      node = decodeURIComponent(node);
    } catch {}
    node = node.trim().replaceAll("-", ":");
  }
  return { fileKey, nodeId: node || null, kind: parts[0] };
}

const isMain = !!process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write("usage: figma-link.mjs <figma.com URL>\n");
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(parse(arg))}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}

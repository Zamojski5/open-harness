#!/usr/bin/env node
// Smoke test on a real Figma file (local only): decode, check expected field names against its
// schema, write DIR/smoke-report.txt. Usage: node src/figma/smoke.ts FILE [--out DIR] [--svg]
// Exit 0 = all names found, 3 = mismatch (close matches listed), 1 = decode failed.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { decodeToDir, loadInput } from "./decode/decode.ts";
import { checkSchema, EXPECTED_FIELDS } from "./decode/schemaCheck.ts";
import { renderSvg } from "./svg/render.ts";

/** Schema field names that look like `want` (case-insensitive substring either way, or tiny edit distance). */
export function closeNames(want: string, names: Iterable<string>, max = 6): string[] {
  const w = want.toLowerCase();
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]!;
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = d[j]!;
        d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = t;
      }
    }
    return d[b.length]!;
  };
  const scored: [string, number][] = [];
  for (const n of new Set(names)) {
    const l = n.toLowerCase();
    if (l.includes(w) || (w.length > 3 && w.includes(l) && l.length > 3)) scored.push([n, 0]);
    else {
      const e = dist(w, l);
      if (e <= Math.max(2, Math.floor(w.length / 4))) scored.push([n, e]);
    }
  }
  return scored
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
    .slice(0, max)
    .map((s) => s[0]);
}

export function smoke(input: string, out: string, opts: { svg?: boolean } = {}) {
  const lines: string[] = [];
  const say = (s = "") => lines.push(s);
  const digest = decodeToDir(input, { out, images: "none" });
  const { schema } = loadInput(input);
  const fieldNames = schema.definitions
    .filter((d) => d.kind !== "ENUM")
    .flatMap((d) => d.fields.map((f) => f.name));
  const report = checkSchema(schema);

  say(`Figma decoder smoke report`);
  say(`input:   ${NodePath.resolve(input)}`);
  say(`decoded: ${digest.out}`);
  say(
    `schema:  ${NodePath.join(digest.out, "schema.txt")}  (${schema.definitions.length} definitions)`,
  );
  say(
    `magic ${digest.magic}, version ${digest.version}, ${digest.nodes} nodes, ${digest.pages.length} pages`,
  );
  say(
    `images listed ${digest.images}, fonts ${digest.fonts}, styles ${digest.styles}, variables ${digest.variables}`,
  );
  if ("fileKey" in digest)
    say(`paste: fileKey ${String(digest.fileKey)}, roots ${JSON.stringify(digest.roots)}`);
  say();
  say(`Expected field names (src/figma/decode/schemaCheck.ts) vs this file's schema:`);
  for (const [role, spec] of Object.entries(EXPECTED_FIELDS)) {
    const miss = report.missingFields[role] ?? [];
    say(
      `  ${miss.length ? "MISSING" : "ok     "} ${role.padEnd(11)} ${spec.critical ? "(critical) " : ""}${spec.feature}`,
    );
    for (const m of miss) {
      const near = closeNames(m, fieldNames);
      say(
        `            - ${m}${near.length ? `  → close in schema.txt: ${near.join(", ")}` : "  → nothing similar"}`,
      );
    }
  }
  if (report.missingEnumValues.length)
    say(`  MISSING enum values: ${report.missingEnumValues.join(", ")}`);
  say();
  const summary = JSON.parse(
    NodeFS.readFileSync(NodePath.join(digest.out, "summary.json"), "utf8"),
  );
  const warnings: string[] = summary.diagnostics?.warnings ?? [];
  say(warnings.length ? `Decode warnings:` : `Decode warnings: none`);
  for (const w of warnings) say(`  - ${w}`);
  say();
  say(`Node types (most common first):`);
  for (const [t, c] of Object.entries(summary.counts?.byType ?? {}).slice(0, 15))
    say(`  ${String(c).padStart(7)}  ${t}`);
  say();
  // Field names (not values) seen on the first node of the types the readers care most about.
  const firstOfType = new Map<string, string[]>();
  const nodesPath = NodePath.join(digest.out, "nodes.jsonl");
  for (const line of NodeFS.readFileSync(nodesPath, "utf8").split("\n")) {
    if (!line) continue;
    const n = JSON.parse(line) as Record<string, unknown>;
    const t = String(n.type ?? "?");
    if (
      [
        "CANVAS",
        "FRAME",
        "TEXT",
        "INSTANCE",
        "SYMBOL",
        "VECTOR",
        "RECTANGLE",
        "ROUNDED_RECTANGLE",
      ].includes(t) &&
      !firstOfType.has(t)
    )
      firstOfType.set(t, Object.keys(n).sort());
  }
  say(`Field names on the first node of each key type (compare with what the readers expect):`);
  for (const [t, keys] of firstOfType) say(`  ${t}: ${keys.join(", ")}`);
  say();
  const outline = NodeFS.readFileSync(NodePath.join(digest.out, "outline.txt"), "utf8").split("\n");
  say(`outline.txt, first 40 of ${outline.length - 1} lines:`);
  for (const l of outline.slice(0, 40)) say(`  ${l}`);
  if (opts.svg) {
    say();
    const frame = summary.pages
      ?.flatMap((p: { topLevel?: { id: string; type: string }[] }) => p.topLevel ?? [])
      .find((t: { type: string }) => t.type === "FRAME" || t.type === "SLIDE");
    if (frame) {
      try {
        const r = renderSvg(digest.out, frame.id);
        say(`svg of ${frame.id}: ${r.svg}  approximations ${JSON.stringify(r.approximations)}`);
      } catch (error) {
        say(`svg of ${frame.id} failed: ${(error as Error).message}`);
      }
    } else say(`svg: no top-level FRAME/SLIDE found to draw`);
  }
  say();
  const bad = Object.keys(report.missingFields).filter((r) => r !== "paste" || "fileKey" in digest);
  say(
    bad.length || warnings.length
      ? `RESULT: mismatch. Send smoke-report.txt and schema.txt to the developer (layer names appear only in the outline lines above; trim them if the file is confidential).`
      : `RESULT: every expected name was found.`,
  );
  const text = `${lines.join("\n")}\n`;
  NodeFS.writeFileSync(NodePath.join(digest.out, "smoke-report.txt"), text);
  return { text, mismatch: bad.length > 0 || warnings.length > 0 };
}

const isMain =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const input = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
  if (!input) {
    process.stderr.write("usage: node src/figma/smoke.ts FILE [--out DIR] [--svg]\n");
    process.exit(2);
  }
  const outAt = args.indexOf("--out");
  const out =
    outAt >= 0 && args[outAt + 1]
      ? NodePath.resolve(args[outAt + 1]!)
      : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "figma-smoke-"));
  try {
    const r = smoke(input, out, { svg: args.includes("--svg") });
    process.stdout.write(r.text);
    process.stdout.write(`(report saved to ${NodePath.join(out, "smoke-report.txt")})\n`);
    process.exit(r.mismatch ? 3 : 0);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message.split("\n")[0]}\n`);
    process.exit(1);
  }
}

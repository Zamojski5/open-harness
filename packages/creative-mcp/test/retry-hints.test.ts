import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const src = (f: string) =>
  NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../src/media", f),
    "utf8",
  );

describe("jobs_retry hints match its schema", () => {
  it("every jobs_retry {…} hint uses parameter names the tool accepts", () => {
    const tools = src("tools.ts");
    const start = tools.indexOf('"jobs_retry"');
    const schema = tools.slice(start, tools.indexOf("async (", start));
    const accepted = new Set([...schema.matchAll(/^\s{8}(\w+): z\b/gm)].map((m) => m[1]));
    expect(accepted).toContain("id");
    expect(accepted).toContain("confirm_fresh");
    const hints = [src("jobs.ts"), tools].join("\n");
    const used = new Set<string>();
    for (const m of hints.matchAll(/jobs_retry \{([^}]*)\}/g))
      for (const k of m[1]!.matchAll(/(\w+):/g)) used.add(k[1]!);
    for (const m of hints.matchAll(/jobs_retry[^\n]{0,80}?\b(confirm_fresh|fresh_confirm)\b/g))
      used.add(m[1]!);
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(accepted).toContain(k);
  });
});

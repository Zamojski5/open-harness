import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { setKeychainReader } from "../src/figma/token.ts";
import { childEnv, registerFigmaTools, runCli } from "../src/figma/tools.ts";
import { clipboardHtml, designFixture, figArchive } from "./figma-fixture.ts";
import { isolate } from "./isolate.ts";

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const env = isolate();
const tools = new Map<string, Handler>();
registerFigmaTools({
  registerTool: (name: string, _def: unknown, fn: Handler) => tools.set(name, fn),
} as unknown as McpServer);

let project = "";
beforeEach(() => {
  project = NodePath.join(env.home, "proj");
  NodeFS.mkdirSync(project, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(project);
  setKeychainReader(() => ({ token: null }));
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r = await tools.get(name)!(args);
  return { error: !!r.isError, text: r.content[0]!.text };
};

describe("figma tools", () => {
  it("registers the seven tools", () => {
    expect([...tools.keys()].sort()).toEqual([
      "figma_decode",
      "figma_get",
      "figma_images",
      "figma_outline",
      "figma_render",
      "figma_status",
      "figma_svg",
    ]);
  });

  it("decodes a paste into a fresh project folder, then outlines and draws it", async () => {
    NodeFS.writeFileSync(
      NodePath.join(project, "figma-selection-1.html"),
      clipboardHtml(designFixture().message, { fileKey: "PasteKey123" }),
    );
    const d = await call("figma_decode", { input: "figma-selection-1.html" });
    expect(d.error).toBe(false);
    const r = JSON.parse(d.text);
    expect(r.fileKey).toBe("PasteKey123");
    expect(
      r.out.startsWith(
        NodePath.join(project, ".open-herness", "tmp", "figma", "figma-selection-1-"),
      ),
    ).toBe(true);
    const o = await call("figma_outline", { dir: r.out, node: "1:14" });
    expect(o.text).toContain('FRAME "Masked" [1:14]');
    const s = await call("figma_svg", { dir: r.out, node: "1:10", pad: 4 });
    expect(JSON.parse(s.text)).toMatchObject({ node: "1:10", width: 200 });
  });

  it("handles project paths with spaces", async () => {
    const spaced = NodePath.join(project, "My Designs");
    NodeFS.mkdirSync(spaced);
    NodeFS.writeFileSync(NodePath.join(spaced, "a b.fig"), figArchive(designFixture()));
    const r = await call("figma_decode", {
      input: "My Designs/a b.fig",
      out: "My Designs/out dir",
    });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text).out).toBe(NodePath.join(spaced, "out dir"));
  });

  it("returns one error line for unreadable input", async () => {
    NodeFS.writeFileSync(NodePath.join(project, "other.html"), "<p>hi</p>");
    expect(await call("figma_decode", { input: "other.html", out: "x" })).toEqual({
      error: true,
      text: "error: this HTML holds no Figma copy data",
    });
  });

  it("decodes a local copy with --images all", async () => {
    NodeFS.writeFileSync(NodePath.join(project, "a.fig"), figArchive(designFixture()));
    const r = JSON.parse(
      (await call("figma_decode", { input: "a.fig", out: "dec", images: "all" })).text,
    );
    expect(r).toMatchObject({ imagesWritten: 2, out: NodePath.join(project, "dec") });
  });

  it("connection tools explain the Keychain step without a token", async () => {
    const r = await call("figma_get", { file: "AbCdEf12345", part: "file" });
    expect(r.error).toBe(true);
    const j = JSON.parse(r.text);
    expect(j.error).toBe("AUTH_REQUIRED");
    expect(j.hint).toContain(
      "security add-generic-password -U -s open-herness.figma -a FIGMA_TOKEN -w",
    );
    expect(j.hint).toContain("Never ask them to paste it");
    expect(JSON.parse((await call("figma_status", {})).text).state).toBe("not-connected");
  });

  it("gives the decoder child no secrets and stops it at the timeout with a clear message", async () => {
    const e = childEnv({
      PATH: "/bin",
      HOME: "/h",
      FAL_KEY: "k",
      FIGMA_TOKEN: "t",
      OPENAI_API_KEY: "o",
    });
    expect(e).toEqual({ PATH: "/bin", HOME: "/h" });
    const p = NodePath.join(project, "a.fig");
    NodeFS.writeFileSync(p, figArchive(designFixture()));
    const r = await runCli(["decode", p, "--out", NodePath.join(project, "o")], 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/stopped after|failed/);
  });
});

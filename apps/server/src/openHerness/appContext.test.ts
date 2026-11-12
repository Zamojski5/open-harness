// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  OPEN_HERNESS_APPS,
  findOpenHernessApp,
  formatOpenHernessAppReference,
  openHernessAppContextId,
  type OpenHernessApp,
} from "@t3tools/shared/openHernessApps";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  appAvailability,
  appContextRenderer,
  appIdForChip,
  configuredMcpServers,
  formatAppContext,
  mcpAppId,
} from "./appContext.ts";

let dir = "";
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-apps-"));
});
afterEach(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

const blender = findOpenHernessApp("blender")!;
const ready = (app: OpenHernessApp) => ({
  id: app.id,
  name: app.name,
  kind: app.kind,
  use: app.use,
  status: "ready" as const,
  detail: "/Applications/Blender.app",
});
const missing = (app: OpenHernessApp) => ({
  id: app.id,
  name: app.name,
  kind: app.kind,
  use: app.use,
  status: "not-installed" as const,
});

describe("catalog", () => {
  it("has unique ids, and every skill exists in the creative plugin", () => {
    const ids = OPEN_HERNESS_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    const skills = NodePath.resolve(
      import.meta.dirname,
      "../../../../packages/creative-mcp/plugin/skills",
    );
    for (const app of OPEN_HERNESS_APPS) {
      if (app.skill)
        expect(NodeFS.existsSync(NodePath.join(skills, app.skill, "SKILL.md"))).toBe(true);
    }
  });
});

describe("appAvailability", () => {
  it("finds versioned install folders by prefix", () => {
    NodeFS.mkdirSync(NodePath.join(dir, "Adobe After Effects 2026"));
    const app = {
      ...findOpenHernessApp("after-effects")!,
      installPaths: [`${dir}/Adobe After Effects*`],
    };
    expect(appAvailability(app)).toMatchObject({
      status: "installed",
      detail: NodePath.join(dir, "Adobe After Effects 2026"),
      skill: "after-effects",
    });
  });

  it("marks built-in tool apps ready, missing apps not installed, frameworks on demand", () => {
    NodeFS.mkdirSync(NodePath.join(dir, "Blender.app"));
    expect(appAvailability({ ...blender, installPaths: [`${dir}/Blender.app`] }).status).toBe(
      "ready",
    );
    expect(appAvailability({ ...blender, installPaths: [`${dir}/Nope.app`] }).status).toBe(
      "not-installed",
    );
    expect(appAvailability(findOpenHernessApp("remotion")!).status).toBe("on-demand");
  });

  it("counts a service as configured when an MCP server of that name exists", () => {
    const figma = { ...findOpenHernessApp("figma")!, installPaths: [`${dir}/Figma.app`] };
    expect(appAvailability(figma, [{ name: "figma-dev", source: "~/.claude.json" }])).toMatchObject(
      {
        status: "configured",
        detail: "~/.claude.json",
      },
    );
  });
});

describe("configuredMcpServers", () => {
  it("reads Claude user/project config, .mcp.json and Codex config", () => {
    const project = NodePath.join(dir, "project");
    NodeFS.mkdirSync(project);
    NodeFS.writeFileSync(
      NodePath.join(dir, ".claude.json"),
      JSON.stringify({
        mcpServers: { linear: {} },
        projects: { [project]: { mcpServers: { local: {} } } },
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: {} } }),
    );
    NodeFS.mkdirSync(NodePath.join(dir, ".codex"));
    NodeFS.writeFileSync(
      NodePath.join(dir, ".codex", "config.toml"),
      '[mcp_servers.effectcraft]\ncommand = "x"\n[mcp_servers."quoted"]\n',
    );
    expect(configuredMcpServers(project, dir).map((server) => server.name)).toEqual([
      "effectcraft",
      "linear",
      "local",
      "quoted",
      "shared",
    ]);
  });
});

describe("formatAppContext", () => {
  it("tells the agent to work in the app, load its skill and use its tools", () => {
    const body = formatAppContext("blender", null, ready);
    expect(body).toContain("Use Blender for this request; do the work in it");
    expect(body).toContain("Status: ready (/Applications/Blender.app).");
    expect(body).toContain("Load the skill open-herness:blender (Codex: blender)");
    expect(body).toContain("blender_*");
    expect(body).toContain("open Blender first and use the open-herness:computer-use skill");
  });

  it("stops and explains when the app is missing, without a fallback", () => {
    const body = formatAppContext("davinci-resolve", null, missing);
    expect(body).toContain("Status: not installed on this computer.");
    expect(body).toContain("Don't start the work and don't switch to another app.");
    expect(body).toContain("blackmagicdesign.com");
    expect(body).not.toContain("Load the skill");
  });

  it("asks which app for an unknown id", () => {
    expect(formatAppContext("<script>", null)).toBe(
      "Open Herness has no app with the id script. Before starting, check with the user which app the request is for.",
    );
  });

  it("explains an MCP server that is not configured", () => {
    expect(formatAppContext(mcpAppId("nowhere-xyz"), dir)).toContain(
      'MCP tool server "nowhere-xyz" for this request. It is not in this machine',
    );
  });
});

describe("app chips in the provider prompt", () => {
  it("resolves the app from the chip id, with or without a record", () => {
    expect(appIdForChip(openHernessAppContextId("davinci-resolve"), undefined, null)).toBe(
      "davinci-resolve",
    );
    expect(appIdForChip("app_whatever", { payload: { appId: "blender" } }, null)).toBe("blender");
    expect(appIdForChip("app_unknown", undefined, dir)).toBeUndefined();
  });

  it("expands an app chip into an app block inside the context envelope", () => {
    const text = `Make a logo sting ${formatOpenHernessAppReference(blender)} please`;
    expect(text).toContain("[Blender](t3-context://v1/app/app_blender)");
    const projected = projectComposerContextForProvider({
      text,
      records: [],
      renderEntry: appContextRenderer(null),
    });
    expect(projected).toContain("Make a logo sting [App: Blender; ref=app_blender] please");
    expect(projected).toContain('<context kind="app" id="app_blender">');
    expect(projected).toContain("Use Blender for this request;");
    expect(projected).not.toContain('unavailable="true"');
  });

  it("leaves other context kinds to the default renderer", () => {
    const render = appContextRenderer(null);
    expect(render({ kind: "thread", contextId: "x" as never, record: undefined })).toBeUndefined();
  });
});

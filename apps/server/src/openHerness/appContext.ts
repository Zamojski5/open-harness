// @effect-diagnostics nodeBuiltinImport:off - cheap synchronous install-path and config checks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ComposerContextEntryRenderer } from "@t3tools/shared/composerContextReferences";
import {
  MCP_APP_ID_PREFIX,
  OPEN_HERNESS_APP_CONTEXT_KIND,
  OPEN_HERNESS_APPS,
  findOpenHernessApp,
  openHernessAppIdForContextId,
  isOpenHernessAppAvailable,
  openHernessAppStatusLabel,
  type OpenHernessApp,
  type OpenHernessAppAvailability,
} from "@t3tools/shared/openHernessApps";

// Open Herness: which apps the "@" picker offers and what the agent is told when the user picks
// one. Status is always detected here, on the server.

const SKILL_PLUGIN = "open-herness";

function existingInstallPath(pattern: string): string | undefined {
  const expanded = pattern.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), pattern.slice(2))
    : pattern;
  if (!expanded.endsWith("*")) return NodeFS.existsSync(expanded) ? expanded : undefined;
  const dir = NodePath.dirname(expanded);
  const prefix = NodePath.basename(expanded).slice(0, -1);
  try {
    const match = NodeFS.readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .at(-1);
    return match === undefined ? undefined : NodePath.join(dir, match);
  } catch {
    return undefined;
  }
}

/** Also looks in ~/Applications for /Applications paths. */
function findInstallPath(app: OpenHernessApp): string | undefined {
  for (const path of app.installPaths ?? []) {
    const found =
      existingInstallPath(path) ??
      (path.startsWith("/Applications/")
        ? existingInstallPath(NodePath.join(NodeOS.homedir(), path))
        : undefined);
    if (found) return found;
  }
  return undefined;
}

export function appAvailability(
  app: OpenHernessApp,
  servers: ReadonlyArray<ConfiguredMcpServer> = [],
): OpenHernessAppAvailability {
  const base = {
    id: app.id,
    name: app.name,
    kind: app.kind,
    use: app.use,
    ...(app.skill ? { skill: app.skill } : {}),
  };
  if (app.kind === "framework") return { ...base, status: "on-demand" };
  const path = findInstallPath(app);
  if (path) return { ...base, status: app.builtInTools ? "ready" : "installed", detail: path };
  // A service (Figma, ComfyUI) also counts when an MCP server of that name is configured.
  const server =
    app.kind === "service"
      ? servers.find((entry) => entry.name.toLowerCase().includes(app.id))
      : undefined;
  return server
    ? { ...base, status: "configured", detail: server.source }
    : { ...base, status: "not-installed" };
}

export interface ConfiguredMcpServer {
  readonly name: string;
  /** Config file it was found in (home shortened to ~). */
  readonly source: string;
}

const tilde = (path: string) => {
  const home = NodeOS.homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const serverNames = (value: unknown): string[] =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];

/** Server names from ~/.claude.json (user + this project), <cwd>/.mcp.json and ~/.codex/config.toml. */
export function configuredMcpServers(
  cwd: string | null | undefined,
  home = NodeOS.homedir(),
): ConfiguredMcpServer[] {
  const found = new Map<string, ConfiguredMcpServer>();
  const add = (names: ReadonlyArray<string>, source: string) => {
    for (const name of names)
      if (!found.has(name)) found.set(name, { name, source: tilde(source) });
  };
  const claudeFile = NodePath.join(home, ".claude.json");
  const claude = readJsonObject(claudeFile);
  if (claude) {
    add(serverNames(claude.mcpServers), claudeFile);
    const projects = claude.projects as Record<string, { mcpServers?: unknown }> | undefined;
    if (cwd && projects && typeof projects === "object")
      add(serverNames(projects[cwd]?.mcpServers), claudeFile);
  }
  if (cwd) {
    const projectFile = NodePath.join(cwd, ".mcp.json");
    add(serverNames(readJsonObject(projectFile)?.mcpServers), projectFile);
  }
  const codexFile = NodePath.join(home, ".codex", "config.toml");
  try {
    const toml = NodeFS.readFileSync(codexFile, "utf8");
    const names = [...toml.matchAll(/^\s*\[mcp_servers\.("?)([^\]".]+)\1\]\s*$/gm)].map(
      (match) => match[2]!,
    );
    add(names, codexFile);
  } catch {
    // no Codex config
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function mcpAppId(serverName: string): string {
  return `${MCP_APP_ID_PREFIX}${serverName}`;
}

/** The picker's list: catalog apps plus configured MCP tool servers. */
export function listAppAvailability(cwd: string | null | undefined): OpenHernessAppAvailability[] {
  const servers = configuredMcpServers(cwd);
  const apps = OPEN_HERNESS_APPS.map((app) => appAvailability(app, servers));
  const known = new Set(apps.map((app) => app.id));
  for (const server of servers) {
    const id = mcpAppId(server.name);
    if (known.has(id) || known.has(server.name.toLowerCase())) continue;
    apps.push({
      id,
      name: server.name,
      kind: "service",
      use: "MCP tool server",
      status: "configured",
      detail: server.source,
    });
  }
  return apps;
}

const clean = (value: string, max = 600) => {
  const line = value.replace(/[<>"]/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Body of the app context entry for one picked app. Status is detected now. */
export function formatAppContext(
  appId: string,
  cwd: string | null | undefined,
  detect: (app: OpenHernessApp) => OpenHernessAppAvailability = (app) =>
    appAvailability(app, app.kind === "service" ? configuredMcpServers(cwd) : []),
): string {
  const id = clean(appId, 120);
  if (id.startsWith(MCP_APP_ID_PREFIX)) {
    const serverName = id.slice(MCP_APP_ID_PREFIX.length);
    const server = configuredMcpServers(cwd).find((entry) => entry.name === serverName);
    if (!server) {
      return [
        `Use the MCP tool server "${serverName}" for this request. It is not in this machine's Claude or Codex config.`,
        "Don't start the work and don't switch to another tool. Tell the user it isn't connected here and that they can add it to Claude Code (claude mcp add) or Codex (~/.codex/config.toml), then ask again.",
      ].join("\n");
    }
    return [
      `Use the MCP tool server "${serverName}" for this request: its tools (mcp__${serverName}__* in Claude), not a substitute.`,
      `Status: configured in ${server.source}; OH cannot tell whether it is connected. If its tools are missing in this chat, say so and tell the user to check the server, then stop instead of finishing another way.`,
    ].join("\n");
  }
  const app = findOpenHernessApp(id);
  if (!app) {
    return `Open Herness has no app with the id ${id}. Before starting, check with the user which app the request is for.`;
  }
  const availability = detect(app);
  const skillLine = app.skill
    ? `Load the skill ${SKILL_PLUGIN}:${app.skill} (Codex: ${app.skill}) before starting.`
    : "There is no skill for it; it is a manual app, so tell the user which steps they do themselves.";
  const lines = [
    `Use ${app.name} for this request; do the work in it, not in a substitute app or tool.`,
  ];
  if (!isOpenHernessAppAvailable(availability.status)) {
    lines.push(
      `Status: ${openHernessAppStatusLabel(availability.status)} on this computer.`,
      `Don't start the work and don't switch to another app. Tell the user ${app.name} isn't available here and how to get it: ${app.connect} Then wait for them.`,
    );
    return lines.map((line) => clean(line, 700)).join("\n");
  }
  lines.push(
    `Status: ${openHernessAppStatusLabel(availability.status)}${availability.detail ? ` (${tilde(availability.detail)})` : ""}.`,
    skillLine,
  );
  if (app.tools) lines.push(`Drive it with ${app.tools}`);
  if (app.kind === "desktop")
    lines.push(
      `If a step needs the app's window, open ${app.name} first and use the ${SKILL_PLUGIN}:computer-use skill.`,
    );
  return lines.map((line) => clean(line, 700)).join("\n");
}

/** App id of a chip: the record's payload when one came along, else resolved from its id. */
export function appIdForChip(
  contextId: string,
  record: unknown,
  cwd: string | null | undefined,
): string | undefined {
  const payload = (record as { payload?: { appId?: unknown } } | undefined)?.payload;
  if (typeof payload?.appId === "string") return payload.appId;
  return (
    openHernessAppIdForContextId(contextId) ??
    openHernessAppIdForContextId(
      contextId,
      configuredMcpServers(cwd).map((server) => mcpAppId(server.name)),
    )
  );
}

/** Renders app chips for the provider prompt; other kinds keep the default rendering. */
export function appContextRenderer(cwd: string | null | undefined): ComposerContextEntryRenderer {
  return ({ kind, contextId, record }) => {
    if (kind !== OPEN_HERNESS_APP_CONTEXT_KIND) return undefined;
    try {
      const appId = appIdForChip(contextId, record, cwd);
      return appId === undefined
        ? "This app chip doesn't match any app Open Herness has. Before starting, check with the user which app the request is for."
        : formatAppContext(appId, cwd);
    } catch {
      return "This app chip's status could not be read. Before starting, check with the user which app the request is for and that it is installed.";
    }
  };
}

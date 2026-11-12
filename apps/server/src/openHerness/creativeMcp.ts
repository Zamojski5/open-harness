// @effect-diagnostics nodeBuiltinImport:off - one synchronous path lookup when a session starts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import type * as Schema from "effect/Schema";
import { OPEN_HERNESS_APPS } from "@t3tools/shared/openHernessApps";
import { userWordsPublicKey } from "./hooks.ts";

// Open Herness: the creative MCP server (Blender and other open-source creative apps) is added
// to every Claude session. Located by walking up from this file to packages/creative-mcp.
const OPEN_HERNESS_CREATIVE_SERVER = "open-herness-creative";

function creativePackagePath(...parts: string[]): string | undefined {
  let dir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = NodePath.join(dir, "packages", "creative-mcp", ...parts);
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function openHernessCreativeMcpEntry(): string | undefined {
  return process.env.OPEN_HERNESS_CREATIVE_MCP ?? creativePackagePath("src", "server.ts");
}

// The creative skills ship as a local Claude Code plugin next to the MCP server.
export function openHernessPlugins(): { type: "local"; path: string }[] {
  const plugin = process.env.OPEN_HERNESS_PLUGIN ?? creativePackagePath("plugin");
  return plugin ? [{ type: "local", path: plugin }] : [];
}

const OPEN_HERNESS_HOME = NodePath.join(NodeOS.homedir(), ".open-herness");

// Creative apps the agent can choose from: [name, what it is for, install locations]. One list
// with the composer's "@" app picker (packages/shared/src/openHernessApps.ts).
const CREATIVE_APPS: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> =
  OPEN_HERNESS_APPS.flatMap((app) =>
    app.prompt === undefined ? [] : [[app.name, app.prompt, app.installPaths ?? []] as const],
  );

const CREATIVE_CLIS: ReadonlyArray<readonly [string, string]> = [
  ["ffmpeg", "cutting, concatenating, audio mixing, conversion (creative tool: ffmpeg)"],
  ["yt-dlp", "downloading reference videos the user points to"],
  ["magick", "ImageMagick batch image processing"],
];

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "")
    .split(NodePath.delimiter)
    .concat(["/opt/homebrew/bin", "/usr/local/bin"])
    .some((dir) => dir && NodeFS.existsSync(NodePath.join(dir, bin)));
}

function readText(path: string, limit = 6000): string | undefined {
  try {
    const text = NodeFS.readFileSync(path, "utf8").trim();
    return text ? text.slice(0, limit) : undefined;
  } catch {
    return undefined;
  }
}

function mediaKeysPresent(): string[] {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(
      NodeFS.readFileSync(NodePath.join(OPEN_HERNESS_HOME, "keys.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    // no stored keys
  }
  const has = (key: string, env: string) => Boolean(stored[key]) || Boolean(process.env[env]);
  return [
    has("falApiKey", "FAL_KEY") && "fal.ai",
    has("openaiApiKey", "OPENAI_API_KEY") && "OpenAI",
    has("googleApiKey", "GEMINI_API_KEY") && "Google",
    has("elevenLabsApiKey", "ELEVENLABS_API_KEY") && "ElevenLabs",
    has("runwareApiKey", "RUNWARE_API_KEY") && "Runware",
    has("replicateApiKey", "REPLICATE_API_TOKEN") && "Replicate",
  ].filter((k): k is string => typeof k === "string");
}

// The project brief (project_brief tool) is a "## Project brief" section in CLAUDE.md, which
// Claude Code loads itself, or in AGENTS.md, which it does not: inject it from AGENTS.md unless
// CLAUDE.md already carries the section or imports AGENTS.md.
function projectBriefFromAgentsMd(cwd: string | null): string | undefined {
  if (!cwd) return undefined;
  const claude = readText(NodePath.join(cwd, "CLAUDE.md"), 200_000);
  if (
    claude &&
    (/^## Project brief[ \t]*$/m.test(claude) || /(^|\s)@(\.\/)?AGENTS\.md\b/.test(claude))
  )
    return undefined;
  const agents = readText(NodePath.join(cwd, "AGENTS.md"), 200_000);
  const start = agents ? agents.search(/^## Project brief[ \t]*$/m) : -1;
  if (!agents || start < 0) return undefined;
  const rest = agents.slice(start + "## Project brief".length);
  const next = rest.search(/^## (?!#)/m);
  return agents
    .slice(start, next < 0 ? undefined : start + "## Project brief".length + next)
    .trim()
    .slice(0, 7000);
}

interface SpendSettings {
  askAboveUsd?: number;
  confirmVideoModel?: boolean;
  videoModel?: string;
}

function spendSettings(): SpendSettings {
  try {
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(OPEN_HERNESS_HOME, "media", "spend.json"), "utf8"),
    ) as SpendSettings;
  } catch {
    return {};
  }
}

// Paid generation rules for the agent: quote every batch first, ask above the user's limit, use the
// user's words for caps, offer the video model once per chat unless one is saved or named.
function paidGenerationRules(): string[] {
  const s = spendSettings();
  // Same rules as the creative server's settings(): a number from 0 to 10000, else $5.
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000;
  const envAsk = process.env.OH_ASK_ABOVE_USD ? Number(process.env.OH_ASK_ABOVE_USD) : undefined;
  const ask = valid(envAsk) ? envAsk : valid(s.askAboveUsd) ? s.askAboveUsd : 5;
  return [
    `Paid generations: quote the whole batch with media_estimate right before each paid batch (all takes, planned retakes, long or high-resolution takes included) and say who pays. ${ask === 0 ? "Ask the user before every paid generation." : `Ask before a paid batch that would take this chat above $${ask} since the last approval.`} An unknown price is never assumed to fit: quote an "up to" bound when there is one, otherwise ask. media_generate refuses with APPROVAL_REQUIRED and a card when approval is needed; show that card unchanged.`,
    "Spend less without losing quality: name the cheaper route when one exists (media_estimate shows every seller of the model and the 480p draft option for 1080p Seedance 2.5); variants are cheap drafts, and only the take the user keeps is finished (media_finish_draft) or upscaled (media_upscale); fix a kept take with edit/extend/insert rather than a re-roll; read the model's prompting guide before its first paid batch.",
    'A spend cap for this chat is raised only by the user\'s own words (spend_cap_set with their whole sentence, or a card option they picked with one option per cap and none marked recommended); lowering it always applies, and "free tools only" means local_only. When a cap or limit refuses a batch, nothing was sent: say what is short and what is saved vs not started, and ask (shrink to what fits, cheaper model, skip).',
    s.videoModel
      ? `Video model: the user's saved choice is ${s.videoModel}; it outranks a skill's default. If it can't do the task, say so and ask.`
      : s.confirmVideoModel === false
        ? ""
        : "Before the first paid video in this chat, unless the user already named a model: present the idea first, then offer 2-3 models that suit this video with the whole-piece cost of each (media_quote_plan), recommend one with a few-word reason, and ask with the question card. Use the picked model for every clip in this chat unless the user changes it. Don't offer to save it as a preference.",
  ].filter(Boolean);
}

// Environment block for the system prompt: which creative apps exist on this Mac, which paid
// generation keys are set, the user's preferences and the house-style rules learned so far.
export function openHernessCreativeInstructions(cwd: string | null): string {
  if (creativeDisabled()) return "";
  const apps = CREATIVE_APPS.filter(([, , paths]) => paths.some((p) => NodeFS.existsSync(p)));
  const missing = CREATIVE_APPS.filter((a) => !apps.includes(a)).map(([name]) => name);
  const clis = CREATIVE_CLIS.filter(([bin]) => onPath(bin));
  const keys = mediaKeysPresent();
  const prefs = readText(NodePath.join(OPEN_HERNESS_HOME, "preferences.md"));
  const globalStyle = readText(NodePath.join(OPEN_HERNESS_HOME, "house-style.md"));
  const projectStyle = cwd
    ? readText(NodePath.join(cwd, ".open-herness", "house-style.md"))
    : undefined;
  const brief = projectBriefFromAgentsMd(cwd);
  return [
    "<open_herness_environment>",
    "You are working in Open Herness, a creative studio: pick the best tool for each part of the job from what is installed, and combine apps when that gives a better result. Load the matching skill (outcome skills like make-3d-scene, make-motion-graphics, make-trailer, make-image; app skills like blender, effectcraft; choose-tool when unsure which app fits; quality-loop for every visual result) before starting creative work.",
    `Installed creative apps: ${apps.map(([name, use]) => `${name} (${use})`).join("; ") || "none detected"}.`,
    `Command-line tools: ${clis.map(([bin, use]) => `${bin} (${use})`).join("; ") || "none"}.`,
    `Not installed (offer to install if clearly better for the task, never silently): ${missing.join(", ") || "-"}.`,
    `Paid generation keys set: ${keys.join(", ") || "none (prefer local tools; ask before asking for a key)"}.`,
    "Outputs go to ./takes/ (never overwrite earlier takes), references to ./references/<board>/, scenes and projects to ./scenes/.",
    ...paidGenerationRules(),
    prefs ? `User preferences:\n${prefs}` : "",
    globalStyle || projectStyle
      ? `House style (rules learned from the user's corrections; follow them, they override defaults):\n${[globalStyle, projectStyle].filter(Boolean).join("\n")}`
      : "",
    brief
      ? `Project brief and decisions (from AGENTS.md; keep it current with project_brief):\n${brief}`
      : "",
    "</open_herness_environment>",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface StdioMcpServerConfig {
  readonly type: "stdio";
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

// EffectCraft ships its own MCP server in effectcraft-cli; bridged to the desktop app's control
// port (opened by the creative server's effectcraft_launch), it connects lazily on first use.
function effectcraftCli(): string | undefined {
  return [
    process.env.OH_EFFECTCRAFT_CLI,
    NodePath.join(NodeOS.homedir(), ".open-herness", "bin", "effectcraft-cli"),
    "/opt/homebrew/bin/effectcraft-cli",
    "/usr/local/bin/effectcraft-cli",
  ].find((p): p is string => !!p && NodeFS.existsSync(p));
}

// Upstream adapter tests replay exact provider frames; they switch the Open Herness additions off.
function creativeDisabled(): boolean {
  return process.env.OH_CREATIVE_MCP === "off";
}

// The chat a creative server works for: generation spend, caps and approvals are kept per thread,
// and the user's own words (recorded by the hooks per Claude session) are read for that session.
export interface CreativeChat {
  readonly threadId: string;
  readonly sessionId?: string;
}

export function openHernessCreativeMcpServers(
  chat?: CreativeChat,
): Record<string, StdioMcpServerConfig> {
  const servers: Record<string, StdioMcpServerConfig> = {};
  if (creativeDisabled()) return servers;
  const entry = openHernessCreativeMcpEntry();
  if (entry) {
    servers[OPEN_HERNESS_CREATIVE_SERVER] = {
      type: "stdio",
      command: process.execPath,
      args: [entry],
      // Lets an Electron-hosted server reuse its own binary as Node.
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ...(chat ? { OH_THREAD_ID: chat.threadId } : {}),
        // The user's words are read only for this Claude session, verified with this key.
        ...(chat?.sessionId
          ? { OH_SESSION_ID: chat.sessionId, OH_WORDS_KEY: userWordsPublicKey() }
          : {}),
      },
    };
  }
  const cli = effectcraftCli();
  if (cli) {
    servers.effectcraft = {
      type: "stdio",
      command: cli,
      args: ["mcp", "--bridge", process.env.OH_EFFECTCRAFT_PORT ?? "9877"],
      env: {},
    };
  }
  // The other Craft apps run their MCP servers headless (no window, low memory); the agent saves
  // the file in the project and craft_launch opens it in the desktop app for the user.
  const home = NodeOS.homedir();
  const roots = ["--automation-read-root", home, "--automation-write-root", home];
  const crafts: Record<string, string[]> = {
    lightcraft: [
      "mcp",
      "--compact",
      "--library",
      NodePath.join(OPEN_HERNESS_HOME, "lightcraft-library"),
    ],
    photocraft: ["mcp", ...roots],
    vectorcraft: ["mcp", "--headless", ...roots],
    filmcraft: ["mcp"],
    designcraft: ["mcp", ...roots],
  };
  for (const [name, args] of Object.entries(crafts)) {
    const bin = NodePath.join(OPEN_HERNESS_HOME, "bin", `${name}-cli`);
    if (NodeFS.existsSync(bin)) servers[name] = { type: "stdio", command: bin, args, env: {} };
  }
  return servers;
}

// Codex threads get the same creative MCP servers (as dotted config overrides, like T3's own
// server) and the environment block as developer instructions. Long renders need a long timeout.
export function openHernessCodexConfig(
  cwd: string | null,
  threadId?: string | null,
): Record<string, Schema.Json> {
  const config: Record<string, Schema.Json> = {};
  if (creativeDisabled()) return config;
  const chat = threadId ? { threadId } : undefined;
  for (const [name, server] of Object.entries(openHernessCreativeMcpServers(chat))) {
    config[`mcp_servers.${name}`] = {
      command: server.command,
      args: server.args,
      env: server.env,
      startup_timeout_sec: 30,
      tool_timeout_sec: 3600,
      // Our own local tools: approved like T3's server, otherwise Codex blocks them in full access.
      default_tools_approval_mode: "approve",
    };
  }
  config.developer_instructions = openHernessCreativeInstructions(cwd).replace(
    "Load the matching skill",
    "Use the matching skill from ~/.codex/skills/open-herness",
  );
  return config;
}

// Skill folders for Codex: the plugin's skills plus Codex-format copies of the studio agents.
export function openHernessCodexSkillRoots(): string[] {
  if (creativeDisabled()) return [];
  return [
    creativePackagePath("plugin", "skills"),
    creativePackagePath("plugin", "codex-skills"),
  ].filter((p): p is string => p !== undefined);
}

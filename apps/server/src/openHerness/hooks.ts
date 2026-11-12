// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalRandom:off - SDK hook callbacks run outside Effect and read small local files synchronously.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

import { boundToolResult } from "@open-herness/creative-mcp/spill";

import { openHernessCreativeMcpServers } from "./creativeMcp.ts";
import {
  checkBudgetQuote,
  checkStopRequest,
  clearUserInterrupt,
  qualityGoalStop,
} from "./qualityGoalHooks.ts";

// Open Herness: Agent SDK hooks that enforce creative-harness rules in code instead of only
// stating them in the prompt.

const RENDER_TOOLS = [
  /^mcp__open-herness-creative__(blender_render|media_generate)$/,
  /^mcp__effectcraft__(command_run|execute_command|render_frame)$/,
];
const PRESENT_TOOLS =
  /^mcp__open-herness-creative__(takes_log|media_review|media_frames|craft_launch)$/;
const MEDIA_FILE = /\.(mp4|mov|webm|mkv|m4v|png|jpe?g|webp|gif|exr|wav|mp3|m4a)$/i;
const NUDGE_AFTER_MS = 8 * 60_000;

interface TurnState {
  startedAt: number;
  renders: number;
  presented: boolean;
  skills: Set<string>;
}

// One state per session; subagents share their parent's session id, so their renders count too.
const turns = new Map<string, TurnState>();

function turnOf(sessionId: string): TurnState {
  let state = turns.get(sessionId);
  if (!state) {
    state = { startedAt: Date.now(), renders: 0, presented: false, skills: new Set() };
    turns.set(sessionId, state);
  }
  return state;
}

function inputOf(input: HookInput): Record<string, unknown> {
  const raw = (input as { tool_input?: unknown }).tool_input;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

const toolName = (input: HookInput) => (input as { tool_name?: string }).tool_name ?? "";
const cwdOf = (input: HookInput) => (input as { cwd?: string }).cwd ?? process.cwd();

function failed(input: HookInput): boolean {
  const response = (input as { tool_response?: unknown }).tool_response;
  if (!response || typeof response !== "object") return false;
  const r = response as {
    isError?: boolean;
    is_error?: boolean;
    exitCode?: number;
    interrupted?: boolean;
  };
  return (
    r.isError === true ||
    r.is_error === true ||
    (typeof r.exitCode === "number" && r.exitCode !== 0) ||
    r.interrupted === true
  );
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// A shell command renders media when ffmpeg writes a video/audio file, Blender renders in the
// background, or Remotion renders; stills, null outputs and single frames are previews, not renders.
function bashRenders(command: string): boolean {
  if (/\bffmpeg\b/.test(command)) {
    if (
      /-f\s+null\b/.test(command) ||
      /-frames:v\s+1\b|-vframes\s+1\b/.test(command) ||
      /\btile=/.test(command)
    )
      return false;
    return /\.(mp4|mov|webm|mkv|m4v|wav|mp3|m4a|aac|flac|gif)\b/i.test(
      command.split(/\bffmpeg\b/).at(-1) ?? "",
    );
  }
  if (/\bblender\b[\s\S]*\s-b\b/.test(command) && /\s-(a|f|o)\b/.test(command)) return true;
  return /\bremotion\s+render\b/.test(command);
}

// A foreground shell loop that sleeps for minutes keeps the user's next message unread until it
// ends; long waits belong in background tasks or the job tools.
const pollGuard = async (input: HookInput): Promise<HookJSONOutput> => {
  const tool = inputOf(input);
  const command = typeof tool.command === "string" ? tool.command : "";
  const timeout = typeof tool.timeout === "number" ? tool.timeout : 0;
  const looping = /\b(while|until|for)\b[\s\S]*\bsleep\s+\d/.test(command);
  if (tool.run_in_background === true || !looping || timeout <= 120_000) return {};
  return deny(
    "Open Herness: no foreground polling loops longer than 2 minutes, so the user's messages are read promptly. Run long waits with run_in_background (you are notified when it ends), use jobs_wait for generations, or wait in bounded steps of at most 2 minutes.",
  );
};

const PRESENT_REMINDER =
  "Open Herness: the user has not seen any result this turn although you have rendered. Show the latest result now (path to the file in ./takes/ plus one line on what changed), then continue.";

// Present nudge: once there are renders and nothing was shown (2+ renders, or 1 render and 8
// minutes into the turn), remind after every following tool call until something is presented.
const presentNudge = async (input: HookInput): Promise<HookJSONOutput> => {
  const state = turnOf(input.session_id);
  const name = toolName(input);
  const tool = inputOf(input);
  if (name === "Skill" && typeof tool.skill === "string") state.skills.add(tool.skill);
  if (PRESENT_TOOLS.test(name)) state.presented = true;
  if (
    name === "Read" &&
    typeof tool.file_path === "string" &&
    MEDIA_FILE.test(tool.file_path) &&
    /\/takes\//.test(tool.file_path)
  )
    state.presented = true;
  if (!failed(input)) {
    if (RENDER_TOOLS.some((pattern) => pattern.test(name))) {
      if (!name.startsWith("mcp__effectcraft__") || JSON.stringify(tool).includes("render"))
        state.renders += 1;
    } else if (name === "Bash" && typeof tool.command === "string" && bashRenders(tool.command))
      state.renders += 1;
  }
  if (state.presented || state.renders === 0) return {};
  if (state.renders < 2 && Date.now() - state.startedAt < NUDGE_AFTER_MS) return {};
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: PRESENT_REMINDER },
  };
};

// Read-ready: an image read while it is still being written shows a broken half. Wait until the
// file is complete (PNG IEND, JPEG FFD9, WebP RIFF size) or its size has settled for 500 ms.
function imageComplete(path: string): boolean | undefined {
  let data: Buffer;
  try {
    data = NodeFS.readFileSync(path);
  } catch {
    return undefined;
  }
  if (data.length === 0) return false;
  if (/\.png$/i.test(path)) return data.subarray(-12).includes(Buffer.from("IEND"));
  if (/\.jpe?g$/i.test(path))
    return data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
  if (/\.webp$/i.test(path)) return data.length >= 8 && data.readUInt32LE(4) + 8 <= data.length;
  return undefined;
}

const readReady = async (input: HookInput): Promise<HookJSONOutput> => {
  const tool = inputOf(input);
  const path = typeof tool.file_path === "string" ? tool.file_path : "";
  if (!/\.(png|jpe?g|webp|gif)$/i.test(path) || !NodeFS.existsSync(path)) return {};
  const deadline = Date.now() + 5_000;
  let lastSize = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const complete = imageComplete(path);
    if (complete === true) return {};
    const size = NodeFS.statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size !== lastSize) {
      lastSize = size;
      stableSince = Date.now();
    } else if (complete === undefined && size > 0 && Date.now() - stableSince >= 500) return {};
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return deny(
    `Open Herness: ${path} is still being written (${lastSize === 0 ? "empty" : "incomplete"}). Read it again after the command that writes it has finished.`,
  );
};

// Question images: a question that shows local images that don't exist is refused, with the
// closest existing file of the same name as a suggestion.
function findByName(name: string, roots: string[]): string | undefined {
  const deadline = Date.now() + 250;
  const home = NodeOS.homedir();
  const queue = roots.filter((root) => root !== home && root !== "/");
  let seen = 0;
  while (queue.length && seen < 20_000 && Date.now() < deadline) {
    const dir = queue.shift()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      const full = NodePath.join(dir, entry.name);
      if (entry.isFile() && entry.name === name) return full;
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
        queue.push(full);
    }
  }
  return undefined;
}

const questionImages = async (input: HookInput): Promise<HookJSONOutput> => {
  const cwd = cwdOf(input);
  const text = JSON.stringify(inputOf(input));
  const missing: string[] = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s"]+)\)/g)) {
    const ref = match[1]!;
    if (/^(https?:|data:)/.test(ref)) continue;
    const full = NodePath.resolve(cwd, ref.replace(/^file:\/\//, ""));
    if (NodeFS.existsSync(full)) continue;
    let near = NodePath.dirname(full);
    while (!NodeFS.existsSync(near) && near !== NodePath.dirname(near))
      near = NodePath.dirname(near);
    const found = findByName(NodePath.basename(full), [near, cwd]);
    missing.push(found ? `${ref} (did you mean ${NodePath.relative(cwd, found)}?)` : ref);
  }
  if (!missing.length) return {};
  return deny(
    `Open Herness: the question shows images that don't exist, so the user would see nothing: ${missing.join("; ")}. Fix the paths and ask again.`,
  );
};

// Subagent result: an empty hand-back hides whether anything was done.
const subagentResult = async (input: HookInput): Promise<HookJSONOutput> => {
  const response = (input as { tool_response?: unknown }).tool_response;
  const record =
    response && typeof response === "object"
      ? (response as { content?: unknown; totalToolUseCount?: number })
      : undefined;
  const body =
    typeof response === "string" ? response : JSON.stringify(record?.content ?? response ?? "");
  if (body.replace(/"(type|text)"\s*:\s*"text"|[\s{}[\],":]/g, "").replace(/text/g, "").length > 20)
    return {};
  const calls = Number(record?.totalToolUseCount ?? 0);
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        calls === 0
          ? "Open Herness: the subagent returned nothing and made no tool calls, so nothing was done. Do the work yourself; don't delegate it again."
          : `Open Herness: the subagent made ${calls} tool calls but returned no report. Check what it changed (files, takes, scene) before relying on it.`,
    },
  };
};

// After compaction: carry this project's recent generation jobs and the loaded skills forward.
interface JobRecord {
  id: string;
  projectPath?: string;
  state: string;
  model: string;
  title?: string;
  createdAt: number;
  outputs?: string[];
  error?: { message?: string } | string;
}

function recentJobs(cwd: string): string[] {
  const dir = NodePath.join(NodeOS.homedir(), ".open-herness", "media", "jobs");
  let files: string[];
  try {
    files = NodeFS.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const since = Date.now() - 24 * 3600_000;
  const jobs: JobRecord[] = [];
  for (const file of files) {
    try {
      const job = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, file), "utf8")) as JobRecord;
      if (job.projectPath === cwd && job.createdAt >= since) jobs.push(job);
    } catch {
      // unreadable job record
    }
  }
  const done = new Set(["completed", "failed", "cancelled", "uncertain"]);
  jobs.sort(
    (a, b) => Number(done.has(a.state)) - Number(done.has(b.state)) || b.createdAt - a.createdAt,
  );
  return jobs.slice(0, 12).map((job) => {
    const outputs = (job.outputs ?? []).map((o) => NodePath.relative(cwd, o));
    const shown =
      outputs.slice(0, 4).join(", ") +
      (outputs.length > 4 ? ` and ${outputs.length - 4} more` : "");
    const error = typeof job.error === "string" ? job.error : job.error?.message;
    return `- ${job.id} ${job.state} ${job.model}${job.title ? ` "${job.title}"` : ""}${shown ? ` → ${shown}` : ""}${error ? ` (error: ${error.slice(0, 160)})` : ""}`;
  });
}

const compactionContext = async (input: HookInput): Promise<HookJSONOutput> => {
  if ((input as { source?: string }).source !== "compact") return {};
  const jobs = recentJobs(cwdOf(input));
  const skills = [...(turns.get(input.session_id)?.skills ?? [])];
  const lines = [
    jobs.length
      ? `Generation jobs in this project (last 24 h, unfinished first):\n${jobs.join("\n")}`
      : "",
    skills.length
      ? `Skills loaded earlier in this chat (load them again before relying on them): ${skills.join(", ")}.`
      : "",
    "The project brief from AGENTS.md is still in the system prompt.",
  ].filter(Boolean);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Open Herness, after compaction:\n${lines.join("\n")}`,
    },
  };
};

// The user's prompts and card picks, signed with a key that exists only in this process; the
// creative server verifies them with the public half, so lines anyone else appends never count
// as the user's words (caps and approvals rely on that).
const SIGNING = NodeCrypto.generateKeyPairSync("ed25519");
const USER_WORDS_MAX_BYTES = 4 * 1024 * 1024;
const USER_WORDS_MAX_AGE_MS = 30 * 24 * 3600_000;

const ohHome = () => process.env.OH_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");
const userWordsFile = () => NodePath.join(ohHome(), "media", "user-words.jsonl");

/** Public key (base64 SPKI DER) the creative server verifies user-words records with. */
export function userWordsPublicKey(): string {
  return SIGNING.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

interface UserWordsRecord {
  v: 2;
  at: number;
  session: string;
  cwd: string;
  source: "prompt" | "card";
  text: string;
  question?: string;
  picked?: boolean;
}

// Same field order as the creative server's verifier (packages/creative-mcp/src/media/words.ts).
const canonical = (r: UserWordsRecord) =>
  JSON.stringify([
    r.v,
    r.at,
    r.session,
    r.cwd,
    r.source,
    r.text,
    r.question ?? null,
    r.picked ?? null,
  ]);

function withWordsLock(fn: () => void) {
  const lock = `${userWordsFile()}.lock`;
  const token = `${process.pid}-${NodeCrypto.randomUUID()}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      NodeFS.mkdirSync(lock);
      NodeFS.writeFileSync(NodePath.join(lock, "owner"), token);
      try {
        fn();
      } finally {
        // Remove only our own lock (a stale-lock breaker may have replaced it).
        try {
          if (NodeFS.readFileSync(NodePath.join(lock, "owner"), "utf8") === token)
            NodeFS.rmSync(lock, { recursive: true, force: true });
        } catch {
          // already gone
        }
      }
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - NodeFS.statSync(lock).mtimeMs > 10_000)
          NodeFS.rmSync(lock, { recursive: true, force: true });
      } catch {
        // someone else removed it
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.random() * 20);
    }
  }
}

/** Keep the file private, recent and small: drop lines older than 30 days, then the oldest beyond 4 MB. */
function rotate(file: string) {
  const size = NodeFS.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  const day = new Date().toISOString().slice(0, 10);
  const marker = `${file}.rotated`;
  const rotatedToday = NodeFS.existsSync(marker) && NodeFS.readFileSync(marker, "utf8") === day;
  if (size <= USER_WORDS_MAX_BYTES && rotatedToday) return;
  const cutoff = Date.now() - USER_WORDS_MAX_AGE_MS;
  let lines = NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      try {
        return (JSON.parse(line) as { at?: number }).at! >= cutoff;
      } catch {
        return false;
      }
    });
  while (lines.join("\n").length > USER_WORDS_MAX_BYTES / 2)
    lines = lines.slice(Math.ceil(lines.length / 4));
  NodeFS.writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o600 });
  NodeFS.writeFileSync(marker, day, { mode: 0o600 });
}

function recordUserWords(
  input: HookInput,
  entry: { source: "prompt" | "card"; text: string; question?: string; picked?: boolean },
) {
  // Nothing is kept when the creative tools are off (coding-only setups).
  if (process.env.OH_CREATIVE_MCP === "off" || !entry.text.trim()) return;
  const file = userWordsFile();
  const record: UserWordsRecord = {
    v: 2,
    at: Date.now(),
    session: input.session_id,
    cwd: cwdOf(input),
    source: entry.source,
    text: entry.text.slice(0, 8000),
    ...(entry.question !== undefined ? { question: entry.question.slice(0, 8000) } : {}),
    ...(entry.picked !== undefined ? { picked: entry.picked } : {}),
  };
  const sig = NodeCrypto.sign(null, Buffer.from(canonical(record)), SIGNING.privateKey).toString(
    "base64",
  );
  try {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
    // an existing folder keeps its old mode; only the user may list it
    NodeFS.chmodSync(NodePath.dirname(file), 0o700);
    withWordsLock(() => {
      if (NodeFS.existsSync(file)) rotate(file);
      NodeFS.appendFileSync(file, `${JSON.stringify({ ...record, sig })}\n`, { mode: 0o600 });
      NodeFS.chmodSync(file, 0o600);
    });
  } catch {
    // spend checks then find no words and refuse caps/approvals; the chat goes on
  }
}

// Messages the agent or the app wrote (t3_thread_send, routines, scheduled tasks) reach Claude as
// prompts too. The adapter notes them here before sending; they are never the user's words.
const AGENT_PROMPT_TTL_MS = 10 * 60_000;
const agentPrompts = new Map<string, { text: string; at: number }[]>();
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

export function noteAgentPrompt(sessionId: string, text: string) {
  const now = Date.now();
  const kept = (agentPrompts.get(sessionId) ?? []).filter((p) => now - p.at < AGENT_PROMPT_TTL_MS);
  kept.push({ text: squash(text), at: now });
  agentPrompts.set(sessionId, kept.slice(-20));
}

function takeAgentPrompt(sessionId: string, prompt: string): boolean {
  const list = agentPrompts.get(sessionId) ?? [];
  const seen = squash(prompt);
  const i = list.findIndex(
    (p) =>
      Date.now() - p.at < AGENT_PROMPT_TTL_MS &&
      p.text.length > 0 &&
      (seen === p.text || seen.includes(p.text) || p.text.includes(seen)),
  );
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

const recordPrompt = async (input: HookInput): Promise<HookJSONOutput> => {
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || takeAgentPrompt(input.session_id, prompt)) return {};
  recordUserWords(input, { source: "prompt", text: prompt });
  return {};
};

interface CardQuestion {
  question?: string;
  options?: { label?: string }[];
}

// Answers of a question card. The tool result (AskUserQuestionOutput) carries
// answers: { question text → picked label or typed text } and, per question, an `unanswered`
// annotation when the user skipped, dismissed or replied in chat instead; those are not answers.
const recordCardAnswers = async (input: HookInput): Promise<HookJSONOutput> => {
  if (failed(input)) return {};
  const tool = inputOf(input);
  const response = (input as { tool_response?: unknown }).tool_response;
  const out = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const answers = (out.answers ?? tool.answers) as Record<string, unknown> | undefined;
  if (!answers || typeof answers !== "object") return {};
  const annotations = (out.annotations ?? tool.annotations ?? {}) as Record<
    string,
    { unanswered?: string } | undefined
  >;
  const questions = ((out.questions ?? tool.questions) as CardQuestion[] | undefined) ?? [];
  for (const [question, answer] of Object.entries(answers)) {
    if (typeof answer !== "string" || annotations[question]?.unanswered) continue;
    const labels =
      questions.find((q) => q.question === question)?.options?.map((o) => o.label) ?? [];
    recordUserWords(input, {
      source: "card",
      question,
      text: answer,
      picked: labels.includes(answer),
    });
  }
  return {};
};

// The spend state (user words, approvals, caps, ledger, limit) is not the agent's to edit: block
// file tools and shell commands that would write there. Best effort: it stops casual edits; the
// signatures above are what make forged user words useless.
const SPEND_STATE =
  /\.open-herness|\bOH_HOME\b|\bOPEN_HERNESS_HOME\b|user-words|ledger\.jsonl|spend\.json/;
const WRITES =
  /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\btruncate\b|\bchmod\b|\bln\b|\btouch\b|\bpython3?\b|\bnode\b|\bperl\b|\bruby\b|\bdd\b|\binstall\b|\bsponge\b|\brsync\b|\bunlink\b|\bcd\b)/;

/** The real location of a path, following symlinks through its nearest existing ancestor. */
function realLocation(path: string): string {
  let dir = NodePath.resolve(path);
  const rest: string[] = [];
  while (!NodeFS.existsSync(dir) && NodePath.dirname(dir) !== dir) {
    rest.unshift(NodePath.basename(dir));
    dir = NodePath.dirname(dir);
  }
  try {
    return NodePath.join(NodeFS.realpathSync(dir), ...rest);
  } catch {
    return NodePath.resolve(path);
  }
}

const spendStateGuard = async (input: HookInput): Promise<HookJSONOutput> => {
  const name = toolName(input);
  const tool = inputOf(input);
  // Quotes and backslashes are dropped first, so `.open-her'ness'` still matches.
  const command = typeof tool.command === "string" ? tool.command.replace(/['"\\]/g, "") : "";
  const media = realLocation(NodePath.join(ohHome(), "media"));
  const target =
    name === "Bash"
      ? SPEND_STATE.test(command) && WRITES.test(command)
      : typeof tool.file_path === "string" &&
        (realLocation(tool.file_path).startsWith(media) ||
          NodePath.resolve(tool.file_path).startsWith(NodePath.join(ohHome(), "media")));
  if (!target) return {};
  return deny(
    "Open Herness: generation spend state (~/.open-herness/media: the user's words, approvals, caps, ledger, limits) is changed only through the spend tools and the user. Use spend_status / spend_cap_set, or ask the user.",
  );
};

// Oversized results of other MCP servers (the creative server and T3's own already bound theirs):
// the full text goes to .open-herness/spill/<thread>/ and the model gets head + tail + the path.
const SELF_BOUNDED = /^mcp__(open-herness-creative|t3-code)__/;

export function spillMcpResult(input: HookInput, threadId: string | undefined): HookJSONOutput {
  const name = toolName(input);
  if (!name.startsWith("mcp__") || SELF_BOUNDED.test(name)) return {};
  const response = (input as { tool_response?: unknown }).tool_response;
  type Block = { type: string; text?: string };
  const asResult = Array.isArray(response)
    ? { content: response as Block[] }
    : typeof response === "string"
      ? { content: [{ type: "text", text: response }] }
      : response &&
          typeof response === "object" &&
          Array.isArray((response as { content?: unknown }).content)
        ? (response as { content: Block[] })
        : undefined;
  if (!asResult) return {};
  const bounded = boundToolResult(asResult, { tool: name, cwd: cwdOf(input), threadId });
  if (bounded === asResult) return {};
  const updatedToolOutput = Array.isArray(response)
    ? bounded.content
    : typeof response === "string"
      ? bounded.content?.map((block) => block.text ?? "").join("\n")
      : bounded;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } };
}

// Each user message starts a new turn for the quality-goal hold count.
const userTurns = new Map<string, number>();

const resetOnUserMessage = async (input: HookInput): Promise<HookJSONOutput> => {
  const skills = turns.get(input.session_id)?.skills ?? new Set<string>();
  turns.set(input.session_id, { startedAt: Date.now(), renders: 0, presented: false, skills });
  userTurns.set(input.session_id, (userTurns.get(input.session_id) ?? 0) + 1);
  return {};
};

const GOAL_TOOL = "mcp__open-herness-creative__goal_";

export function openHernessHooks(
  options: { readonly threadId?: string } = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const threadId = options.threadId;
  const creativeToolsAvailable = "open-herness-creative" in openHernessCreativeMcpServers();
  return {
    PreToolUse: [
      { matcher: "Bash", hooks: [pollGuard] },
      { matcher: "Read", hooks: [readReady] },
      { matcher: "AskUserQuestion", hooks: [questionImages] },
      { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [spendStateGuard] },
      { matcher: `${GOAL_TOOL}set`, hooks: [async (input) => checkBudgetQuote(input)] },
      { matcher: `${GOAL_TOOL}end`, hooks: [async (input) => checkStopRequest(input, threadId)] },
    ],
    PostToolUse: [
      { hooks: [presentNudge] },
      { matcher: "Task|Agent", hooks: [subagentResult] },
      { matcher: "AskUserQuestion", hooks: [recordCardAnswers] },
      { matcher: "mcp__.*", hooks: [async (input) => spillMcpResult(input, threadId)] },
    ],
    SessionStart: [{ hooks: [compactionContext] }],
    UserPromptSubmit: [
      { hooks: [resetOnUserMessage, recordPrompt] },
      {
        hooks: [
          async () => {
            if (threadId !== undefined) clearUserInterrupt(threadId);
            return {};
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          async (input) =>
            qualityGoalStop(
              input,
              threadId,
              `${input.session_id}:${userTurns.get(input.session_id) ?? 0}`,
              { creativeToolsAvailable },
            ),
        ],
      },
    ],
  };
}

// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { openHernessCreativeMcpServers } from "./creativeMcp.ts";
import { noteAgentPrompt, openHernessHooks, userWordsPublicKey } from "./hooks.ts";

let home = "";
const KEYS = [
  "OH_HOME",
  "OH_CREATIVE_MCP",
  "OH_THREAD_ID",
  "OH_SESSION_ID",
  "OH_WORDS_KEY",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-hooks-"));
  process.env.OH_HOME = home;
  // the server test config switches the creative tools off; these tests are about them
  delete process.env.OH_CREATIVE_MCP;
});
afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
  for (const k of KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

type Decision = { hookSpecificOutput?: { permissionDecision?: string } };
const run = async (
  event: "UserPromptSubmit" | "PostToolUse" | "PreToolUse",
  input: Record<string, unknown>,
) => {
  const out: Decision[] = [];
  for (const matcher of openHernessHooks()[event] ?? [])
    if (!matcher.matcher || new RegExp(`^(${matcher.matcher})$`).test(String(input.tool_name)))
      for (const hook of matcher.hooks)
        out.push(
          (await hook(input as unknown as HookInput, undefined, {
            signal: new AbortController().signal,
          })) as Decision,
        );
  return out;
};
const base = {
  session_id: "s1",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/p",
  permission_mode: "default",
};
const wordsFile = () => NodePath.join(home, "media", "user-words.jsonl");
const recorded = () =>
  NodeFS.readFileSync(wordsFile(), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// The creative server's own modules, loaded by path (not a dependency of the app server).
const creative = (file: string) =>
  import(
    NodeURL.pathToFileURL(
      NodePath.resolve(import.meta.dirname, "../../../../packages/creative-mcp/src/media", file),
    ).href
  ) as Promise<Record<string, unknown>>;

/** A PostToolUse for AskUserQuestion as the SDK reports it (AskUserQuestionInput/Output). */
const cardAnswered = (
  question: string,
  labels: string[],
  answer: string,
  unanswered?: "skipped" | "replied_in_chat" | "dismissed",
) => {
  const questions = [
    {
      question,
      header: "Approve spend",
      multiSelect: false,
      options: labels.map((label) => ({ label, description: label })),
    },
  ];
  return {
    ...base,
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_1",
    // canUseTool hands the answers back as updated input…
    tool_input: { questions, answers: { [question]: answer } },
    // …and the tool result echoes them, with annotations for unanswered questions.
    tool_response: {
      questions,
      answers: { [question]: answer },
      ...(unanswered ? { annotations: { [question]: { unanswered } } } : {}),
    },
  };
};

describe("user words for spend checks", () => {
  it("records prompts and picked answers, signed, private, never the offered options", async () => {
    await run("UserPromptSubmit", {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "Spend up to $20.",
    });
    await run("PostToolUse", cardAnswered("Cap?", ["Up to $5", "Up to $50"], "Up to $5"));
    const lines = recorded();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      v: 2,
      session: "s1",
      cwd: "/p",
      source: "prompt",
      text: "Spend up to $20.",
    });
    expect(lines[1]).toMatchObject({
      source: "card",
      question: "Cap?",
      text: "Up to $5",
      picked: true,
    });
    expect(typeof lines[1]!.sig).toBe("string");
    expect(JSON.stringify(lines)).not.toContain("Up to $50");
    expect(NodeFS.statSync(wordsFile()).mode & 0o777).toBe(0o600);
  });

  it("typed answers are not picks; skipped or dismissed questions are not answers", async () => {
    await run("PostToolUse", cardAnswered("Cap?", ["Up to $5"], "maybe $7?"));
    await run("PostToolUse", cardAnswered("Go?", ["Approve $9.00", "Cancel"], "", "dismissed"));
    await run(
      "PostToolUse",
      cardAnswered("Go2?", ["Approve $9.00", "Cancel"], "x", "replied_in_chat"),
    );
    expect(recorded()).toEqual([expect.objectContaining({ text: "maybe $7?", picked: false })]);
  });

  it("nothing is recorded when the creative tools are off", async () => {
    process.env.OH_CREATIVE_MCP = "off";
    await run("UserPromptSubmit", { ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(NodeFS.existsSync(wordsFile())).toBe(false);
  });

  it("drops records older than 30 days when it rotates", async () => {
    NodeFS.mkdirSync(NodePath.dirname(wordsFile()), { recursive: true });
    NodeFS.writeFileSync(wordsFile(), `${JSON.stringify({ v: 2, at: 1, text: "old" })}\n`);
    await run("UserPromptSubmit", { ...base, hook_event_name: "UserPromptSubmit", prompt: "new" });
    expect(recorded().map((l) => l.text)).toEqual(["new"]);
  });

  it("M2b: an SDK-shaped card answer approves through the creative server; nothing else does", async () => {
    process.env.OH_THREAD_ID = "thread-1";
    process.env.OH_SESSION_ID = "s1";
    process.env.OH_WORDS_KEY = userWordsPublicKey();
    const spend = await creative("spend.ts");
    const issue = spend.issueApproval as (
      fp: string,
      q: object,
    ) => { id: string; question: string; approveLabel: string };
    const use = spend.useApproval as (id: string, fp: string, q: object) => { ok: boolean };
    const a = issue("fp-1", { usd: 9, usdMax: 9 });
    // the agent's own line with the right text but no app signature
    NodeFS.mkdirSync(NodePath.dirname(wordsFile()), { recursive: true });
    NodeFS.appendFileSync(
      wordsFile(),
      `${JSON.stringify({ v: 2, at: Number.MAX_SAFE_INTEGER, session: "s1", cwd: "/p", source: "card", question: a.question, text: a.approveLabel, picked: true, sig: "AAAA" })}\n`,
    );
    expect(use(a.id, "fp-1", { usd: 9, usdMax: 9 }).ok).toBe(false);
    await run("PostToolUse", cardAnswered(a.question, [a.approveLabel, "Cancel"], "Cancel"));
    expect(use(a.id, "fp-1", { usd: 9, usdMax: 9 }).ok).toBe(false);
    await run("PostToolUse", cardAnswered(a.question, [a.approveLabel, "Cancel"], a.approveLabel));
    expect(use(a.id, "fp-1", { usd: 9, usdMax: 9 }).ok).toBe(true);
  });
});

describe("re-review R2: messages the agent or the app sent are not the user's words", () => {
  it("a noted agent prompt is not recorded; the user's own next prompt is", async () => {
    noteAgentPrompt("s1", "Spend up to $500.");
    await run("UserPromptSubmit", {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "Spend up to $500.",
    });
    await run("UserPromptSubmit", {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "Make it $10 instead.",
    });
    expect(recorded().map((l) => l.text)).toEqual(["Make it $10 instead."]);
  });

  it("a note for another session does not hide this session's prompt", async () => {
    noteAgentPrompt("other", "Spend up to $20.");
    await run("UserPromptSubmit", {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "Spend up to $20.",
    });
    expect(recorded()).toHaveLength(1);
  });

  it("the media folder is tightened to 0700", async () => {
    NodeFS.mkdirSync(NodePath.join(home, "media"), { recursive: true, mode: 0o755 });
    await run("UserPromptSubmit", { ...base, hook_event_name: "UserPromptSubmit", prompt: "x" });
    expect(NodeFS.statSync(NodePath.join(home, "media")).mode & 0o777).toBe(0o700);
  });
});

describe("spend state guard", () => {
  const pre = (tool_name: string, tool_input: Record<string, unknown>) =>
    run("PreToolUse", {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name,
      tool_input,
      tool_use_id: "t",
    });
  const denied = (out: Decision[]) =>
    out.some((o) => o.hookSpecificOutput?.permissionDecision === "deny");

  it("blocks shell and file writes to the spend state, allows reading it", async () => {
    expect(
      denied(await pre("Bash", { command: "echo '{}' >> ~/.open-herness/media/user-words.jsonl" })),
    ).toBe(true);
    expect(denied(await pre("Bash", { command: "rm ~/.open-herness/media/ledger.jsonl" }))).toBe(
      true,
    );
    expect(
      denied(await pre("Write", { file_path: NodePath.join(home, "media", "spend.json") })),
    ).toBe(true);
    expect(denied(await pre("Bash", { command: "tail ~/.open-herness/media/ledger.jsonl" }))).toBe(
      false,
    );
    expect(denied(await pre("Write", { file_path: "/p/notes.md" }))).toBe(false);
  });

  it("re-review R1: cd, quoting and symlinks don't get around it", async () => {
    expect(
      denied(
        await pre("Bash", {
          command: "cd ~/.open-herness && cd media/chats && jq . a.json > t && mv t a.json",
        }),
      ),
    ).toBe(true);
    expect(
      denied(
        await pre("Bash", { command: "echo '{}' | sponge ~/.open-herness/me'dia'/spend.json" }),
      ),
    ).toBe(true);
    expect(denied(await pre("Bash", { command: "ln -s ~/.open-her'ness' /tmp/oh" }))).toBe(true);
    NodeFS.mkdirSync(NodePath.join(home, "media", "chats"), { recursive: true });
    const link = NodePath.join(NodeOS.tmpdir(), `oh-link-${process.pid}`);
    NodeFS.rmSync(link, { force: true });
    NodeFS.symlinkSync(home, link);
    try {
      expect(
        denied(await pre("Write", { file_path: NodePath.join(link, "media", "chats", "t1.json") })),
      ).toBe(true);
    } finally {
      NodeFS.rmSync(link, { force: true });
    }
  });
});

describe("creative server environment", () => {
  it("gets its chat, session and the words key (public only)", () => {
    process.env.OH_CREATIVE_MCP = "on";
    const servers = openHernessCreativeMcpServers({ threadId: "thread-9", sessionId: "s9" });
    const env = servers["open-herness-creative"]?.env ?? {};
    expect(env).toMatchObject({
      OH_THREAD_ID: "thread-9",
      OH_SESSION_ID: "s9",
      OH_WORDS_KEY: userWordsPublicKey(),
    });
    expect(JSON.stringify(env)).not.toMatch(/PRIVATE/);
  });
});

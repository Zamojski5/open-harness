// goal_review's reviewer: a separate tool-free model call that sees only the goal and stills of
// references and work, never the agent's reasoning. It runs the Claude Code
// CLI on the user's subscription with the chat's model (OH_CHAT_MODEL) and no tools or settings.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const REVIEW_LIMITS = {
  stillWidth: 1024,
  referenceStills: 4,
  maxReferenceFiles: 6,
  workStills: 16,
  stillsPerVideo: 8,
  minStillsPerFile: 2,
  stillTimeoutMs: 30_000,
  maxOutputTokens: 2000,
  callTimeoutMs: 300_000,
  maxImageBytes: 5_242_880,
  maxGaps: 8,
  maxStrengths: 4,
} as const;

export interface ReviewAnswer {
  score: number;
  meetsBar: boolean;
  gaps: string[];
  strengths: string[];
  summary: string;
}

export interface ReviewResult extends ReviewAnswer {
  judgedFrom: string;
  reviewer: string;
}

export interface Still {
  label: string;
  path: string;
}

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "meetsBar", "gaps", "strengths", "summary"],
  properties: {
    score: { type: "number", minimum: 0, maximum: 10, description: "0-10, one decimal" },
    meetsBar: { type: "boolean", description: "true only if the work clears the target score" },
    gaps: {
      type: "array",
      maxItems: REVIEW_LIMITS.maxGaps,
      items: { type: "string" },
      description: "concrete shortfalls against the references, biggest impact first",
    },
    strengths: { type: "array", maxItems: REVIEW_LIMITS.maxStrengths, items: { type: "string" } },
    summary: { type: "string", description: "at most two sentences" },
  },
} as const;

const SYSTEM = [
  "You review creative work for a demanding director. Score the new version from 0 to 10 against the reference images and the stated bar.",
  "Calibration: 5 = competent but clearly behind the references (most first attempts land here); 8 = could sit next to the references with only minor notes; 9-10 = as good as or better than the references.",
  "Judge only what the images show. For video stills, judge staging, consistency between shots, continuity and finish; do not guess motion, timing or sound.",
  "List gaps as specific, fixable observations (what is wrong, where, and what it should look like), highest impact first. Be strict: do not round up.",
].join("\n");

const run = (
  bin: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      bin,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(Object.assign(error, { stderr: String(stderr) }))
          : resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
  });

async function probeDuration(path: string): Promise<number> {
  try {
    const { stdout } = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type:format=duration",
        "-of",
        "json",
        path,
      ],
      REVIEW_LIMITS.stillTimeoutMs,
    );
    const info = JSON.parse(stdout) as {
      streams?: Array<{ codec_type?: string }>;
      format?: { duration?: string };
    };
    const duration = Number(info.format?.duration ?? 0);
    return info.streams?.some((s) => s.codec_type === "video") && duration > 0.5 ? duration : 0;
  } catch {
    return 0;
  }
}

/** Evenly spaced times at the centres of `count` equal segments. */
export function stillTimes(duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
}

/** JPEG stills of one file: one for an image, `count` evenly spaced for a video. Throws when none work. */
export async function extractStills(
  file: string,
  count: number,
  dir: string,
  prefix: string,
): Promise<Still[]> {
  const duration = await probeDuration(file);
  const times = duration > 0 ? stillTimes(duration, count) : [undefined];
  const stills: Still[] = [];
  for (const [i, t] of times.entries()) {
    const out = NodePath.join(dir, `${prefix}-${i}.jpg`);
    try {
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          ...(t === undefined ? [] : ["-ss", t.toFixed(3)]),
          "-i",
          file,
          "-frames:v",
          "1",
          "-vf",
          `scale='min(${REVIEW_LIMITS.stillWidth},iw)':-2`,
          "-q:v",
          "3",
          out,
        ],
        REVIEW_LIMITS.stillTimeoutMs,
      );
      const size = NodeFS.statSync(out).size;
      if (size > 0 && size <= REVIEW_LIMITS.maxImageBytes)
        stills.push({
          label: `${NodePath.basename(file)}${t === undefined ? "" : ` at ${t.toFixed(1)}s`}`,
          path: out,
        });
    } catch {
      // a failed still is skipped
    }
  }
  if (stills.length === 0) throw new Error(`Could not read any still from ${file}`);
  return stills;
}

export function workStillCount(files: number): number {
  return Math.max(
    REVIEW_LIMITS.minStillsPerFile,
    Math.min(REVIEW_LIMITS.stillsPerVideo, Math.floor(REVIEW_LIMITS.workStills / files)),
  );
}

export function reviewPrompt(input: {
  objective: string;
  target: number;
  criteria: string[];
  references: Still[];
  work: Still[];
  note?: string | undefined;
}): string {
  return [
    `Goal: ${input.objective}`,
    `Target score: ${input.target}/10`,
    input.criteria.length ? `The bar:\n${input.criteria.map((c) => `- ${c}`).join("\n")}` : "",
    input.references.length
      ? `Reference images (in order): ${input.references.map((s, i) => `R${i + 1} ${s.label}`).join("; ")}`
      : "There are no reference images; judge against the goal and the bar alone.",
    `New version (in order, after the references): ${input.work.map((s, i) => `W${i + 1} ${s.label}`).join("; ")}`,
    input.note ? `What changed in this version, per the maker: ${input.note}` : "",
    "Return the JSON answer only.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Clamp, round and force meetsBar off below the target. */
export function finishAnswer(raw: unknown, target: number): ReviewAnswer | undefined {
  const a = raw as Partial<ReviewAnswer> | undefined;
  if (
    !a ||
    typeof a.score !== "number" ||
    !Number.isFinite(a.score) ||
    typeof a.meetsBar !== "boolean"
  )
    return undefined;
  const score = Math.round(Math.min(10, Math.max(0, a.score)) * 10) / 10;
  const strings = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];
  return {
    score,
    meetsBar: a.meetsBar && score >= target,
    gaps: strings(a.gaps, REVIEW_LIMITS.maxGaps),
    strengths: strings(a.strengths, REVIEW_LIMITS.maxStrengths),
    summary: typeof a.summary === "string" ? a.summary : "",
  };
}

function reviewerCommand(): string {
  return process.env.OH_GOAL_REVIEWER_CMD || "claude";
}

/** One tool-free model call over the stills; returns the parsed structured answer. */
export async function callReviewer(input: {
  prompt: string;
  images: Still[];
  model?: string | undefined;
}): Promise<{ answer: unknown; reviewer: string }> {
  const content = [
    ...input.images.map((still) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: NodeFS.readFileSync(still.path).toString("base64"),
      },
    })),
    { type: "text", text: input.prompt },
  ];
  const line = JSON.stringify({ type: "user", message: { role: "user", content } });
  const model = input.model || process.env.OH_CHAT_MODEL || "";
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM,
    "--json-schema",
    JSON.stringify(ANSWER_SCHEMA),
    ...(model ? ["--model", model] : []),
  ];
  // Thinking off, so adaptive-thinking models (Opus) cannot spend the 2000-token answer budget on
  // thinking; the subscription is used, never an API key from the server's environment.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(REVIEW_LIMITS.maxOutputTokens),
    MAX_THINKING_TOKENS: "0",
  };
  delete env.ANTHROPIC_API_KEY;
  // A nested CLI refuses to start inside another session's environment.
  for (const key of [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "T3CODE_THREAD_ID",
  ])
    delete env[key];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(reviewerCommand(), args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), REVIEW_LIMITS.callTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`reviewer exited with ${code}: ${(err || out).trim().slice(-400)}`));
    });
    child.stdin.end(`${line}\n`);
  });
  const result = stdout
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((m) => m?.type === "result");
  if (!result) throw new Error("the reviewer returned no result");
  if (result.is_error === true)
    throw new Error(String(result.result ?? "the reviewer failed").slice(0, 400));
  let answer = result.structured_output;
  if (answer === undefined && typeof result.result === "string") {
    try {
      answer = JSON.parse(/\{[\s\S]*\}/.exec(result.result)?.[0] ?? "");
    } catch {
      answer = undefined;
    }
  }
  const usage = result.modelUsage as Record<string, unknown> | undefined;
  return { answer, reviewer: Object.keys(usage ?? {})[0] ?? (model || "claude") };
}

/** Samples stills of references and work, asks the reviewer, and returns the finished verdict. */
export async function reviewWork(input: {
  objective: string;
  target: number;
  criteria: string[];
  references: string[];
  work: string[];
  note?: string | undefined;
}): Promise<ReviewResult> {
  const dir = NodePath.join(NodeOS.tmpdir(), `oh-goal-review-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(dir, { recursive: true });
  try {
    const references: Still[] = [];
    for (const [i, file] of input.references.slice(0, REVIEW_LIMITS.maxReferenceFiles).entries())
      references.push(
        ...(await extractStills(file, REVIEW_LIMITS.referenceStills, dir, `ref${i}`)),
      );
    const perFile = workStillCount(input.work.length);
    const work: Still[] = [];
    for (const [i, file] of input.work.entries())
      work.push(...(await extractStills(file, perFile, dir, `work${i}`)));
    const prompt = reviewPrompt({ ...input, references, work });
    const { answer, reviewer } = await callReviewer({ prompt, images: [...references, ...work] });
    const finished = finishAnswer(answer, input.target);
    if (!finished) throw new Error("the reviewer gave no usable score");
    return {
      ...finished,
      judgedFrom: `${work.length} stills of the work beside ${references.length} of the references`,
      reviewer,
    };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off extendsNativeError:off - snapshot capture shells out to git and stats files directly.
// Open Herness: turn checkpoints for project folders outside git. A private bare repository per
// folder, kept outside the project, records incremental snapshot commits so the changed-files view
// works. Media and large files are stored only as stubs. Captures run in a per-folder queue.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type CheckpointRef,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as VcsDriver from "../vcs/VcsDriver.ts";

const KB = 1024;
const SNAPSHOT_MAX_FILES = 20_000;
/** Snapshots kept per folder, and their maximum age; older ones are deleted and gc'd. */
const SNAPSHOT_KEEP = 200;
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 3600_000;
/** Above this repository size the oldest half of the snapshots is dropped. */
const SNAPSHOT_REPO_MAX_BYTES = 512 * 1024 * 1024;
/** New file content stored by one capture; past it, everything else in that capture is a stub. */
const SNAPSHOT_CAPTURE_BUDGET_BYTES = 32 * 1024 * 1024;
const SAMPLE_BYTES = 64 * KB;
/** How long a capture may hold up the caller (turn start) before it continues in the background. */
const CAPTURE_WAIT_MS = 3_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EXCLUDES = [
  ".git/",
  ".open-herness/",
  "node_modules/",
  ".DS_Store",
  "*.blend1",
  "*.blend@",
  "__pycache__/",
  ".cache/",
  "cache/",
  "*.tmp",
];
/** Renders, footage, audio and app scene files: stubbed above OH_SNAPSHOT_MEDIA_MAX_KB (default 0). */
const MEDIA = new Set(
  (
    "png jpg jpeg exr tif tiff tga bmp webp gif heic psd psb kra xcf hdr dpx avif " +
    "mp4 mov m4v mkv webm avi mxf prores wav mp3 m4a aac flac aif aiff ogg " +
    "blend abc fbx glb gltf usd usda usdc usdz obj ply stl vdb pdf ai eps sketch fig"
  ).split(" "),
);
const OPERATION = "SnapshotCheckpoints";

const envKb = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * KB : fallback;
};
/** Size limits for stored content (see module header). */
const snapshotLimits = () => ({
  fileBytes: envKb("OH_SNAPSHOT_MAX_FILE_KB", 512 * KB),
  mediaBytes: envKb("OH_SNAPSHOT_MEDIA_MAX_KB", 0),
});

const ohHome = () =>
  process.env.OPEN_HERNESS_HOME || NodePath.join(NodeOS.homedir(), ".open-herness");

/** Folders never snapshotted: roots, the home folder, its standard (often synced) folders, Library. */
function excludedFolder(resolved: string): boolean {
  const home = NodeOS.homedir();
  if (resolved === NodePath.parse(resolved).root || resolved === home) return true;
  const standard = ["Desktop", "Documents", "Downloads", "Movies", "Pictures", "Music", "Public"];
  if (standard.some((name) => resolved === NodePath.join(home, name))) return true;
  const library = NodePath.join(home, "Library");
  if (resolved === library || resolved.startsWith(`${library}${NodePath.sep}`)) return true;
  return /^\/Volumes\/[^/]+$/.test(resolved);
}

/** A folder can be snapshotted when it exists and is not one of the excluded folders. */
export function isSnapshotEligible(cwd: string): boolean {
  if (process.env.OH_SNAPSHOT_CHECKPOINTS === "off") return false;
  const resolved = NodePath.resolve(cwd);
  if (excludedFolder(resolved)) return false;
  try {
    return NodeFS.statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/** The folder's snapshot repository, outside the project: $OPEN_HERNESS_HOME/checkpoints/<hash>.git. */
export function snapshotGitDir(cwd: string): string {
  const key = NodeCrypto.createHash("sha256").update(NodePath.resolve(cwd)).digest("hex");
  return NodePath.join(ohHome(), "checkpoints", `${key.slice(0, 20)}.git`);
}

// A server started from inside a git hook or worktree must not leak its repository into ours.
function withoutGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!key.startsWith("GIT_")) clean[key] = value;
  return clean;
}

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { stdin?: string; indexFile?: string; maxBuffer?: number; bare?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      "git",
      ["-c", "core.quotePath=false", "-c", "core.autocrlf=false", ...args],
      {
        cwd,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        timeout: 120_000,
        env: {
          ...withoutGitEnv(process.env),
          GIT_DIR: snapshotGitDir(cwd),
          ...(options.bare === true ? {} : { GIT_WORK_TREE: cwd }),
          ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
          GIT_AUTHOR_NAME: "Open Herness",
          GIT_AUTHOR_EMAIL: "snapshots@open-herness.local",
          GIT_COMMITTER_NAME: "Open Herness",
          GIT_COMMITTER_EMAIL: "snapshots@open-herness.local",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : -1
          : 0;
        if (error && code === -1) reject(error);
        else resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

async function gitOk(
  cwd: string,
  args: ReadonlyArray<string>,
  options?: Parameters<typeof git>[2],
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0)
    throw new Error(
      `git ${args[0]} failed (${result.code}): ${result.stderr.trim().slice(0, 400)}`,
    );
  return result.stdout;
}

async function ensureRepository(cwd: string): Promise<void> {
  const dir = snapshotGitDir(cwd);
  if (!NodeFS.existsSync(NodePath.join(dir, "HEAD"))) {
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await gitOk(cwd, ["init", "--bare", "--quiet", dir], { bare: true });
    await gitOk(cwd, ["config", "gc.auto", "0"], { bare: true });
    NodeFS.writeFileSync(NodePath.join(dir, "oh-folder"), `${NodePath.resolve(cwd)}\n`);
  }
  NodeFS.mkdirSync(NodePath.join(dir, "info"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "info", "exclude"), `${EXCLUDES.join("\n")}\n`);
}

interface Entry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: string;
  readonly oid: string;
}
type State = Record<string, Entry>;

const stateFile = (cwd: string) => NodePath.join(snapshotGitDir(cwd), "oh-state.json");

function readState(cwd: string): State {
  try {
    return JSON.parse(NodeFS.readFileSync(stateFile(cwd), "utf8")) as State;
  } catch {
    return {};
  }
}

/** sha1 of the first and last 64 KB plus the size: cheap change detection for stubbed files. */
function sampleHash(path: string, size: number): string {
  const hash = NodeCrypto.createHash("sha1").update(String(size));
  const fd = NodeFS.openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
    NodeFS.readSync(fd, head, 0, head.length, 0);
    hash.update(head);
    if (size > SAMPLE_BYTES) {
      const tail = Buffer.alloc(Math.min(SAMPLE_BYTES, size - SAMPLE_BYTES));
      NodeFS.readSync(fd, tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  return hash.digest("hex");
}

function stubText(path: string, stat: NodeFS.Stats): string {
  return [
    "Open Herness snapshot stub (content not stored)",
    `size: ${stat.size} bytes`,
    `modified: ${stat.mtime.toISOString()}`,
    `sample-sha1: ${sampleHash(path, stat.size)}`,
    "",
  ].join("\n");
}

const extensionOf = (file: string) => NodePath.extname(file).slice(1).toLowerCase();

/** Records the folder as a snapshot commit under `checkpointRef`; only changed files are read. */
async function captureSnapshot(cwd: string, checkpointRef: string): Promise<void> {
  await ensureRepository(cwd);
  const limits = snapshotLimits();
  const dir = snapshotGitDir(cwd);
  const indexFile = NodePath.join(dir, `capture-index-${NodeCrypto.randomUUID()}`);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-snapshot-"));
  try {
    const listed = await gitOk(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], {
      indexFile,
    });
    // Nested repositories are listed as "dir/"; they are left out of the snapshot.
    const files = listed.split("\0").filter((file) => file.length > 0 && !file.endsWith("/"));
    if (files.length > SNAPSHOT_MAX_FILES)
      throw new SnapshotTooLarge(`${files.length} files (limit ${SNAPSHOT_MAX_FILES})`);
    const previous = readState(cwd);
    const next: State = {};
    const toHash: Array<{
      file: string;
      source: string;
      size: number;
      mtimeMs: number;
      mode: string;
    }> = [];
    let budget = SNAPSHOT_CAPTURE_BUDGET_BYTES;
    for (const file of files) {
      const full = NodePath.join(cwd, file);
      let stat: NodeFS.Stats;
      try {
        stat = NodeFS.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) continue;
      const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
      const known = previous[file];
      if (
        known &&
        known.size === stat.size &&
        known.mtimeMs === stat.mtimeMs &&
        known.mode === mode
      ) {
        next[file] = known;
        continue;
      }
      const limit = MEDIA.has(extensionOf(file)) ? limits.mediaBytes : limits.fileBytes;
      let source = full;
      if (mode === "120000") {
        source = NodePath.join(scratch, `${toHash.length}.link`);
        NodeFS.writeFileSync(source, NodeFS.readlinkSync(full));
      } else if (stat.size > limit || stat.size > budget) {
        source = NodePath.join(scratch, `${toHash.length}.stub`);
        NodeFS.writeFileSync(source, stubText(full, stat));
      } else budget -= stat.size;
      toHash.push({ file, source, size: stat.size, mtimeMs: stat.mtimeMs, mode });
    }
    if (toHash.length > 0) {
      const oids = (
        await gitOk(cwd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
          indexFile,
          stdin: `${toHash.map((entry) => entry.source).join("\n")}\n`,
        })
      )
        .trim()
        .split("\n");
      for (const [i, entry] of toHash.entries())
        next[entry.file] = {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          mode: entry.mode,
          oid: oids[i]!,
        };
    }
    const entries = Object.entries(next);
    if (entries.length > 0)
      await gitOk(cwd, ["update-index", "--add", "-z", "--index-info"], {
        indexFile,
        stdin: entries.map(([file, entry]) => `${entry.mode} ${entry.oid}\t${file}\0`).join(""),
      });
    const tree =
      entries.length > 0 ? (await gitOk(cwd, ["write-tree"], { indexFile })).trim() : EMPTY_TREE;
    const commit = (
      await gitOk(cwd, ["commit-tree", tree, "-m", `open herness snapshot ${checkpointRef}`])
    ).trim();
    await gitOk(cwd, ["update-ref", checkpointRef, commit]);
    const partial = `${stateFile(cwd)}.partial`;
    NodeFS.writeFileSync(partial, JSON.stringify(next));
    NodeFS.renameSync(partial, stateFile(cwd));
  } finally {
    NodeFS.rmSync(indexFile, { force: true });
    NodeFS.rmSync(`${indexFile}.lock`, { force: true });
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  await pruneSnapshots(cwd);
}

async function repositoryBytes(cwd: string): Promise<number> {
  const out = await gitOk(cwd, ["count-objects", "-v"], { bare: true });
  const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)`, "m").exec(out)?.[1] ?? 0);
  return (field("size") + field("size-pack")) * KB;
}

/** Keeps the newest SNAPSHOT_KEEP snapshots younger than 30 days, under the size cap; gc after. */
async function pruneSnapshots(cwd: string, now = Date.now()): Promise<number> {
  const listed = await gitOk(
    cwd,
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname) %(committerdate:unix)"],
    { bare: true },
  );
  const refs = listed
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", at = "0"] = line.split(" ");
      return { name, atMs: Number(at) * 1000 };
    });
  let drop = refs.filter((ref, i) => i >= SNAPSHOT_KEEP || now - ref.atMs > SNAPSHOT_MAX_AGE_MS);
  const kept = refs.filter((ref) => !drop.includes(ref));
  if (
    drop.length === 0 &&
    kept.length > 1 &&
    (await repositoryBytes(cwd)) > SNAPSHOT_REPO_MAX_BYTES
  )
    drop = kept.slice(Math.ceil(kept.length / 2));
  if (drop.length === 0) return 0;
  await gitOk(cwd, ["update-ref", "--stdin"], {
    bare: true,
    stdin: drop.map((ref) => `delete ${ref.name}\n`).join(""),
  });
  await gc(cwd);
  return drop.length;
}

async function gc(cwd: string): Promise<void> {
  await git(cwd, ["reflog", "expire", "--expire=now", "--all"], { bare: true });
  await git(cwd, ["gc", "--prune=now", "--quiet"], { bare: true });
}

class SnapshotTooLarge extends Error {}

async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  if (!NodeFS.existsSync(NodePath.join(snapshotGitDir(cwd), "HEAD"))) return null;
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    bare: true,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

// One queue per folder: a capture is enqueued and returns at once (off the turn-start path);
// every later operation on the folder waits for the captures before it.
const queues = new Map<string, Promise<unknown>>();

function enqueue<A>(cwd: string, run: () => Promise<A>): Promise<A> {
  const key = NodePath.resolve(cwd);
  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.then(run, run);
  const settled = task.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return task;
}

/** Resolves once every queued operation for the folder has finished. */
export function snapshotsIdle(cwd: string): Promise<void> {
  return (queues.get(NodePath.resolve(cwd)) ?? Promise.resolve()).then(() => undefined);
}

const fail = (cwd: string, command: string, error: unknown) =>
  error instanceof SnapshotTooLarge
    ? new VcsUnsupportedOperationError({
        operation: OPERATION,
        kind: "git",
        detail: `This folder is too large to snapshot: ${error.message}.`,
      })
    : new VcsProcessExitError({
        operation: OPERATION,
        command,
        cwd,
        exitCode: 1,
        detail: error instanceof Error ? error.message : String(error),
      });

const attempt = <A>(cwd: string, command: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: () => enqueue(cwd, run), catch: (error) => fail(cwd, command, error) });

/** Checkpoint operations for a folder outside git, with the same contract as the git driver's. */
export const snapshotCheckpointOps: VcsDriver.VcsCheckpointOps = {
  // Waits up to CAPTURE_WAIT_MS (incremental captures finish well within it), then lets a slow
  // capture finish in the background; a failed capture shows up later as a missing checkpoint.
  captureCheckpoint: (input) =>
    Effect.promise(() => {
      const task = enqueue(input.cwd, () => captureSnapshot(input.cwd, input.checkpointRef)).catch(
        () => undefined,
      );
      return Promise.race([
        task,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CAPTURE_WAIT_MS);
          void task.then(() => clearTimeout(timer));
        }),
      ]);
    }).pipe(Effect.asVoid),
  hasCheckpointRef: (input) =>
    attempt(
      input.cwd,
      "git rev-parse",
      async () => (await resolveCommit(input.cwd, input.checkpointRef)) !== null,
    ),
  restoreCheckpoint: () =>
    Effect.fail(
      new VcsUnsupportedOperationError({
        operation: OPERATION,
        kind: "git",
        detail:
          "Rolling back is not available for project folders outside git; the changes view still works.",
      }),
    ),
  diffCheckpoints: (input) =>
    attempt(input.cwd, "git diff", async () => {
      if (input.filePaths?.length === 0) return "";
      const from =
        (await resolveCommit(input.cwd, input.fromCheckpointRef)) ??
        (input.fallbackFromToHead === true ? EMPTY_TREE : null);
      const to = await resolveCommit(input.cwd, input.toCheckpointRef);
      if (from === null || to === null) throw new Error("Checkpoint ref is unavailable for diff.");
      const result = await git(
        input.cwd,
        [
          "-c",
          "diff.relative=false",
          "diff",
          ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          from,
          to,
          ...(input.filePaths
            ? ["--", ...input.filePaths.map((file) => `:(top,literal)${file}`)]
            : []),
        ],
        { maxBuffer: input.maxOutputBytes ?? 10_000_000, bare: true },
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || "git diff failed");
      return result.stdout;
    }),
  // Snapshots have no HEAD of their own, so every changed path belongs to the turn.
  listAuthoredPaths: () => Effect.succeed(null),
  deleteCheckpointRefs: (input) =>
    attempt(input.cwd, "git update-ref", async () => {
      if (!NodeFS.existsSync(NodePath.join(snapshotGitDir(input.cwd), "HEAD"))) return;
      if (input.checkpointRefs.length === 0) return;
      await gitOk(input.cwd, ["update-ref", "--stdin"], {
        bare: true,
        stdin: (input.checkpointRefs as ReadonlyArray<CheckpointRef>)
          .map((ref) => `delete ${ref}\n`)
          .join(""),
      });
      await gc(input.cwd);
    }),
};

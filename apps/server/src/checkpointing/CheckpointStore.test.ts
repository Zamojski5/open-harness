// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { CheckpointRef, ThreadId, type VcsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import * as Base64Url from "effect/encoding/Base64Url";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isSnapshotEligible, snapshotGitDir, snapshotsIdle } from "./SnapshotCheckpoints.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(`refs/t3/checkpoints/${Base64Url.encode(threadId)}/turn/${turnCount}`);
}

const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const layerVcsProcessTest = VcsProcess.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerVcsDriverTest = VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcessTest));
const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provideMerge(layerVcsDriverTest),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerTest = layerCheckpointStoreTest.pipe(
  Layer.provideMerge(layerVcsProcessTest),
  Layer.provideMerge(layerVcsDriverTest),
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly committedAt?: string; readonly allowNonZeroExit?: boolean } = {},
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
      ...(options.committedAt === undefined
        ? {}
        : { env: { ...process.env, GIT_COMMITTER_DATE: options.committedAt } }),
      ...(options.allowNonZeroExit === undefined
        ? {}
        : { allowNonZeroExit: options.allowNonZeroExit }),
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(layerTest)("CheckpointStore.layer", (it) => {
  it.effect("detects a nested workspace without its own .git entry", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      const fileSystem = yield* FileSystem.FileSystem;
      const nested = NodePath.join(tmp, "packages", "nested");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const checkpointStore = yield* CheckpointStore.CheckpointStore;
      expect(yield* checkpointStore.isGitRepository(nested)).toBe(true);
    }),
  );
  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("keeps the patch format clients parse when the repository changes it", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        yield* git(tmp, ["config", "diff.suppressBlankEmpty", "true"]);
        yield* git(tmp, ["config", "diff.submodule", "log"]);
        const sub = NodePath.join(tmp, "sub");
        yield* git(tmp, ["init", "sub"]);
        yield* initRepoWithCommit(sub);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-noprefix");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# test\n\nbefore\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# test\n\nafter\n");
        yield* git(sub, ["commit", "--allow-empty", "-m", "moved"]);
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });

        expect(diff).toContain("diff --git a/README.md b/README.md");
        expect(diff).toContain(" # test\n \n-before\n+after\n");
        expect(diff).toContain("diff --git a/sub b/sub");
        expect(diff).toContain("+Subproject commit ");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = NodePath.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");

        for (const ignoreWhitespace of [false, true]) {
          const numstat = yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
            ignoreWhitespace,
            format: "numstat",
          });
          expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
            {
              path: "Component.tsx",
              additions: ignoreWhitespace ? 4 : 6,
              deletions: ignoreWhitespace ? 0 : 2,
            },
          ]);
        }
      }),
    );
  });

  describe("checkpoint file summaries", () => {
    it.effect("counts changes whose full patch exceeds the output limit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("large-checkpoint-summary");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const filePath = NodePath.join(tmp, "README.md");
        const lineCount = 20_000;
        yield* writeTextFile(filePath, `${"before".repeat(50)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(filePath, `${"after".repeat(60)}\n`.repeat(lineCount));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat",
        });

        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: lineCount, deletions: lineCount },
        ]);
        expect(numstat.length).toBeLessThan(100);
      }),
    );

    it.effect("preserves file paths and turn ranges without changing the user index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.renames", "copies"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-paths");
        const baseline = checkpointRefForThreadTurn(threadId, 0);
        const firstTurn = checkpointRefForThreadTurn(threadId, 1);
        const secondTurn = checkpointRefForThreadTurn(threadId, 2);
        const copiedText = Array.from({ length: 20 }, (_, index) => `copy line ${index}\n`).join(
          "",
        );
        const platform = yield* HostProcess.Platform;
        const renamedPath = platform === "win32" ? "renamed café.txt" : "renamed\tcafé\nname.txt";
        const addedPath = platform === "win32" ? "new café.txt" : "new\tfile\n名.txt";
        for (const [path, contents] of Object.entries({
          "copy-source.txt": copiedText,
          "deleted.txt": "delete me\n",
          "rename-old.txt": "before\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0before",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: baseline });

        yield* fileSystem.rename(
          NodePath.join(tmp, "rename-old.txt"),
          NodePath.join(tmp, renamedPath),
        );
        yield* fileSystem.remove(NodePath.join(tmp, "deleted.txt"));
        for (const [path, contents] of Object.entries({
          "copy-source.txt": `${copiedText}one more\n`,
          "copied.txt": copiedText,
          [renamedPath]: "after\nkeep one\nkeep two\nkeep three\n",
          "binary.bin": "\0after",
          "empty.txt": "",
          [addedPath]: "first\nsecond\n",
        })) {
          yield* writeTextFile(NodePath.join(tmp, path), contents);
        }
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: firstTurn });
        const userIndex = yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"));
        const input = {
          cwd: tmp,
          fromCheckpointRef: baseline,
          toCheckpointRef: firstTurn,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };
        const firstSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints(input),
        );
        const expectedFiles = [
          { path: "binary.bin", additions: 0, deletions: 0 },
          { path: "copied.txt", previousPath: "copy-source.txt", additions: 0, deletions: 0 },
          { path: "copy-source.txt", additions: 1, deletions: 0 },
          { path: "deleted.txt", additions: 0, deletions: 1 },
          { path: "empty.txt", additions: 0, deletions: 0 },
          { path: addedPath, additions: 2, deletions: 0 },
          { path: renamedPath, previousPath: "rename-old.txt", additions: 1, deletions: 1 },
        ].toSorted((left, right) => left.path.localeCompare(right.path));
        expect(firstSummary).toEqual(expectedFiles);

        yield* fileSystem.remove(NodePath.join(tmp, "empty.txt"));
        yield* writeTextFile(NodePath.join(tmp, "copy-source.txt"), "replacement\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: secondTurn });
        const secondSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({
            ...input,
            fromCheckpointRef: firstTurn,
            toCheckpointRef: secondTurn,
          }),
        );
        expect(secondSummary).toEqual([
          { path: "copy-source.txt", additions: 1, deletions: 21 },
          { path: "empty.txt", additions: 0, deletions: 0 },
        ]);

        const inclusiveSummary = parseTurnDiffFilesFromNumstat(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: secondTurn }),
        );
        expect(inclusiveSummary).toEqual(
          expectedFiles
            .filter((file) => file.path !== "empty.txt")
            .map((file) =>
              file.path === "copy-source.txt" ? { ...file, additions: 1, deletions: 20 } : file,
            ),
        );
        expect(
          yield* checkpointStore.diffCheckpoints({ ...input, toCheckpointRef: baseline }),
        ).toBe("");
        expect(yield* fileSystem.readFile(NodePath.join(tmp, ".git/index"))).toEqual(userIndex);
      }),
    );

    it.effect("uses HEAD for a missing baseline only when requested", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-summary-fallback");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "changed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        const input = {
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
          format: "numstat" as const,
        };

        const error = yield* Effect.flip(checkpointStore.diffCheckpoints(input));
        expect(error._tag).toBe("VcsProcessExitError");
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...input,
          fallbackFromToHead: true,
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "README.md", additions: 1, deletions: 1 },
        ]);
      }),
    );
    it.effect("reads repository paths from a subdirectory workspace under diff.relative", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.relative", "true"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = NodePath.join(tmp, "app");
        yield* fileSystem.makeDirectory(cwd);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-file-paths-subdirectory");
        const refs = {
          cwd,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.fromCheckpointRef });
        yield* writeTextFile(NodePath.join(cwd, "kept.txt"), "kept\n");
        yield* git(cwd, ["add", "kept.txt"]);
        yield* git(cwd, ["commit", "-m", "kept"]);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# hidden\n");
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.toCheckpointRef });

        const patch = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          filePaths: ["app/kept.txt"],
        });
        expect(patch).toContain("+++ b/app/kept.txt");
        expect(patch).toContain("+kept");
        expect(patch).not.toContain("hidden");
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(new Set(["app/kept.txt"]));
      }),
    );
  });

  describe("listAuthoredPaths", () => {
    it.effect("leaves out paths that only a merged upstream changed", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-authored-paths");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        const commitBeforeTurn = (file: string, contents: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(NodePath.join(tmp, file), contents);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", file], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* git(tmp, ["checkout", "-b", "upstream"]);
        yield* commitBeforeTurn("upstream.txt", "upstream\n");
        yield* commitBeforeTurn("shared.txt", "upstream\n");
        yield* git(tmp, ["checkout", "-"]);
        yield* commitBeforeTurn("shared.txt", "ours\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toBeNull();

        yield* git(tmp, ["merge", "upstream", "--no-edit"], { allowNonZeroExit: true });
        yield* writeTextFile(NodePath.join(tmp, "shared.txt"), "upstream\n");
        yield* git(tmp, ["commit", "-am", "merge upstream"]);
        yield* writeTextFile(NodePath.join(tmp, "README.md"), "# edited\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat).map((file) => file.path)).toEqual([
          "README.md",
          "shared.txt",
          "upstream.txt",
        ]);
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(
          new Set(["README.md", "shared.txt"]),
        );
      }),
    );

    it.effect("keeps paths from signed commits under log.showSignature", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const signingKey = NodePath.join(yield* makeTmpDir("checkpoint-signing-key-"), "key");
        yield* (yield* VcsProcess.VcsProcess).run({
          operation: "CheckpointStore.test.sshKeygen",
          command: "ssh-keygen",
          cwd: tmp,
          args: ["-q", "-t", "ed25519", "-N", "", "-f", signingKey],
          timeoutMs: 10_000,
        });
        yield* git(tmp, ["config", "gpg.format", "ssh"]);
        yield* git(tmp, ["config", "user.signingkey", `${signingKey}.pub`]);
        yield* git(tmp, ["config", "log.showSignature", "true"]);
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-authored-paths-signed");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "kept.txt"), "kept\n");
        yield* git(tmp, ["add", "kept.txt"]);
        yield* git(tmp, ["commit", "-S", "-m", "kept"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(new Set(["kept.txt"]));
      }),
    );
  });

  describe("folders outside git (snapshot checkpoints)", () => {
    it.effect("captures snapshots and diffs edits, additions, deletions and large files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-snapshot-test-");
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-snapshot");
        yield* writeTextFile(NodePath.join(tmp, "notes.md"), "first\n");
        yield* writeTextFile(NodePath.join(tmp, "gone.txt"), "bye\n");
        expect(yield* checkpointStore.isGitRepository(tmp)).toBe(true);
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });
        yield* writeTextFile(NodePath.join(tmp, "notes.md"), "first\nsecond\n");
        yield* fileSystem.remove(NodePath.join(tmp, "gone.txt"));
        yield* fileSystem.makeDirectory(NodePath.join(tmp, "takes"));
        yield* fileSystem.writeFile(
          NodePath.join(tmp, "takes", "render.mp4"),
          new Uint8Array(3 * 1024 * 1024).fill(7),
        );
        // A cloned repository inside the folder is skipped, not a capture failure.
        const clone = NodePath.join(tmp, "references", "clone");
        yield* fileSystem.makeDirectory(clone, { recursive: true });
        yield* git(clone, ["init"]);
        yield* writeTextFile(NodePath.join(clone, "README.md"), "clone\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        expect(
          yield* checkpointStore.hasCheckpointRef({
            cwd: tmp,
            checkpointRef: refs.toCheckpointRef,
          }),
        ).toBe(true);
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...refs,
          ignoreWhitespace: false,
          format: "numstat",
        });
        const files = parseTurnDiffFilesFromNumstat(numstat)
          .map((file) => file.path)
          .toSorted();
        expect(files).toEqual(["gone.txt", "notes.md", "takes/render.mp4"]);
        const patch = yield* checkpointStore.diffCheckpoints({ ...refs, ignoreWhitespace: false });
        expect(patch).toContain("+second");
        expect(patch).toContain("Open Herness snapshot stub (content not stored)");
        expect(patch).toContain("+size: 3145728 bytes");
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toBeNull();
        // The snapshot repository lives outside the project folder.
        expect(NodeFS.existsSync(NodePath.join(tmp, ".open-herness"))).toBe(false);
        const restore = yield* Effect.exit(
          checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef: refs.fromCheckpointRef }),
        );
        expect(restore._tag).toBe("Failure");
      }),
    );

    it("never snapshots the home folder, its standard folders or Library", () => {
      const home = NodeOS.homedir();
      for (const folder of ["", "Desktop", "Documents", "Downloads", "Library/Mobile Documents/x"])
        expect(isSnapshotEligible(NodePath.join(home, folder))).toBe(false);
      expect(isSnapshotEligible("/")).toBe(false);
    });

    it.effect("stays small with hundreds of regenerated render frames", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir("checkpoint-snapshot-bench-");
        const checkpointStore = yield* CheckpointStore.CheckpointStore;
        const threadId = ThreadId.make("checkpoint-snapshot-bench");
        const frames = NodePath.join(tmp, "takes", "frames");
        NodeFS.mkdirSync(frames, { recursive: true });
        // Incompressible content, like real renders (a small LCG; no randomness service needed).
        const frame = (seed: number) => {
          const data = Buffer.alloc(1024 * 1024);
          let x = seed * 2654435761;
          for (let i = 0; i < data.length; i += 4) {
            x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
            data.writeUInt32LE(x, i);
          }
          return data;
        };
        const writeFrames = (seed: number) => {
          for (let i = 0; i < 150; i++)
            NodeFS.writeFileSync(
              NodePath.join(frames, `f${String(i).padStart(4, "0")}.png`),
              frame(seed * 1000 + i),
            );
          NodeFS.writeFileSync(NodePath.join(tmp, "takes", "edit.mov"), frame(seed));
          NodeFS.writeFileSync(NodePath.join(tmp, "notes.md"), `round ${seed}\n`);
        };
        const capture = (turn: number) =>
          checkpointStore
            .captureCheckpoint({
              cwd: tmp,
              checkpointRef: checkpointRefForThreadTurn(threadId, turn),
            })
            .pipe(Effect.andThen(Effect.promise(() => snapshotsIdle(tmp))));
        for (let round = 1; round <= 4; round++) {
          writeFrames(round);
          yield* capture(round - 1);
        }
        yield* capture(4);
        const repoBytes =
          Number(
            NodeChildProcess.execFileSync("du", ["-sk", snapshotGitDir(tmp)], {
              encoding: "utf8",
            }).split("\t")[0],
          ) * 1024;
        // 4 rounds x 151 one-MB media files would be ~600 MB stored as content; stubs keep it tiny.
        expect(repoBytes).toBeLessThan(5 * 1024 * 1024);
        const changed = (from: number, to: number) =>
          checkpointStore
            .diffCheckpoints({
              cwd: tmp,
              fromCheckpointRef: checkpointRefForThreadTurn(threadId, from),
              toCheckpointRef: checkpointRefForThreadTurn(threadId, to),
              ignoreWhitespace: false,
              format: "numstat",
            })
            .pipe(Effect.map((numstat) => parseTurnDiffFilesFromNumstat(numstat).length));
        expect(yield* changed(2, 3)).toBe(152);
        // Nothing changed between the last two captures: the snapshot is identical.
        expect(yield* changed(3, 4)).toBe(0);
      }),
    );
  });
});

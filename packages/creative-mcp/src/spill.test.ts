import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import {
  boundToolResult,
  pruneSpills,
  redactSecrets,
  RESULT_CAP_BYTES,
  retainText,
  spillRoot,
} from "./spill.ts";

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-spill-home-"));
process.env.OPEN_HERNESS_HOME = home;
NodeTest.after(() => NodeFS.rmSync(home, { recursive: true, force: true }));

NodeTest.test("retainText keeps head and tail within the budget", () => {
  const text = `START${"x".repeat(50_000)}END`;
  const { head, tail, omittedBytes } = retainText(text, 1000);
  NodeAssert.ok(head.startsWith("START"));
  NodeAssert.ok(tail.endsWith("END"));
  NodeAssert.equal(Buffer.byteLength(head) + Buffer.byteLength(tail) + omittedBytes, text.length);
  NodeAssert.ok(Buffer.byteLength(head + tail) <= 1000);
});

NodeTest.test("retainText never splits a surrogate pair", () => {
  const { head, tail } = retainText("😀".repeat(5000), 101);
  NodeAssert.ok(!/[\ud800-\udbff]$/.test(head));
  NodeAssert.ok(!/^[\udc00-\udfff]/.test(tail));
});

NodeTest.test("small results pass through unchanged", () => {
  const result = { content: [{ type: "text", text: "ok" }] };
  NodeAssert.equal(boundToolResult(result, { tool: "t" }), result);
});

NodeTest.test(
  "oversized results spill outside the project, redacted, with head, tail and path",
  () => {
    const big = `Traceback first line\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\n${"line of output\n".repeat(5000)}last line`;
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const bounded = boundToolResult(
      { content: [{ type: "text", text: big }, image], isError: true },
      { tool: "blender_exec", cwd: "/some/project", threadId: "thread/../x" },
    );
    NodeAssert.equal(bounded.isError, true);
    const textOut = String(bounded.content![0]!.text);
    NodeAssert.ok(Buffer.byteLength(textOut) <= RESULT_CAP_BYTES);
    NodeAssert.ok(textOut.startsWith("Traceback first line") && textOut.includes("last line"));
    const path = /saved at: (\S+)/.exec(textOut)![1]!;
    NodeAssert.ok(path.startsWith(spillRoot()));
    NodeAssert.ok(!path.startsWith("/some/project"));
    NodeAssert.equal(path.split("/").includes(".."), false);
    const saved = NodeFS.readFileSync(path, "utf8");
    NodeAssert.ok(saved.includes("last line"));
    NodeAssert.ok(!saved.includes("sk-proj-abcdefghij"));
    NodeAssert.equal(NodeFS.statSync(path).mode & 0o777, 0o600);
    NodeAssert.deepEqual(bounded.content![1], image);
  },
);

NodeTest.test("redacts keys, tokens, private keys and key=value secrets", () => {
  const text = [
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
    "Authorization: Bearer abcdefghijklmnop.qrstuvwxyz",
    '"fal_key": "1234abcd-5678-efgh:9012ijkl"',
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    "a normal line with tokens=5",
  ].join("\n");
  const out = redactSecrets(text);
  for (const secret of ["ghp_abcdef", "abcdefghijklmnop.qrs", "1234abcd-5678", "AKIAABCD", "MIIE"])
    NodeAssert.ok(!out.includes(secret), secret);
  NodeAssert.ok(out.includes("a normal line with tokens=5"));
});

NodeTest.test("pruning drops old files and keeps the total under the cap", () => {
  const root = NodePath.join(home, "prune-root");
  const dir = NodePath.join(root, "t1");
  NodeFS.mkdirSync(dir, { recursive: true });
  const now = 1_800_000_000_000;
  const old = NodePath.join(dir, "old.txt");
  NodeFS.writeFileSync(old, "x");
  NodeFS.utimesSync(old, new Date(now - 8 * 86_400_000), new Date(now - 8 * 86_400_000));
  const big = Buffer.alloc(110 * 1024 * 1024);
  for (const [i, name] of ["a.txt", "b.txt"].entries()) {
    const path = NodePath.join(dir, name);
    NodeFS.writeFileSync(path, big);
    NodeFS.utimesSync(path, new Date(now - (2 - i) * 1000), new Date(now - (2 - i) * 1000));
  }
  pruneSpills(now, root);
  NodeAssert.deepEqual(NodeFS.readdirSync(dir).toSorted(), ["b.txt"]);
});

NodeTest.test("keeps the original when the spill file cannot be written", () => {
  const previous = process.env.OPEN_HERNESS_HOME;
  process.env.OPEN_HERNESS_HOME = "/dev/null/not-a-dir";
  try {
    const big = { content: [{ type: "text", text: "y".repeat(RESULT_CAP_BYTES * 2) }] };
    NodeAssert.equal(boundToolResult(big, { tool: "t" }), big);
  } finally {
    process.env.OPEN_HERNESS_HOME = previous;
  }
});

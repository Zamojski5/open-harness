import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installResultBounds } from "./bounds.ts";

NodeTest.test(
  "tools registered after installResultBounds return bounded results over MCP",
  async () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-bounds-"));
    process.env.OPEN_HERNESS_HOME = cwd;
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const server = new McpServer({ name: "t", version: "0" });
      installResultBounds(server);
      server.registerTool("big", { description: "big", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: `HEAD${"z".repeat(100_000)}TAIL` }],
      }));
      server.registerTool("small", { description: "small", inputSchema: {} }, async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(b);
      const big = (await client.callTool({ name: "big", arguments: {} })) as {
        content: Array<{ type: string; text: string }>;
      };
      const text = big.content[0]!.text;
      NodeAssert.ok(Buffer.byteLength(text) <= 20_000);
      NodeAssert.ok(text.startsWith("HEAD") && text.includes("TAIL"));
      NodeAssert.match(text, /spill\//);
      const small = (await client.callTool({ name: "small", arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      NodeAssert.equal(small.content[0]!.text, "ok");
      await client.close();
    } finally {
      process.chdir(previous);
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

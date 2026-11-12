// Every creative tool result passes through here before it reaches the model: images are fitted
// to a size the model accepts (imageFit.ts) and oversized text is spilled to a file with head and
// tail kept inline (spill.ts).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordToolMoment } from "./case/sources.ts";
import { fitResultImages } from "./imageFit.ts";
import { boundToolResult, type ToolResultLike } from "./spill.ts";

export async function boundResult<T extends ToolResultLike>(tool: string, result: T): Promise<T> {
  const fitted = (await fitResultImages(result as T & { content?: never[] })) as T;
  return boundToolResult(fitted, {
    tool,
    cwd: process.cwd(),
    threadId: process.env.T3CODE_THREAD_ID,
  });
}

/**
 * Wraps registerTool so every handler registered afterwards returns a bounded result (and logs
 * case-study key moments of the calls that make one).
 */
export function installResultBounds(server: McpServer): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (
    ...args: unknown[]
  ) => {
    const [name, config, handler] = args;
    if (typeof handler !== "function") return register(...args);
    const wrapped = async (...callArgs: unknown[]) => {
      const result = (await handler(...callArgs)) as ToolResultLike;
      recordToolMoment(process.cwd(), String(name), callArgs[0], result);
      return boundResult(String(name), result);
    };
    return register(name, config, wrapped);
  };
}

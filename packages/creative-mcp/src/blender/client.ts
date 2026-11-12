// Connection to the live Blender bridge (bridge.py) plus process management.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "bridge.py");
const STATE_FILE = join(homedir(), ".open-herness", "blender-bridge.json");

interface BridgeState {
  port: number;
  token: string;
  pid: number;
}

export function blenderBinary(): string | undefined {
  const candidates = [
    process.env.OH_BLENDER_PATH,
    "/Applications/Blender.app/Contents/MacOS/Blender",
    `${homedir()}/Applications/Blender.app/Contents/MacOS/Blender`,
  ].filter((p): p is string => !!p);
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execFileSync("/usr/bin/which", ["blender"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readState(): BridgeState | undefined {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as BridgeState;
  } catch {
    return undefined;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface BridgeReply<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  traceback?: string;
}

export async function request<T = unknown>(cmd: Record<string, unknown>, timeoutMs = 120_000): Promise<BridgeReply<T>> {
  const state = readState();
  if (!state || !alive(state.pid)) throw new Error("Blender is not running with the Open Herness bridge. Call blender_launch first.");
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Blender did not answer within ${Math.round(timeoutMs / 1000)}s (it may be busy rendering or showing a dialog).`));
    }, timeoutMs);
    socket.connect(state.port, "127.0.0.1", () => {
      socket.write(`${JSON.stringify({ id: 1, token: state.token, ...cmd })}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as BridgeReply<T>);
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function isRunning() {
  try {
    const reply = await request<{ version: string; file: string | null }>({ cmd: "ping" }, 3000);
    return reply.ok ? reply.data : undefined;
  } catch {
    return undefined;
  }
}

/** Start Blender's UI with the bridge (or reuse the running one). */
export async function launch(file?: string) {
  const running = await isRunning();
  if (running) {
    if (file) await request({ cmd: "open", path: file });
    return { reused: true, ...(await isRunning()) };
  }
  const bin = blenderBinary();
  if (!bin) throw new Error("Blender is not installed. Install it from blender.org (free) or set OH_BLENDER_PATH.");
  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  const args = [...(file ? [file] : []), "--python", BRIDGE_SCRIPT];
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OH_BLENDER_PORT: String(port), OH_BLENDER_TOKEN: token },
  });
  child.unref();
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ port, token, pid: child.pid ?? -1 } satisfies BridgeState), { mode: 0o600 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const info = await isRunning();
    if (info) return { reused: false, ...info };
  }
  throw new Error("Blender started but the bridge did not respond within 60s.");
}

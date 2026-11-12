// EffectCraft (open-source After Effects-class compositor). Its own MCP server ("effectcraft",
// bridged to the live window) does the editing; this only finds the app and opens it with the
// control channel the bridge connects to.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const run = promisify(execFile);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export const EFFECTCRAFT_CONTROL_PORT = Number(process.env.OH_EFFECTCRAFT_PORT ?? 9877);

export function effectcraftApp(): string | undefined {
  return [
    process.env.OH_EFFECTCRAFT_APP,
    "/Applications/EffectCraft.app",
    join(homedir(), "Applications", "EffectCraft.app"),
  ].find((p): p is string => !!p && existsSync(p));
}

export function effectcraftCli(): string | undefined {
  return [
    process.env.OH_EFFECTCRAFT_CLI,
    join(homedir(), ".open-herness", "bin", "effectcraft-cli"),
    "/opt/homebrew/bin/effectcraft-cli",
    "/usr/local/bin/effectcraft-cli",
  ].find((p): p is string => !!p && existsSync(p));
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
  });
}

export function registerEffectCraftTools(server: McpServer) {
  server.registerTool(
    "effectcraft_launch",
    {
      description:
        "Open the EffectCraft desktop app (open-source motion graphics / compositing, After Effects-style: comps, layers, keyframes, expressions, 250+ effects, 3D cameras, render queue to MP4/ProRes/PNG/GIF/Lottie) with its control channel, so the effectcraft MCP tools (command_run, run_script, set_property, add_keyframe, add_effect, render_preview, screenshot…) drive the live window the user sees. Reuses a running session. Optionally open a .ecproj or import media files.",
      inputSchema: {
        files: z
          .array(z.string())
          .optional()
          .describe(".ecproj project or media files (absolute or relative to the project)"),
      },
    },
    async ({ files = [] }) => {
      if (await portOpen(EFFECTCRAFT_CONTROL_PORT)) {
        return text(
          `EffectCraft is already running with control on port ${EFFECTCRAFT_CONTROL_PORT}. Use the effectcraft tools (doc_inspect, get_state).${files.length ? " To open files there, use open_project or the import commands." : ""}`,
        );
      }
      const app = effectcraftApp();
      if (!app)
        return fail(
          "EffectCraft is not installed. Download it from https://github.com/storytold/effectcraft/releases (macOS universal .dmg) into /Applications.",
        );
      const paths = files.map((f) => resolve(process.cwd(), f));
      try {
        await run("open", [
          "-n",
          "-a",
          app,
          "--args",
          "--control",
          String(EFFECTCRAFT_CONTROL_PORT),
          ...paths,
        ]);
      } catch (error) {
        return fail(
          `Could not open EffectCraft: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      for (let i = 0; i < 60; i++) {
        if (await portOpen(EFFECTCRAFT_CONTROL_PORT)) {
          return text(
            `EffectCraft started (control port ${EFFECTCRAFT_CONTROL_PORT}). Use the effectcraft tools; look at results with render_preview / screenshot.${effectcraftCli() ? "" : " Note: effectcraft-cli was not found, so the effectcraft MCP tools are unavailable."}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return fail("EffectCraft opened but its control port did not come up within 30 s.");
    },
  );

  const CRAFT_APPS = {
    lightcraft: "LightCraft",
    photocraft: "PhotoCraft",
    vectorcraft: "VectorCraft",
    filmcraft: "FilmCraft",
    designcraft: "DesignCraft",
    effectcraft: "EffectCraft",
  } as const;
  server.registerTool(
    "craft_launch",
    {
      description:
        "Open a Craft desktop app (LightCraft photos/raw, PhotoCraft layered PSD, VectorCraft vector, FilmCraft video edit/grade/sound, DesignCraft layout, EffectCraft motion) with files, to show the user a result the headless <app> MCP tools saved in the project. Editing goes through the app's own MCP tools; this only opens the window.",
      inputSchema: {
        app: z.enum(
          Object.keys(CRAFT_APPS) as [keyof typeof CRAFT_APPS, ...(keyof typeof CRAFT_APPS)[]],
        ),
        files: z
          .array(z.string())
          .optional()
          .describe("files to open (absolute or relative to the project)"),
      },
    },
    async ({ app, files = [] }) => {
      const name = CRAFT_APPS[app];
      const path = [
        `/Applications/${name}.app`,
        join(homedir(), "Applications", `${name}.app`),
      ].find((p) => existsSync(p));
      if (!path)
        return fail(
          `${name} is not installed. Download it from https://github.com/storytold/${app}/releases (macOS universal .dmg) into /Applications.`,
        );
      const paths = files.map((f) => resolve(process.cwd(), f));
      const absent = paths.find((p) => !existsSync(p));
      if (absent) return fail(`File not found: ${absent}`);
      try {
        await run("open", ["-a", path, ...paths]);
      } catch (error) {
        return fail(
          `Could not open ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return text(
        `${name} opened${paths.length ? ` with ${paths.map((p) => p.replace(process.cwd() + "/", "")).join(", ")}` : ""}.`,
      );
    },
  );
}

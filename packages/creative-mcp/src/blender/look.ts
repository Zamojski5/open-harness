// Blender look kit v2 and probe-render auto exposure. Runs look.py in a background Blender on the given .blend
// or a snapshot of the live scene; the source is opened and never saved (results go to ./takes/ copies).

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { headless, slug, sourceFile } from "./tools.ts";

const LOOK_PY = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "look.py"), "utf8");
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const rel = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
};

export const LOOK_NAMES = [
  "rain-night",
  "fog-forest",
  "sunbeams",
  "neon-interior",
  "night-city",
  "golden-hour",
  "blue-hour",
  "misty-dawn",
  "overcast",
  "studio-product",
  "wet-product",
] as const;
export const LOOK_LAYERS = [
  "rig",
  "fog",
  "godrays",
  "practicals",
  "wet",
  "rain",
  "camera",
  "post",
] as const;

/** Runs look.py with JSON params; Python errors come back as a readable message, markers parsed from stdout. */
async function lookJob<T>(src: string, params: Record<string, unknown>, tag: string): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), "oh-look-"));
  try {
    const script = `import json\nP = json.loads(${JSON.stringify(JSON.stringify({ ...params, tmp }))})\n${LOOK_PY}`;
    let log: string;
    try {
      log = await headless(src, script, 1_800_000);
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const all = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      const oh = [...all.matchAll(/^\w*(?:Error|Exception): OH_ERR (.+)$/gm)].at(-1)?.[1];
      throw new Error(oh ?? `${e.message ?? error}\n${all.slice(-2500)}`);
    }
    const line = log.split("\n").find((l) => l.startsWith(`${tag} `));
    if (!line) throw new Error(`Blender did not report ${tag}.\n${log.slice(-2500)}`);
    return JSON.parse(line.slice(tag.length + 1)) as T;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function source(file?: string) {
  const src = await sourceFile(file);
  if (!src)
    throw new Error("No scene: pass file=<.blend> or start the live session with blender_launch.");
  return src;
}

/** ./takes/<name><suffix>.blend; never overwrites an unrelated take: "-v2", "-v3" ... for repeats of a different source. */
function outBlend(file: string | undefined, suffix: string, explicit?: string) {
  if (explicit) return join(process.cwd(), explicit);
  mkdirSync(join(process.cwd(), "takes"), { recursive: true });
  const name = slug(basename(file ?? "live", ".blend")).replace(/-(look|exposed)$/, "");
  return join(process.cwd(), "takes", `${name}${suffix}.blend`);
}

type Exposure = {
  ev: number;
  key: number;
  p50: number;
  p90: number;
  lit_median: number;
  key_after: number;
  p50_after: number;
  target: number;
  hero?: string;
  hero_geomean?: number;
  clamped: boolean;
};
const fmtExposure = (e: Exposure) =>
  `Exposure ${e.ev >= 0 ? "+" : ""}${e.ev} EV${e.clamped ? " (clamped to +-10)" : ""}: probe key ${e.key} (target ${e.target}), p50 ${e.p50}, p90 ${e.p90}, lit median ${e.lit_median}${e.hero_geomean ? `, hero geomean ${e.hero_geomean}` : ""}; after: key ${e.key_after}, p50 ${e.p50_after}.`;

export function registerBlenderLook(server: McpServer) {
  server.registerTool(
    "blender_auto_exposure",
    {
      description:
        "Auto exposure from a probe render. Renders a ~240 px linear frame (Cycles <= 32 samples / EEVEE <= 8, no compositing, no motion blur, exposure 0), takes the central 80% minus the brightest 2%, geometric mean = key, EV = log2(target / key). Hero constraint (EV never below what the subject's screen box needs), optional ceiling (dark looks stay dark) and floor (wins over the ceiling), clamped to +-10 EV. Reports key/p50/p90/lit median and the predicted p50 after. apply=true writes view-transform exposure into ./takes/<name>-exposed.blend (source untouched). target = scene-linear middle grey: 0.18 day, 0.20 golden hour, 0.10-0.12 neon/blue hour, 0.08 night; floor 0.10-0.15.",
      inputSchema: {
        target: z
          .number()
          .positive()
          .optional()
          .describe("Scene-linear middle grey to reach (default 0.18)"),
        hero_object: z
          .string()
          .optional()
          .describe("Subject object name (default: the largest central non-flat mesh)"),
        hero_target: z
          .number()
          .positive()
          .optional()
          .describe("Target geometric mean for the subject box (default = target)"),
        ceiling: z
          .number()
          .positive()
          .optional()
          .describe("Dark looks: p90 of the frame never above this (e.g. 0.45)"),
        floor: z
          .number()
          .min(0)
          .optional()
          .describe("Minimum median of the lit part (default 0.12)"),
        apply: z
          .boolean()
          .optional()
          .describe("Save the exposure into a ./takes/<name>-exposed.blend copy"),
        file: z.string().optional().describe(".blend (default: snapshot of the live scene)"),
        camera: z.string().optional(),
        frame: z.number().int().optional(),
        output: z
          .string()
          .optional()
          .describe("Output .blend path for apply (default ./takes/<name>-exposed.blend)"),
      },
    },
    async ({
      target,
      hero_object,
      hero_target,
      ceiling,
      floor,
      apply,
      file,
      camera,
      frame,
      output,
    }) => {
      try {
        const src = await source(file);
        const save = apply ? outBlend(file, "-exposed", output) : undefined;
        const e = await lookJob<Exposure>(
          src,
          {
            cmd: "exposure",
            target: target ?? 0.18,
            hero_object,
            hero_target,
            ceiling,
            floor: floor ?? 0.12,
            apply: true,
            camera,
            frame,
            save,
          },
          "OH_EXPOSURE",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${fmtExposure(e)}${e.hero ? ` Hero: ${e.hero}.` : ""}\n${save ? `Saved ${rel(save)} (source untouched).` : "Not applied: call again with apply=true to write it into a copy, or set Scene > Color Management > Exposure by hand."}`,
            },
          ],
        };
      } catch (error) {
        return fail(
          `blender_auto_exposure failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            5000,
          ),
        );
      }
    },
  );

  server.registerTool(
    "blender_look",
    {
      description: `Look kit v2: apply a named look or single layers to a copy of the scene, with auto exposure and a small preview render; or remove it again. Looks: ${LOOK_NAMES.join(", ")}. Layers: rig (lights + world, sun azimuth searched when god rays are on), fog (density = 3 / visibility * amount, visibility = max(4 x subject distance, 8 m), height-fog node group, shadow visibility off), godrays (sun volume scatter + hidden gobo blocker: leaves/window/blinds), practicals (emissive polygons -> real lights; budgets 256 lights / 48 shadow casters / 1.5 m cluster; motivated 2700 K key + 7500 K rim when fewer than 2), wet (darker + glossier, puddles on up-facing faces), rain (streak cards with wind), camera (DOF f-stop on the hero), post (AgX look, bloom, lens, grade, vignette, grain). Everything lives in collection 'OH Look v2' and nodes named 'OH ...'; the previous exposure/world/look/DOF are stored in the file, so remove=true restores them. Re-applying replaces the previous look. Source is never saved: the result goes to ./takes/<name>-look.blend (remove: <name>-nolook.blend). Cycles scenes: mind the 24 GB limits; the preview is 640 px.`,
      inputSchema: {
        name: z.enum(LOOK_NAMES).optional().describe("Named look (all of its layers)"),
        layers: z
          .array(z.enum(LOOK_LAYERS))
          .optional()
          .describe(
            "Only these layers (with name: that look's values for just these layers; without: neutral grey-day values, no exposure change)",
          ),
        intensity: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe(
            "Scales fog amount, bloom, wet, rain, vignette, grain, light power (default 1)",
          ),
        remove: z
          .boolean()
          .optional()
          .describe("Remove the look from the file and restore the earlier settings"),
        hero_object: z
          .string()
          .optional()
          .describe("Subject object (default: largest central non-flat mesh)"),
        auto_exposure: z
          .boolean()
          .optional()
          .describe(
            "Run auto exposure after building (default true with name, false with layers only)",
          ),
        target: z.number().positive().optional().describe("Override the look's middle-grey target"),
        hero_target: z.number().positive().optional(),
        preview: z
          .boolean()
          .optional()
          .describe("Render a 640 px preview and return it (default true; false for remove)"),
        file: z.string().optional().describe(".blend (default: snapshot of the live scene)"),
        camera: z.string().optional(),
        frame: z.number().int().optional(),
        output: z.string().optional().describe("Output .blend path"),
      },
    },
    async ({
      name,
      layers,
      intensity,
      remove,
      hero_object,
      auto_exposure,
      target,
      hero_target,
      preview,
      file,
      camera,
      frame,
      output,
    }) => {
      try {
        if (!remove && !name && !layers?.length)
          return fail("blender_look needs name=<look>, layers=[...] or remove=true.");
        const src = await source(file);
        const save = outBlend(file, remove ? "-nolook" : "-look", output);
        const previewPath =
          (preview ?? !remove)
            ? join(mkdtempSync(join(tmpdir(), "oh-lookprev-")), "preview.png")
            : undefined;
        const rep = await lookJob<Record<string, any>>(
          src,
          {
            cmd: "look",
            name,
            layers,
            intensity: intensity ?? 1,
            remove,
            hero_object,
            auto_exposure,
            target,
            hero_target,
            camera,
            frame,
            save,
            preview: previewPath,
          },
          "OH_LOOK",
        );
        const lines: string[] = [];
        if (remove) {
          lines.push(
            rep.removed
              ? `Removed look ${rep.was ?? ""}: restored exposure/world/look/DOF; ${rep.wet_materials_restored} wet material(s) and ${rep.post_nodes_removed} compositor node(s) reverted.`
              : "No look found in the scene: nothing to remove.",
          );
        } else {
          lines.push(
            `${name ?? "layers"} [${rep.layers.join(", ")}] x${rep.intensity}; hero ${rep.hero ?? "none"} at ${rep.subject_distance_m} m (size ${rep.subject_size_m} m).`,
          );
          if (rep.fog)
            lines.push(
              `Fog: visibility ${rep.fog.visibility_m} m, density ${rep.fog.density}${rep.fog_height_m ? `, height fog ${rep.fog_height_m} m` : ""}.`,
            );
          if (rep.sun_azimuth_deg !== undefined)
            lines.push(`Sun azimuth ${rep.sun_azimuth_deg} deg from the camera side.`);
          for (const k of ["godrays", "practicals", "rain"])
            if (rep[k])
              lines.push(`${k}: ${typeof rep[k] === "string" ? rep[k] : JSON.stringify(rep[k])}`);
          if (rep.practicals_note) lines.push(rep.practicals_note);
          if (rep.wet_materials !== undefined) lines.push(`Wet: ${rep.wet_materials} material(s).`);
          if (rep.post) lines.push(`Post: ${rep.post.join(", ")}.`);
          if (rep.post_skipped) lines.push(`Post skipped: ${JSON.stringify(rep.post_skipped)}.`);
          if (rep.exposure) lines.push(fmtExposure(rep.exposure));
        }
        lines.push(
          `Saved ${rel(save)} (source untouched). Undo: blender_look {file: "${rel(save)}", remove: true}.`,
        );
        const content: (
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        )[] = [{ type: "text", text: lines.join("\n") }];
        if (previewPath) {
          try {
            content.push({
              type: "image",
              data: readFileSync(previewPath).toString("base64"),
              mimeType: "image/png",
            });
          } catch {
            content.push({ type: "text", text: "(preview render produced no image)" });
          }
          rmSync(dirname(previewPath), { recursive: true, force: true });
        }
        return { content };
      } catch (error) {
        return fail(
          `blender_look failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            5000,
          ),
        );
      }
    },
  );
}

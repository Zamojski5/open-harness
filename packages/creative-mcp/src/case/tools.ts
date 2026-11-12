// MCP tool case_study_build: sales material from this project's own logs (see build.ts).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildCaseStudy } from "./build.ts";
import { fmtUsd, NOT_RECORDED } from "./metrics.ts";
import { numberCards } from "./present.ts";

export function registerCaseStudyTools(server: McpServer) {
  server.registerTool(
    "case_study_build",
    {
      description:
        "Build a case study of this project from Open Herness's own logs into ./delivery/case-study/: numbers.json (every metric with its source log + entry ids), CASE.md (brief, process, numbers, before/after, deliverables), a one-page case-study.pdf and a 45-60 s case-study.mp4 (1080x1350; video=both adds 1920x1080) made locally from the process timelapse, key moments, the first vs picked take and number cards. No generation, no network, no music unless a local file is given. Missing data is shown as 'not recorded'. For client work ask the user about confidentiality first (confidential, relativeOnly, clientNames, spec). Load the case-study skill before calling.",
      inputSchema: {
        title: z.string().max(120).optional().describe("headline; default the project folder name"),
        brief: z
          .string()
          .max(4000)
          .optional()
          .describe("the problem/brief; default the first user message of the project"),
        from: z.string().optional().describe("ISO date/time: only activity from then"),
        to: z.string().optional().describe("ISO date/time: only activity until then"),
        threadIds: z.array(z.string()).optional().describe("only these threads"),
        agencyEstimateHours: z
          .number()
          .positive()
          .optional()
          .describe(
            "the USER's own estimate of agency hours; shown labelled as their estimate. Never invent it.",
          ),
        confidential: z
          .boolean()
          .optional()
          .describe(
            "redact clientNames + the folder name (also inflected forms), keep take images out of delivery/ and blur them and the process timelapse in the video",
          ),
        relativeOnly: z
          .boolean()
          .optional()
          .describe(
            "show only relative numbers (%, ×, /10 scores): no $, durations or dates; plain counts (takes, messages, threads) stay. numbers.json (absolute values) then goes to .open-herness/case-study/, not delivery/",
          ),
        clientNames: z.array(z.string()).optional().describe("names to redact when confidential"),
        spec: z.boolean().optional().describe('adds "spec campaign, not affiliated"'),
        video: z.enum(["none", "4x5", "both"]).optional().describe("default 4x5"),
        music: z.string().optional().describe("absolute path of a local audio file (optional)"),
        stateDb: z
          .string()
          .optional()
          .describe("server statev2.sqlite (default: found automatically)"),
      },
    },
    async (input) => {
      try {
        const result = await buildCaseStudy({
          project: process.cwd(),
          ...input,
          // the thread running this build is not part of the work being reported
          ...(process.env.T3CODE_THREAD_ID
            ? { excludeThreadIds: [process.env.T3CODE_THREAD_ID] }
            : {}),
          ...(input.stateDb ? { paths: { stateDb: input.stateDb } } : {}),
        });
        const n = result.numbers;
        const cards = numberCards(n, {
          title: "",
          brief: "",
          briefSource: "",
          confidential: input.confidential,
          relativeOnly: input.relativeOnly,
          clientNames: input.clientNames,
        });
        const lines = [
          `Case study written to delivery/case-study/:`,
          ...result.files.map((f) => `- ${f}`),
          ...(input.relativeOnly
            ? [
                "Audit copy with absolute numbers (keep private, not in delivery/): .open-herness/case-study/numbers.json",
              ]
            : []),
          "",
          "Headline numbers:",
          ...cards.map((c) => `- ${c.label}: ${c.big}`),
          "",
          `Spend total: ${n.spend.total.value === NOT_RECORDED ? NOT_RECORDED : fmtUsd(n.spend.total.value.usd)}; key moments: ${n.moments.length}.`,
          ...(result.video ?? []).map(
            (v) => `Video ${v.file}: ${v.width}x${v.height}, ${v.seconds.toFixed(1)} s.`,
          ),
          ...(result.warnings.length
            ? ["", "Warnings:", ...result.warnings.map((w) => `- ${w}`)]
            : []),
          "",
          "Next: read CASE.md and look at the PDF and a few video frames (media_frames) before presenting; edit the brief in CASE.md or rebuild with brief=… if the first message is not a good problem statement.",
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `case_study_build failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

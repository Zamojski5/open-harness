// Spend tools: batches, finishing drafts, upscaling kept takes, whole-piece model options, and the
// chat's cap and ask-before limit.

import * as NodeFS from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  explain,
  finishRequest,
  money,
  quoteBatch,
  spendLines,
  submitBatch,
  type BatchItem,
} from "./batch.ts";
import { groupOf } from "./catalog.ts";
import * as jobs from "./jobs.ts";
import type { GenerateRequest } from "./providers.ts";
import * as spend from "./spend.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolHelpers {
  project: () => string;
  abs: (p: string) => string;
  probeSeconds: (path: string) => Promise<number | undefined>;
  imagePreviews: (paths?: string[]) => Content[];
  /** media_generate-shaped item → request (paths resolved, cast injected); error text on failure */
  buildRequest: (item: {
    model: string;
    kind?: string | undefined;
    prompt?: string | undefined;
    references?: string[] | undefined;
    end_image?: string | undefined;
    video?: string | undefined;
    parameters?: Record<string, unknown> | undefined;
    input?: Record<string, unknown> | undefined;
    route?: string | undefined;
    cast?: string[] | undefined;
  }) => Promise<{ request: GenerateRequest; kind: string; cast?: unknown[] } | { error: string }>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

/** Default options for a whole-piece video quote: a strong model, a cheap one, a mid one. */
const VIDEO_OPTIONS = [
  "bytedance/seedance-2.5/text-to-video",
  "minimax/h3-max/text-to-video",
  "fal-ai/kling-video/v3/pro/text-to-video",
];

async function waitAndDescribe(h: ToolHelpers, list: jobs.MediaJob[], seconds: number) {
  const done = await jobs.wait(
    list.map((j) => j.id),
    "all",
    seconds * 1000,
  );
  const running = done.some(
    (j) => !["completed", "failed", "cancelled", "uncertain"].includes(j.state),
  );
  return {
    content: [
      {
        type: "text" as const,
        text: `${done.map((j) => jobs.describe(j)).join("\n\n")}${running ? "\nStill running: call jobs_wait with these ids." : ""}`,
      },
      ...h.imagePreviews(done.flatMap((j) => j.outputs ?? [])),
    ],
  };
}

const itemSchema = z.object({
  model: z.string(),
  kind: z.enum(["image", "video", "speech", "music", "sfx"]).optional(),
  prompt: z.string().optional(),
  title: z.string().optional(),
  references: z.array(z.string()).optional(),
  end_image: z.string().optional(),
  video: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  route: z.string().optional(),
  cast: z.array(z.string()).optional(),
  count: z.number().int().min(1).max(8).optional().describe("takes of this request"),
  request_id: z.string().optional(),
});

export function registerSpendTools(server: McpServer, h: ToolHelpers) {
  server.registerTool(
    "media_generate_batch",
    {
      description:
        "Submit several generations as one priced batch (shots of a scene, the draft takes of a shot). The whole batch is quoted first; above the ask-before limit it returns APPROVAL_REQUIRED with a card for the user, and only the approved, unchanged batch runs (approval_id). Every take is reserved against the chat and daily caps at once: if they don't all fit, nothing is sent and you get how many would fit. Takes after the first of a request are separate fresh jobs. Same item fields as media_generate.",
      inputSchema: {
        items: z.array(itemSchema).min(1).max(24),
        approval_id: z.string().optional(),
        allow_unpriced: z
          .boolean()
          .optional()
          .describe("Only after the user accepted an unknown price"),
        wait_seconds: z.number().min(0).max(300).optional(),
      },
    },
    async ({ items, approval_id, allow_unpriced, wait_seconds }) => {
      const built: BatchItem[] = [];
      for (const [i, it] of items.entries()) {
        if (it.parameters?.draft && groupOf(it.model)?.id !== "seedance-2.5")
          return fail(
            `item ${i + 1}: parameters.draft works only with Seedance 2.5. Nothing was submitted.`,
          );
        const b = await h.buildRequest(it);
        if ("error" in b) return fail(`item ${i + 1}: ${b.error}. Nothing was submitted.`);
        built.push({
          request: b.request,
          kind: b.kind,
          count: it.count ?? 1,
          ...(it.title ? { title: it.title } : {}),
          ...(it.request_id ? { requestId: it.request_id } : {}),
          ...(b.cast ? { cast: b.cast } : {}),
        });
      }
      const result = await submitBatch(built, {
        projectPath: h.project(),
        ...(approval_id ? { approvalId: approval_id } : {}),
        ...(allow_unpriced ? { allowUnpriced: true } : {}),
      });
      if (result.status !== "submitted")
        return result.status === "approval_required"
          ? text(explain(result))
          : fail(explain(result));
      const head = `Batch submitted: ${result.jobs.length} take(s), ${money(result.quote.usd, result.quote.usdMax)}${result.note ? ` (${result.note})` : ""}.`;
      const out = await waitAndDescribe(
        h,
        result.jobs.map((j) => j.job),
        wait_seconds ?? 20,
      );
      out.content.unshift({ type: "text" as const, text: head });
      return out;
    },
  );

  server.registerTool(
    "media_finish_draft",
    {
      description:
        "Finish a kept Seedance 2.5 draft at 1080p: the same take (camera, motion, performance), by the provider that made the draft, before it expires. Quote first with media_estimate {finish_of}; approval rules as media_generate. If the provider refuses, nothing else is tried: tell the user and ask whether to upscale the draft (media_upscale) or regenerate the shot at 1080p (a new take).",
      inputSchema: {
        job_id: z.string(),
        approval_id: z.string().optional(),
        allow_unpriced: z
          .boolean()
          .optional()
          .describe(
            "Runware publishes no finish price: only after the user accepted an 'up to' price",
          ),
        wait_seconds: z.number().min(0).max(300).optional(),
      },
    },
    async ({ job_id, approval_id, allow_unpriced, wait_seconds }) => {
      const made = finishRequest(job_id);
      if ("error" in made) return fail(made.error);
      const result = await submitBatch(
        [{ request: made.request, kind: "video", title: `${made.job.title} 1080p` }],
        {
          projectPath: made.job.projectPath,
          title: "Finish draft at 1080p",
          askIfUnpriced: true,
          ...(approval_id ? { approvalId: approval_id } : {}),
          ...(allow_unpriced ? { allowUnpriced: true } : {}),
        },
      );
      if (result.status !== "submitted")
        return result.status === "approval_required"
          ? text(explain(result))
          : fail(explain(result));
      const [done] = await jobs.wait([result.jobs[0]!.job.id], "all", (wait_seconds ?? 60) * 1000);
      const job = done ?? result.jobs[0]!.job;
      const body = jobs.describe(job);
      if (job.state === "failed" && job.failure && !job.failure.accepted)
        return fail(
          `COMPLETION_REFUSED: ${body}\nNothing else was run. Ask the user: upscale the draft (media_upscale {job_id:"${job_id}"}, quote first) or regenerate the shot at 1080p (a new take; quote and approve again). Never upscale or regenerate without their answer.`,
        );
      if (job.state === "failed" || job.state === "uncertain") return fail(body);
      return {
        content: [{ type: "text" as const, text: body }, ...h.imagePreviews(job.outputs)],
      };
    },
  );

  server.registerTool(
    "media_upscale",
    {
      description:
        "Upscale a kept take (video: Topaz on fal by default, or SeedVR), only the take the user keeps, once, from the original file. Priced by the clip's length and output size; same approval and cap rules as media_generate. Reference images are not re-attached.",
      inputSchema: {
        job_id: z.string().optional().describe("A finished job whose first output to upscale"),
        path: z.string().optional().describe("Or a file in the project"),
        model: z.enum(["topaz", "seedvr"]).optional(),
        output: z
          .enum(["720p", "1080p", "4k"])
          .optional()
          .describe("Output size (price tier); default 1080p"),
        approval_id: z.string().optional(),
        wait_seconds: z.number().min(0).max(300).optional(),
      },
    },
    async ({ job_id, path, model, output, approval_id, wait_seconds }) => {
      const source = job_id ? jobs.get(job_id)?.outputs?.[0] : path ? h.abs(path) : undefined;
      if (!source || !NodeFS.existsSync(source))
        return fail(
          job_id
            ? `Job ${job_id} has no finished file to upscale.`
            : "Name a job_id or an existing path.",
        );
      if (!/\.(mp4|mov|webm|m4v)$/i.test(source))
        return fail(
          "media_upscale handles video takes; for stills use an image upscaler via media_generate (see ai-boost).",
        );
      const seconds = await h.probeSeconds(source);
      const endpoint =
        model === "seedvr" ? "fal-ai/seedvr/upscale/video" : "fal-ai/topaz/upscale/video";
      const request: GenerateRequest = {
        model: endpoint,
        route: "exact",
        video: source,
        parameters: { resolution: output ?? "1080p" },
        ...(seconds !== undefined ? { meterSeconds: seconds } : {}),
      };
      const result = await submitBatch([{ request, kind: "video", title: "upscale" }], {
        projectPath: h.project(),
        title: "Upscale",
        ...(approval_id ? { approvalId: approval_id } : {}),
      });
      if (result.status !== "submitted")
        return result.status === "approval_required"
          ? text(explain(result))
          : fail(explain(result));
      return waitAndDescribe(h, [result.jobs[0]!.job], wait_seconds ?? 60);
    },
  );

  server.registerTool(
    "media_quote_plan",
    {
      description:
        "Whole-piece cost of a video for 2–3 candidate models, to offer before the first paid video of a chat: per model the drafts, the finishes and the total for every shot, on the cheapest route that has a key. Returns a ready question card (one option per model, each naming its total; mark your recommendation with a few-word reason). Skip it when the user already named a model.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        shots: z
          .array(
            z.object({
              duration: z.number().min(1).max(60),
              resolution: z.string().optional(),
              audio: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(60),
        options: z
          .array(z.string())
          .min(1)
          .max(3)
          .optional()
          .describe("Model ids (default: Seedance 2.5, MiniMax H3 Max, Kling v3 Pro)"),
        takes_per_shot: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("Takes you expect to make per kept shot (default 3)"),
        draft_ladder: z
          .boolean()
          .optional()
          .describe(
            "Seedance 2.5: price the takes as 480p drafts plus one 1080p finish per shot (default true)",
          ),
      },
    },
    async ({ shots, options, takes_per_shot, draft_ladder }) => {
      const takes = takes_per_shot ?? 3;
      const rows: { model: string; usd: number | null; usdMax: number | null; detail: string }[] =
        [];
      for (const model of options ?? VIDEO_OPTIONS) {
        const ladder = (draft_ladder ?? true) && groupOf(model)?.id === "seedance-2.5";
        const items: BatchItem[] = shots.flatMap((s) => {
          const parameters = {
            duration: s.duration,
            ...(s.resolution ? { resolution: s.resolution } : {}),
            ...(s.audio !== undefined ? { audio: s.audio } : {}),
          };
          const base: GenerateRequest = { model, prompt: "(quote)", parameters };
          if (!ladder) return [{ request: base, kind: "video", count: takes }];
          return [
            {
              request: { ...base, parameters: { ...parameters, draft: true } },
              kind: "video",
              count: takes,
            },
            {
              request: { ...base, parameters: { ...parameters, resolution: "1080p" } },
              kind: "video",
              count: 1,
            },
          ];
        });
        const q = await quoteBatch(items);
        const route = q.items[0]?.chosen;
        rows.push({
          model,
          usd: q.usd,
          usdMax: q.usdMax,
          detail: `${ladder ? `${takes} draft(s) + 1 finish per shot` : `${takes} take(s) per shot`}, ${shots.length} shot(s), ${shots.reduce((s, x) => s + x.duration, 0)} s; via ${route?.provider ?? "?"}${route?.skip ? ` (${route.skip})` : ""}, ${route?.estimate.payer ?? "?"}`,
        });
      }
      const card = {
        questions: [
          {
            header: "Video model",
            question:
              "Which model should make this video? Totals are for the whole piece, including planned retakes.",
            multiSelect: false,
            options: rows.map((r) => ({
              label: `${r.model.replace(/^(fal-ai|bytedance|minimax|google|runware|replicate)[/:]/, "").replace(/\/(text|image|reference)-to-video$/, "")}: ${money(r.usd, r.usdMax)}`,
              description: r.detail,
            })),
          },
        ],
      };
      return text(
        [
          ...rows.map((r) => `- ${r.model}: ${money(r.usd, r.usdMax)} (${r.detail})`),
          "",
          "Present the idea first, then ask with this card (add your recommendation and a few-word reason to one label); after the pick use that model for every clip in this chat unless the user changes it:",
          JSON.stringify(card),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "spend_cap_set",
    {
      description:
        "Set this chat's spend cap. Lowering it (or a first cap) always applies: usd alone. Raising it needs the user's own words: usd plus quote = whole sentences they wrote, or the label of the card option they picked, stating that cap; a plain \"yes\" to a cap you proposed, unit prices, prices of things, two different sums and approval answers are refused. local_only=true sets $0 (free tools only). The budget is counted from when the user said it, so quoting the same words again never restarts it. The user's later words about money lower the cap by themselves.",
      inputSchema: {
        usd: z.number().min(0).optional(),
        quote: z.string().min(1).max(4000).optional(),
        local_only: z.boolean().optional(),
      },
    },
    async ({ usd, quote, local_only }) => {
      const r = spend.setChatCap({
        ...(usd !== undefined ? { usd } : {}),
        ...(quote ? { quote } : {}),
        ...(local_only ? { localOnly: true } : {}),
      });
      if (!r.ok) return fail(`Cap not set. ${r.reason}`);
      return text(
        `Chat cap set: $${r.usd}${r.usd === 0 ? " (free tools only: paid generations are refused)" : ""}. Spend is counted from now.\n${spendLines().join("\n")}`,
      );
    },
  );

  server.registerTool(
    "spend_status",
    {
      description: "This chat's cap and spend so far, today's spend, and the ask-before limit.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => text(spendLines().join("\n")),
  );

  server.registerTool(
    "spend_settings",
    {
      description:
        "Lower the ask-before limit (USD; 0 = ask before every paid generation). Only the user can raise it, in ~/.open-herness/media/spend.json or OH_ASK_ABOVE_USD.",
      inputSchema: { ask_above_usd: z.number().min(0).max(10_000) },
    },
    async ({ ask_above_usd }) => {
      const r = spend.lowerAskAbove(ask_above_usd);
      return r.ok ? text(`Ask-before limit: $${ask_above_usd}.`) : fail(r.reason);
    },
  );
}

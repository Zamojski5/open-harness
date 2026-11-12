// Media tools: AI generation jobs on the user's own keys + local ffmpeg/macOS helpers.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  judgeEnabled,
  judgeImage,
  judgeVideo,
  judgedText,
  logJudged,
  JUDGE_CALL_USD,
  JUDGE_ENDPOINT,
} from "../project/likeness.ts";
import {
  castToPrompt,
  coded,
  likenessBrief,
  readCardAt,
  resolveCast,
  type CastUse,
  type ErrorCode,
} from "../project/cast.ts";
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
import { listCooldowns } from "./failures.ts";
import * as jobs from "./jobs.ts";
import { findProvenance } from "./provenance.ts";
import { describeRoutes, ROUTE_NAMES } from "./route.ts";
import { registerSpendTools } from "./spendtools.ts";
import {
  defaultModel,
  DEFAULT_MODELS,
  EQUIVALENT_ROUTES,
  falModelSchema,
  falSearchModels,
  loadKeys,
  MediaError,
  prepare,
  providerOf,
  resolveKind,
  routeCandidates,
  saveKey,
  type GenerateRequest,
  type Keys,
} from "./providers.ts";

const run = promisify(execFile);

/** Length of a local media file in seconds (undefined when ffprobe can't tell). */
async function probeSeconds(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      { timeout: 20_000 },
    );
    const s = Number(stdout.trim());
    return Number.isFinite(s) && s > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const project = () => process.cwd();
const abs = (p: string) => (/^(https?:|data:)/.test(p) ? p : resolve(project(), p));

/** Small inline previews of image outputs so they show up in the chat. */
function imagePreviews(paths: string[] = []): Content[] {
  return paths
    .filter(
      (p) => [".png", ".jpg", ".jpeg", ".webp"].includes(extname(p).toLowerCase()) && existsSync(p),
    )
    .slice(0, 4)
    .map((p) => ({
      type: "image" as const,
      data: readFileSync(p).toString("base64"),
      mimeType:
        extname(p).toLowerCase() === ".png"
          ? "image/png"
          : extname(p).toLowerCase() === ".webp"
            ? "image/webp"
            : "image/jpeg",
    }));
}

const KEY_NAMES: Record<string, keyof Keys> = {
  fal: "falApiKey",
  openai: "openaiApiKey",
  google: "googleApiKey",
  elevenlabs: "elevenLabsApiKey",
  runware: "runwareApiKey",
  replicate: "replicateApiKey",
};

const parametersSchema = z
  .object({
    aspect_ratio: z.string().optional(),
    resolution: z
      .string()
      .optional()
      .describe(
        "e.g. 720p/1080p/4k for video, 1K/2K/4K for images (snapped to what the model offers)",
      ),
    duration: z
      .number()
      .optional()
      .describe("seconds; snapped to the model's allowed values (noted in adjustments)"),
    num_outputs: z.number().int().min(1).max(4).optional(),
    voice: z
      .string()
      .optional()
      .describe("speech: voice name or id (ElevenLabs names are looked up in the user's library)"),
    seed: z.number().int().optional(),
    negative_prompt: z.string().optional(),
    audio: z
      .boolean()
      .optional()
      .describe("video models with sound: generate audio (default: model default, usually on)"),
    loop: z.boolean().optional().describe("sfx: seamless loop"),
    draft: z
      .boolean()
      .optional()
      .describe(
        "Seedance 2.5 only: a cheap 480p draft of the take; finish the kept one at 1080p with media_finish_draft (same take, same camera)",
      ),
  })
  .optional();

/** media_generate-shaped input → GenerateRequest (paths resolved against the project). */
function toRequest(
  model: string,
  a: {
    prompt?: string | undefined;
    references?: string[] | undefined;
    end_image?: string | undefined;
    video?: string | undefined;
    parameters?: Record<string, unknown> | undefined;
    input?: Record<string, unknown> | undefined;
    route?: string | undefined;
  },
): GenerateRequest {
  const request: GenerateRequest = { model };
  if (a.prompt !== undefined) request.prompt = a.prompt;
  if (a.input) request.input = a.input;
  if (a.references?.length) request.references = a.references.map(abs);
  if (a.end_image) request.endImage = abs(a.end_image);
  if (a.video) request.video = /^(https?:|data:)/.test(a.video) ? a.video : abs(a.video);
  if (a.route && a.route !== "auto") request.route = a.route;
  if (a.parameters)
    request.parameters = Object.fromEntries(
      Object.entries(a.parameters).filter(([, v]) => v !== undefined),
    ) as NonNullable<GenerateRequest["parameters"]>;
  return request;
}

const codedFail = (code: ErrorCode, message: string, remedy?: string) =>
  fail(coded(code, message, remedy));
const castIds = z
  .array(z.string())
  .min(1)
  .max(6)
  .optional()
  .describe(
    "Cast card ids (cast_list): injects each card's fixed description and role-tagged hero refs, refuses BEFORE spending if a card is a draft (unconsented real person / licence) or has no refs or the model has no reference input, records the ids in provenance. Images get an unscored likeness brief (cast_check) after generation.",
  );

/** Cast injection: description appended to the prompt, identity refs added (start frame / user refs stay first for video). */
function injectCast(
  ids: string[] | undefined,
  a: { prompt?: string | undefined; references?: string[] | undefined },
  kind: string,
) {
  if (!ids?.length) return { use: undefined, prompt: a.prompt, references: a.references };
  const use = resolveCast(project(), ids);
  if ("error" in use) return { error: use.error };
  const own = a.references ?? [];
  const references = kind === "video" ? [...own, ...use.refs] : [...use.refs, ...own];
  return { use, prompt: castToPrompt(a.prompt, use), references };
}
const castAdjustments = (use: CastUse) => use.notes;

function noKey(kind: string) {
  const options = Object.entries(DEFAULT_MODELS[kind] ?? {})
    .map(([p, m]) => `${p}: ${m}`)
    .join(", ");
  return fail(
    `No API key for ${kind} generation (options: ${options}). Ask the user for a key (they can paste it in chat; store it with media_set_key), or make the asset locally: Blender render, HTML render, or speak_local for voice.`,
  );
}

/** After a finished cast still/video: VLM likeness judge per card (logged), else an unscored brief (sheet + rubric). */
async function castBriefs(job: jobs.MediaJob, use: CastUse | undefined): Promise<Content[]> {
  if (!use || (job.kind !== "image" && job.kind !== "video")) return [];
  const isStill = (p: string) =>
    [".png", ".jpg", ".jpeg", ".webp"].includes(extname(p).toLowerCase());
  const file =
    job.kind === "image"
      ? (job.outputs ?? []).find(isStill)
      : (job.outputs ?? []).find((p) => /\.(mp4|mov|webm)$/i.test(p));
  if (!file) return [];
  const out: Content[] = [];
  for (const card of use.cards) {
    const fresh = readCardAt(project(), card.id);
    if (!fresh) continue;
    if (judgeEnabled()) {
      try {
        const r =
          job.kind === "video"
            ? await judgeVideo(project(), fresh, file)
            : { judged: await judgeImage(project(), fresh, file), frames: [] };
        logJudged(project(), fresh, file, relative(project(), file), r.judged, job.id);
        out.push({
          type: "text",
          text: `${judgedText(fresh, file, r.judged)}${r.frames.length ? `\nFrames: ${r.frames.map((f) => `${f.t}s=${f.overall}`).join(", ")}` : ""}`,
        });
        continue;
      } catch (error) {
        out.push({
          type: "text",
          text: `VLM likeness judge unavailable for '${card.id}' (${String(error).slice(0, 160)}); manual scoring below.`,
        });
      }
    }
    if (job.kind !== "image") {
      out.push({
        type: "text",
        text: `Likeness of '${card.id}' not scored (no judge). Review frames with media_frames next to cast_sheet.`,
      });
      continue;
    }
    const brief = await likenessBrief(project(), fresh, file);
    out.push({
      type: "text",
      text: `${brief.text}\nRecord the result: cast_check {id:"${card.id}", image:"${file}", score, reason, job_id:"${job.id}"}.`,
    });
    if (brief.sheetPath)
      out.push({
        type: "image",
        data: readFileSync(brief.sheetPath).toString("base64"),
        mimeType: "image/jpeg",
      });
  }
  return out;
}

export function registerMediaTools(server: McpServer) {
  jobs.init();
  registerSpendTools(server, {
    project,
    abs,
    probeSeconds,
    imagePreviews,
    buildRequest: async (it) => {
      const kind = await resolveKind(it.model, it.kind);
      const injected = injectCast(it.cast, { prompt: it.prompt, references: it.references }, kind);
      if (injected.error) return { error: injected.error.message };
      const request = toRequest(it.model, {
        prompt: injected.prompt,
        references: injected.references,
        end_image: it.end_image,
        video: it.video,
        parameters: it.parameters,
        input: it.input,
        route: it.route,
      });
      const missing = [
        ...(request.references ?? []),
        ...(request.endImage ? [request.endImage] : []),
        ...(request.video ? [request.video] : []),
      ].find((r) => !/^(https?:|data:)/.test(r) && !existsSync(r));
      if (missing) return { error: `Reference file not found: ${missing}` };
      if (request.video && !/^(https?:|data:)/.test(request.video)) {
        const seconds = await probeSeconds(request.video);
        if (seconds !== undefined) request.inputSeconds = seconds;
      }
      return { request, kind, ...(injected.use ? { cast: injected.use.record } : {}) };
    },
  });

  server.registerTool(
    "media_generate",
    {
      description: `Generate media (image, video, speech, music, sound effects) as a background job on the user's own API keys. Waits up to wait_seconds (default 90) and returns the files (images are shown inline); otherwise returns a job id for jobs_wait. Outputs go to ./takes/<title>-take-NN.<ext> with provenance in ./takes/.meta/ (media_provenance). Identical requests (same content, references compared by bytes) reuse the earlier job unless fresh=true; pass request_id to make retries idempotent.
Models: any fal.ai endpoint id (search with media_models), openai:gpt-image-1, openai:gpt-4o-mini-tts, google:gemini-3.1-flash-image, google:gemini-3-pro-image, google:veo-3.1-generate-preview, google:veo-3.1-fast-generate-preview, elevenlabs:tts[/<voiceId>], elevenlabs:sfx, elevenlabs:music. Omit model to use the default for 'kind'.
Generic parameters are mapped onto the model's real fields (from its schema): durations/resolutions/aspect ratios snap to allowed values, references go to the right image field (with references, fal image models use /edit and video models /image-to-video or /reference-to-video; end_image uses a first/last-frame route). Every change is listed under "adjustments"; a feature the model cannot do fails as "incompatible: …" - don't silently drop it, tell the user or pick another model.
route: "auto" (default) may switch Veo / Nano Banana between fal and Google when both keys exist and the first route failed before accepting the request (auth, billing, capacity, outage, retired model) - never on moderation or invalid input; "exact" = only this model; "fal"/"google" = force that provider's equivalent. Capacity/outage errors are retried twice with backoff automatically.
Failures come back with category (auth|billing|capacity|outage|moderation|invalid_input|model_unavailable|ambiguous), accepted, retryable and a hint - follow the hint. Moderation: at most ONE retry with a reworded prompt or another model, never lower safety settings. Billing: tell the user which key/plan is out of credit and offer a cheaper or local route.
Cost: quote first with media_estimate. A batch above the ask-before limit (default $5; 0 = every paid one) or with an unknown price returns APPROVAL_REQUIRED with a card to show; nothing is sent until the user approves (approval_id). The chat's cap (spend_cap_set) and OH_SPEND_CAP_USD (per day) refuse jobs that would cross them ("Nothing was submitted"); unknown prices under a cap need allow_unpriced=true after the user agreed. Several takes at once: media_generate_batch.`,
      inputSchema: {
        kind: z.enum(["image", "video", "speech", "music", "sfx"]).optional(),
        model: z.string().optional(),
        prompt: z.string().optional().describe("Prompt, or the text to speak for speech"),
        title: z.string().optional().describe("Short name for file names, e.g. 'hero poster'"),
        references: z
          .array(z.string())
          .optional()
          .describe(
            "Reference images (paths or URLs) for editing / image-to-video (first = start frame), e.g. a Blender render",
          ),
        end_image: z
          .string()
          .optional()
          .describe("Last frame (path or URL) for video models with first/last-frame control"),
        video: z
          .string()
          .optional()
          .describe(
            "Source video (path or URL) for video-to-video models: restyle, edit, relight, render-to-real (a Blender previs render becomes realistic footage). Local files are uploaded to the provider. Routes to the model's /video-to-video or /edit endpoint.",
          ),
        parameters: parametersSchema,
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Native provider input fields (see media_model_schema); override the mapped ones",
          ),
        route: z
          .enum(ROUTE_NAMES)
          .optional()
          .describe(
            'Which seller runs it when several sell the same model (Seedance 2.5: fal / Runware / Replicate; Veo, Nano Banana: fal / Google). "auto" = "cheapest" (default): the cheapest route with a key that can carry the request; "quality": the model\'s own provider first; "exact": only this model id; or a provider name to pin it.',
          ),
        approval_id: z
          .string()
          .optional()
          .describe(
            "After APPROVAL_REQUIRED: the id from the card the user approved (only after they picked Approve)",
          ),
        request_id: z
          .string()
          .optional()
          .describe(
            "Idempotency key: same id + same input returns the same job; same id + different input is an error",
          ),
        allow_unpriced: z
          .boolean()
          .optional()
          .describe(
            "Under a spend cap: run even though the price is unknown (only after the user agreed)",
          ),
        cast: castIds,
        fresh: z.boolean().optional(),
        wait_seconds: z.number().min(0).max(300).optional(),
      },
    },
    async ({
      cast,
      kind,
      model,
      prompt,
      title,
      references,
      end_image,
      video,
      parameters,
      input,
      route,
      request_id,
      allow_unpriced,
      approval_id,
      fresh,
      wait_seconds,
    }) => {
      if (parameters?.draft && !(model && groupOf(model)?.id === "seedance-2.5"))
        return fail(
          `parameters.draft works only with Seedance 2.5 (bytedance/seedance-2.5/*, runware:bytedance:seedance@2.5). For a cheap first pass on other models use a draft tier: minimax/h3-max-turbo/text-to-video (768P) for video, FLUX.2 klein or Nano Banana at 0.5–1K for stills. Nothing was submitted.`,
        );
      const chosen =
        model || defaultModel(kind ?? "image", loadKeys(), { edit: !!references?.length });
      if (!chosen) return noKey(kind ?? "image");
      const resolvedKind = await resolveKind(chosen, kind);
      const injected = injectCast(cast, { prompt, references }, resolvedKind);
      if (injected.error)
        return codedFail(injected.error.code, injected.error.message, injected.error.remedy);
      const request = toRequest(chosen, {
        prompt: injected.prompt,
        references: injected.references,
        end_image,
        video,
        parameters,
        input,
        route,
      });
      const missing = [
        ...(request.references ?? []),
        ...(request.endImage ? [request.endImage] : []),
        ...(request.video ? [request.video] : []),
      ].find((r) => !/^(https?:|data:)/.test(r) && !existsSync(r));
      if (missing) return fail(`Reference file not found: ${missing}`);
      try {
        if ((route === "fal" || route === "google") && !groupOf(chosen))
          routeCandidates(chosen, route);
      } catch (error) {
        return fail(
          `${(error as Error).message}${error instanceof MediaError && error.hint ? `\nhint: ${error.hint}` : ""}`,
        );
      }
      if (injected.use) {
        // dry prepare (no upload, no charge): the model must have somewhere to put the references
        try {
          await prepare(request, chosen, loadKeys(), AbortSignal.timeout(20_000), resolvedKind);
        } catch (error) {
          if (/incompatible/i.test((error as Error).message))
            return codedFail(
              "INVALID_INPUT",
              `${chosen} cannot take the cast references: ${(error as Error).message}`,
              "Pick an image/video model with a reference input (media_models, media_model_schema), e.g. a /edit or reference-to-video endpoint; nothing was spent.",
            );
        }
      }
      if (request.video && !/^(https?:|data:)/.test(request.video)) {
        const seconds = await probeSeconds(request.video);
        if (seconds !== undefined) request.inputSeconds = seconds;
      }
      const item: BatchItem = {
        request,
        kind: resolvedKind,
        ...(title ? { title } : {}),
        ...(request_id ? { requestId: request_id } : {}),
        ...(injected.use ? { cast: injected.use.record } : {}),
      };
      const batch = await submitBatch([item], {
        projectPath: project(),
        ...(fresh ? { fresh: true } : {}),
        ...(allow_unpriced ? { allowUnpriced: true } : {}),
        ...(approval_id ? { approvalId: approval_id } : {}),
      });
      if (batch.status !== "submitted")
        return batch.status === "approval_required" ? text(explain(batch)) : fail(explain(batch));
      const { job, reused } = batch.jobs[0]!;
      const [done] = await jobs.wait([job.id], "all", (wait_seconds ?? 90) * 1000);
      const body = `${reused ? "(reused an identical earlier job)\n" : ""}${injected.use ? `Cast injected: ${castAdjustments(injected.use).join("; ")}\n` : ""}${jobs.describe(done!)}`;
      if (done!.state === "failed" || done!.state === "uncertain") return fail(body);
      if (done!.state !== "completed")
        return text(`${body}\nStill running — call jobs_wait with this id.`);
      return {
        content: [
          { type: "text" as const, text: body },
          ...imagePreviews(done!.outputs),
          ...(await castBriefs(done!, injected.use)),
        ],
      };
    },
  );

  server.registerTool(
    "media_estimate",
    {
      description: `Price before generating, on every route that sells the model, and who pays. Pass the request you would give media_generate (or just a model); count = takes, including planned retakes. Lists each route (fal, Runware, Replicate, Google…) with per-take and whole-request totals, which one runs (the cheapest that has a key and can carry the request), and why others are skipped. usd null = unknown (never 0): say so. For a 1080p Seedance 2.5 batch it also quotes the same batch as 480p drafts. finish_of: quote finishing a draft job at 1080p. Shows whether the user must approve it (ask-before limit) and the chat/daily caps.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        model: z.string().optional(),
        kind: z.enum(["image", "video", "speech", "music", "sfx"]).optional(),
        request: z
          .object({
            model: z.string().optional(),
            kind: z.enum(["image", "video", "speech", "music", "sfx"]).optional(),
            prompt: z.string().optional(),
            references: z.array(z.string()).optional(),
            end_image: z.string().optional(),
            video: z.string().optional(),
            parameters: parametersSchema,
            input: z.record(z.string(), z.unknown()).optional(),
            route: z.enum(ROUTE_NAMES).optional(),
            cast: castIds,
          })
          .optional(),
        count: z.number().int().min(1).max(100).optional(),
        finish_of: z
          .string()
          .optional()
          .describe("A draft job id: quote finishing that take at 1080p"),
      },
    },
    async ({ model, kind, request: r, count, finish_of }) => {
      const keys = loadKeys();
      const takes = count ?? 1;
      let request: GenerateRequest;
      let k: string = r?.kind ?? kind ?? "image";
      const lines: string[] = [];
      let use: CastUse | undefined;
      if (finish_of) {
        const made = finishRequest(finish_of);
        if ("error" in made) return fail(made.error);
        request = made.request;
        k = "video";
      } else {
        const chosen =
          r?.model ??
          model ??
          defaultModel(k, keys, { edit: !!r?.references?.length }) ??
          Object.values(DEFAULT_MODELS[k] ?? {})[0];
        if (!chosen) return fail("Name a model or kind.");
        // a placeholder prompt so required-field checks don't hide the price
        const injected = injectCast(
          r?.cast,
          { prompt: r?.prompt ?? "(estimate)", references: r?.references },
          await resolveKind(chosen, k),
        );
        if (injected.error)
          return codedFail(injected.error.code, injected.error.message, injected.error.remedy);
        use = injected.use;
        if (use) lines.push(`Cast: ${castAdjustments(use).join("; ")}`);
        request = toRequest(chosen, {
          ...r,
          prompt: injected.prompt,
          references: injected.references,
        });
        if (request.video && !/^(https?:|data:)/.test(request.video)) {
          const seconds = await probeSeconds(request.video);
          if (seconds !== undefined) request.inputSeconds = seconds;
        }
      }
      const quote = await quoteBatch([{ request, kind: k, count: takes }]);
      const item = quote.items[0]!;
      lines.push(...describeRoutes(item.routes, takes));
      // How the chosen route will map the request (snapped values, or why it would fail).
      if (item.chosen && !finish_of && providerOf(item.chosen.model) !== "elevenlabs") {
        try {
          const prepared = await prepare(
            item.chosen.request,
            item.chosen.model,
            keys,
            AbortSignal.timeout(20_000),
            k,
          );
          if (prepared.adjustments.length)
            lines.push(`  adjustments: ${prepared.adjustments.join("; ")}`);
        } catch (error) {
          lines.push(`  would fail: ${(error as Error).message}`);
        }
      }
      lines.push(`Total: ${money(quote.usd, quote.usdMax)} for ${takes} take(s) (approximate).`);
      const p = request.parameters ?? {};
      if (
        groupOf(request.model)?.id === "seedance-2.5" &&
        String(p.resolution ?? "").toLowerCase() === "1080p" &&
        !p.draft &&
        !finish_of &&
        // no draft offer for shots with cast faces (drafts of them are often refused)
        !use
      ) {
        const drafts = await quoteBatch([
          { request: { ...request, parameters: { ...p, draft: true } }, kind: k, count: takes },
        ]);
        const finishOne = item.chosen?.quote
          ? (await quoteBatch([{ request, kind: k, count: 1 }])).usd
          : null;
        if (drafts.usd !== null)
          lines.push(
            `Draft option: the same ${takes} take(s) as 480p drafts on ${drafts.items[0]!.chosen?.provider}: ${money(drafts.usd, drafts.usdMax)}; each kept take is then finished at 1080p for about ${money(finishOne)} (media_finish_draft, same take). Finishing is paid on top, so drafts save money only on takes you drop or redo.`,
          );
      }
      if (use && judgeEnabled()) {
        const per = (k === "video" ? 3 : 2) * JUDGE_CALL_USD * takes;
        lines.push(
          `+ likeness judge after generation (${JUDGE_ENDPOINT}, ${k === "video" ? "3 frames x 1 call" : "2 calls, a 3rd if they disagree"} per card): ~$${(per * use.cards.length).toFixed(2)}, paid by your fal key, counted in the spend ledger.`,
        );
      }
      lines.push(...spendLines(quote));
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "media_models",
    {
      description:
        "Search the fal.ai model catalog (image, video, audio, 3D, upscaling, background removal…) and see which API keys are configured, the default models, equivalent fal/Google routes and providers currently cooling down after errors.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().optional(),
        category: z
          .string()
          .optional()
          .describe("e.g. text-to-image, image-to-video, text-to-speech"),
        limit: z.number().int().max(50).optional(),
      },
    },
    async ({ query, category, limit }) => {
      const keys = loadKeys();
      const configured = Object.entries(KEY_NAMES)
        .filter(([, k]) => keys[k])
        .map(([n]) => n);
      const lines = [
        `Configured keys: ${configured.join(", ") || "none"}`,
        `Defaults: ${JSON.stringify(DEFAULT_MODELS)}`,
        `Equivalent routes (route:"auto" falls back between them): ${EQUIVALENT_ROUTES.map((g) => `${g.label}: ${g.fal} ↔ ${g.google}`).join("; ")}`,
      ];
      const cooling = listCooldowns((p) => keys[KEY_NAMES[p]!] ?? "");
      if (cooling.length) lines.push(`Cooling down: ${cooling.join("; ")}`);
      try {
        const found = await falSearchModels(keys.falApiKey, query ?? "", category, limit ?? 20);
        lines.push(
          "",
          "fal.ai catalog:",
          ...found.map(
            (m) =>
              `- ${m.id}${m.category ? ` [${m.category}]` : ""}${m.name ? ` — ${m.name}` : ""}${m.description ? `: ${m.description}` : ""}`,
          ),
        );
      } catch (error) {
        lines.push(`(fal catalog unavailable: ${String(error).slice(0, 200)})`);
      }
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "media_model_schema",
    {
      description:
        "Input JSON schema (and category/kind) of a fal.ai endpoint, to fill media_generate.input precisely. Cached in ~/.open-herness/cache/schemas/.",
      annotations: { readOnlyHint: true },
      inputSchema: { model: z.string() },
    },
    async ({ model }) => {
      try {
        return text(JSON.stringify(await falModelSchema(model), null, 2).slice(0, 12000));
      } catch (error) {
        return fail(String(error));
      }
    },
  );

  server.registerTool(
    "media_set_key",
    {
      description:
        "Store an API key the user gave you (saved to ~/.open-herness/keys.json, readable only by the user). Never echo the key back.",
      inputSchema: {
        provider: z.enum(["fal", "openai", "google", "elevenlabs", "runware", "replicate"]),
        key: z.string().min(8),
      },
    },
    async ({ provider, key }) => {
      saveKey(KEY_NAMES[provider]!, key.trim());
      return text(`Saved the ${provider} key.`);
    },
  );

  server.registerTool(
    "media_provenance",
    {
      description:
        "Where a take came from: model and served provider/endpoint, prompt, generic + native input, reference files (sha256), seed, provider request id, timings, attempts/adjustments and cost estimate. Works for renamed or copied files too (matched by sha256 against ./takes/.meta).",
      annotations: { readOnlyHint: true },
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const p = abs(path);
      const found = findProvenance(p, [join(project(), "takes")]);
      if (!found)
        return fail(
          existsSync(p)
            ? `No provenance for ${p} (not generated by media_generate here, or the .meta sidecar was removed).`
            : `File not found: ${p}`,
        );
      return text(
        `${found.matchedBy === "sha256" ? `Matched by content (sha256) to ${found.sidecar}\n` : ""}${JSON.stringify(found.data, null, 2).slice(0, 12000)}`,
      );
    },
  );

  server.registerTool(
    "jobs_status",
    {
      description:
        "Status of media jobs (by ids, or the latest in this project), with typical duration and slowness flags. collect=true re-polls jobs that were accepted by the provider but have no files yet (server restart, failed download, uncertain) and downloads their results.",
      inputSchema: { ids: z.array(z.string()).optional(), collect: z.boolean().optional() },
    },
    async ({ ids, collect }) => {
      let list = ids?.length
        ? ids.map((id) => jobs.get(id)).filter((j): j is jobs.MediaJob => !!j)
        : jobs.list(project());
      let note = "";
      if (collect) {
        const restarted = jobs.collect(list.map((j) => j.id));
        note = restarted.length
          ? `Recollecting ${restarted.length} job(s)…\n`
          : "Nothing to recollect (no accepted jobs without files).\n";
        if (restarted.length)
          list = await jobs.wait(
            list.map((j) => j.id),
            "all",
            20_000,
          );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: note + (list.map((j) => jobs.describe(j)).join("\n\n") || "No jobs."),
          },
          ...(collect ? imagePreviews(list.flatMap((j) => j.outputs ?? [])) : []),
        ],
      };
    },
  );

  server.registerTool(
    "jobs_wait",
    {
      description:
        "Wait for media jobs to finish (all or any), up to timeout_seconds (max 120). If a job is flagged unusuallySlow or stalled, stop polling and ask the user: keep waiting, switch model, or cancel.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        ids: z.array(z.string()),
        mode: z.enum(["all", "any"]).optional(),
        timeout_seconds: z.number().min(1).max(120).optional(),
      },
    },
    async ({ ids, mode, timeout_seconds }) => {
      const list = await jobs.wait(ids, mode ?? "all", (timeout_seconds ?? 60) * 1000);
      return {
        content: [
          { type: "text" as const, text: list.map((j) => jobs.describe(j)).join("\n\n") },
          ...imagePreviews(list.flatMap((j) => j.outputs ?? [])),
        ],
      };
    },
  );

  server.registerTool(
    "jobs_cancel",
    { description: "Cancel a media job.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const job = jobs.cancel(id);
      return job ? text(jobs.describe(job)) : fail("Unknown job.");
    },
  );

  server.registerTool(
    "jobs_retry",
    {
      description:
        "Retry a failed, cancelled or uncertain media job from its saved request (cast injection included). Repeats resolve to the same new job (derived request id). If the provider already finished but the files were never downloaded, it collects them instead of regenerating (no new charge). If the job was accepted before it failed (possibly charged) you get CONFIRM_REQUIRED: ask the user, then confirm_fresh=true. model must equal the alternative named in the job's failure (equivalent fal/Google route after capacity / model_unavailable). Errors: CONFLICT (job still running / nothing to retry), NOT_FOUND, INVALID_INPUT, COLLECTION_FAILED, CONFIRM_REQUIRED.",
      inputSchema: {
        id: z.string().optional().describe("The job to retry"),
        job_id: z.string().optional().describe("Same as id (older name)"),
        model: z.string().optional(),
        confirm_fresh: z
          .boolean()
          .optional()
          .describe("Only after the user agreed to a possibly double charge"),
        fresh_confirm: z.boolean().optional().describe("Same as confirm_fresh (older name)"),
        approval_id: z
          .string()
          .optional()
          .describe("After APPROVAL_REQUIRED: the id of the card the user approved"),
      },
    },
    async ({ id, job_id, model, confirm_fresh, fresh_confirm, approval_id }) => {
      const target = id ?? job_id;
      if (!target) return codedFail("INVALID_INPUT", "Name the job: jobs_retry {id}.");
      const result = jobs.retry(target, {
        projectPath: project(),
        planOnly: true,
        ...(model ? { model } : {}),
        ...(confirm_fresh || fresh_confirm ? { confirmFresh: true } : {}),
      });
      if (!result.ok) return codedFail(result.code, result.message, result.remedy);
      let started: jobs.MediaJob;
      let head: string;
      if (result.action === "plan") {
        // A new paid take: same quote, approval and cap rules as media_generate.
        const p = result.plan;
        const batch = await submitBatch(
          [
            {
              request: p.request,
              kind: p.kind,
              title: p.title,
              requestId: p.requestId,
              retryOf: p.retryOf,
              ...(p.cast ? { cast: p.cast } : {}),
            },
          ],
          {
            projectPath: project(),
            ...(p.allowUnpriced ? { allowUnpriced: true } : {}),
            ...(approval_id ? { approvalId: approval_id } : {}),
          },
        );
        if (batch.status !== "submitted")
          return batch.status === "approval_required" ? text(explain(batch)) : fail(explain(batch));
        const first = batch.jobs[0]!;
        started = first.job;
        head = `${first.reused ? "Same retry as before" : "New job"} ${started.id}`;
      } else {
        started = result.job;
        head =
          result.action === "collect"
            ? `Collecting the finished result of job ${started.id} (no new generation)`
            : `New job ${started.id}`;
      }
      const [done] = await jobs.wait([started.id], "all", 20_000);
      const job = done ?? started;
      head +=
        job.retryOf && job.state === "failed" && head.startsWith("Same")
          ? " (it failed too - retry that id, not the old one)."
          : ".";
      return {
        content: [
          {
            type: "text" as const,
            text: `${head}\n${jobs.describe(job)}${["waiting", "preparing", "queued", "running"].includes(job.state) ? "\nCall jobs_wait for the outcome." : ""}`,
          },
          ...imagePreviews(job.outputs),
        ],
        ...(job.state === "failed" || job.state === "uncertain" ? { isError: true } : {}),
      };
    },
  );

  server.registerTool(
    "speak_local",
    {
      description:
        "Offline text-to-speech with macOS voices (no key). e.g. voice 'Zosia' for Polish.",
      inputSchema: { text: z.string(), voice: z.string().optional(), title: z.string().optional() },
    },
    async ({ text: t, voice, title }) => {
      const d = join(project(), "takes");
      mkdirSync(d, { recursive: true });
      const out = join(
        d,
        `${(title ?? "voice").replace(/[^\w-]+/g, "-").toLowerCase()}-${Date.now().toString(36)}.m4a`,
      );
      const tmp = join(mkdtempSync(join(tmpdir(), "oh-say-")), "say.aiff");
      await run("say", [...(voice ? ["-v", voice] : []), "-o", tmp, t]);
      await run("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-c:a", "aac", out]);
      rmSync(tmp, { force: true });
      return text(`Saved ${out}`);
    },
  );

  server.registerTool(
    "media_inspect",
    {
      description: "ffprobe a media file (duration, streams, resolution, codecs).",
      annotations: { readOnlyHint: true },
      inputSchema: { path: z.string() },
    },
    async ({ path }) => {
      const { stdout } = await run("ffprobe", [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        abs(path),
      ]);
      return text(stdout.slice(0, 8000));
    },
  );

  server.registerTool(
    "media_frames",
    {
      description:
        "Contact sheet of evenly spaced frames from a video, returned as an image, to review it visually.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        path: z.string(),
        frames: z.number().int().min(2).max(48).optional(),
        columns: z.number().int().min(1).max(8).optional(),
      },
    },
    async ({ path, frames = 12, columns = 4 }) => {
      const src = abs(path);
      const { stdout } = await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        src,
      ]);
      const duration = Number(stdout.trim()) || 1;
      const sheet = join(mkdtempSync(join(tmpdir(), "oh-sheet-")), "sheet.jpg");
      await run(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          src,
          "-vf",
          `fps=${frames / duration},scale=360:-1,tile=${columns}x${Math.ceil(frames / columns)}`,
          "-frames:v",
          "1",
          sheet,
        ],
        { timeout: 300_000 },
      );
      const data = readFileSync(sheet).toString("base64");
      return {
        content: [
          { type: "text" as const, text: `${frames} frames over ${duration.toFixed(1)}s` },
          { type: "image" as const, data, mimeType: "image/jpeg" },
        ],
      };
    },
  );

  server.registerTool(
    "ffmpeg",
    {
      description:
        "Run ffmpeg (working directory = project): cut, concat, mix audio, add music or voice-over to a Blender render, subtitles, convert, GIFs. Write outputs into ./takes/ under new names; existing files are not overwritten unless overwrite=true.",
      inputSchema: { args: z.array(z.string()), overwrite: z.boolean().optional() },
    },
    async ({ args, overwrite }) => {
      try {
        const { stderr } = await run(
          "ffmpeg",
          ["-hide_banner", overwrite ? "-y" : "-n", ...args.filter((a) => a !== "-y" || overwrite)],
          { cwd: project(), timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 },
        );
        return text(`ffmpeg finished.\n${stderr.slice(-2000)}`);
      } catch (error) {
        return fail(
          `ffmpeg failed: ${(error as { stderr?: string }).stderr?.slice(-3000) ?? String(error)}`,
        );
      }
    },
  );
}

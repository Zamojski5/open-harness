// fal endpoint schemas (public OpenAPI, no key needed), cached in ~/.open-herness/cache/schemas/,
// and the converter that maps the generic request onto an endpoint's real input fields.

import { ohHome } from "../home.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FieldInfo {
  type: string;
  nullable: boolean;
  enum?: (string | number)[];
  /** string-enum branch of an anyOf (e.g. flux image_size presets next to a {width,height} object) */
  presets?: string[];
  min?: number;
  max?: number;
  default?: unknown;
  itemsType?: string;
  maxItems?: number;
}

export interface EndpointSchema {
  id: string;
  category?: string;
  fields: Record<string, FieldInfo>;
  required: string[];
  /** the raw input schema, for media_model_schema */
  raw: unknown;
}

const SCHEMA_TTL = 7 * 24 * 3600_000;
const MISSING_TTL = 24 * 3600_000;
const cacheDir = () => ohHome("cache", "schemas");
const cacheFile = (id: string) => join(cacheDir(), `${id.replace(/[^\w.-]+/g, "__")}.json`);
const memo = new Map<string, EndpointSchema | null>();

type Json = Record<string, any>;

function deref(spec: Json, node: Json | undefined): Json {
  let n = node ?? {};
  for (let i = 0; i < 5 && typeof n.$ref === "string"; i++)
    n = spec.components?.schemas?.[n.$ref.split("/").pop()!] ?? {};
  return n;
}

function fieldInfo(spec: Json, raw: Json): FieldInfo {
  const node = deref(spec, raw);
  const branches = (
    (node.anyOf ?? node.oneOf ?? (node.allOf?.length === 1 ? node.allOf : undefined)) as
      | Json[]
      | undefined
  )?.map((b) => deref(spec, b));
  const info: FieldInfo = { type: node.type ?? "unknown", nullable: false };
  if (branches) {
    info.nullable = branches.some((b) => b.type === "null");
    const main = branches.filter((b) => b.type !== "null");
    const enumBranch = main.find((b) => Array.isArray(b.enum));
    if (main.length === 1)
      Object.assign(info, fieldInfo(spec, main[0]!), { nullable: info.nullable });
    else if (enumBranch) {
      info.type = main.some((b) => b.type === "object" || b.properties)
        ? "object|string"
        : "string";
      info.presets = enumBranch.enum.map(String);
    } else info.type = main.map((b) => b.type ?? "object").join("|");
  }
  if (Array.isArray(node.enum)) info.enum = node.enum;
  if (typeof node.minimum === "number") info.min = node.minimum;
  if (typeof node.maximum === "number") info.max = node.maximum;
  if (node.default !== undefined) info.default = node.default;
  if (node.items) info.itemsType = deref(spec, node.items).type ?? "object";
  if (typeof node.maxItems === "number") info.maxItems = node.maxItems;
  return info;
}

/** Parse a fal queue OpenAPI document into the endpoint's input fields (via POST requestBody, not by schema name). */
export function parseFalSpec(id: string, spec: Json): EndpointSchema {
  let input: Json | undefined;
  for (const item of Object.values((spec.paths ?? {}) as Record<string, Json>)) {
    const ref = item.post?.requestBody?.content?.["application/json"]?.schema;
    if (ref) {
      input = deref(spec, ref);
      break;
    }
  }
  if (!input) {
    const schemas = (spec.components?.schemas ?? {}) as Record<string, Json>;
    input = schemas[Object.keys(schemas).find((n) => /Input$/.test(n)) ?? ""] ?? {};
  }
  const fields: Record<string, FieldInfo> = {};
  for (const [name, raw] of Object.entries((input.properties ?? {}) as Record<string, Json>))
    fields[name] = fieldInfo(spec, raw);
  const category = spec.info?.["x-fal-metadata"]?.category;
  return {
    id,
    ...(category ? { category } : {}),
    fields,
    required: (input.required ?? []) as string[],
    raw: input,
  };
}

/**
 * Schema of a fal endpoint, or null when fal says the endpoint does not exist (404).
 * Cached 7 days (missing: 1 day); a stale cache is used when the network fails.
 */
export async function falEndpointSchema(
  id: string,
  opts: { refresh?: boolean } = {},
): Promise<EndpointSchema | null> {
  if (!opts.refresh && memo.has(id)) return memo.get(id)!;
  let cached: { fetchedAt: number; spec?: Json; missing?: boolean } | undefined;
  try {
    cached = JSON.parse(readFileSync(cacheFile(id), "utf8"));
  } catch {
    // not cached
  }
  const fresh =
    cached && Date.now() - cached.fetchedAt < (cached.missing ? MISSING_TTL : SCHEMA_TTL);
  if (cached && fresh && !opts.refresh) {
    const parsed = cached.spec ? parseFalSpec(id, cached.spec) : null;
    memo.set(id, parsed);
    return parsed;
  }
  try {
    const res = await fetch(
      `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(id)}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (res.status === 404) {
      write(id, { fetchedAt: Date.now(), missing: true });
      memo.set(id, null);
      return null;
    }
    if (!res.ok) throw new Error(`fal schema ${res.status}`);
    const spec = (await res.json()) as Json;
    write(id, { fetchedAt: Date.now(), spec });
    const parsed = parseFalSpec(id, spec);
    memo.set(id, parsed);
    return parsed;
  } catch (error) {
    if (cached?.spec) return parseFalSpec(id, cached.spec);
    throw error;
  }
}

function write(id: string, data: unknown) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(id), JSON.stringify(data));
  } catch {
    // cache is best effort
  }
}

export function kindFromCategory(
  category: string | undefined,
  hint?: string,
): "image" | "video" | "speech" | "music" | "sfx" | "other" | undefined {
  if (!category) return undefined;
  if (/to-video|video-to|^video/.test(category)) return "video";
  if (/to-image|image-to|^image|upscal|editing/.test(category)) return "image";
  if (/speech/.test(category)) return "speech";
  if (/audio|music/.test(category))
    return hint === "sfx" || hint === "music"
      ? hint
      : /sound|sfx|effect|foley/i.test(hint ?? "")
        ? "sfx"
        : "music";
  return "other";
}

// ---------------- generic → native ----------------

export interface GenericParams {
  prompt?: string;
  /** data URIs or URLs, already resolved */
  references?: string[];
  endImage?: string;
  /** source video (URL or local path, uploaded at submit) */
  video?: string;
  duration?: number;
  aspect_ratio?: string;
  resolution?: string;
  audio?: boolean;
  negative_prompt?: string;
  seed?: number;
  num_outputs?: number;
  loop?: boolean;
}

export interface Converted {
  input: Record<string, unknown>;
  /** what we changed to fit the endpoint (snapped values, ignored features) */
  adjustments: string[];
  /** requested features this endpoint cannot do at all */
  incompatible: string[];
}

const START_FIELDS = [
  "image_url",
  "start_image_url",
  "first_frame_url",
  "input_image_url",
  "init_image_url",
  "reference_image_url",
];
const ARRAY_FIELDS = ["image_urls", "reference_image_urls", "input_image_urls", "reference_images"];
const VIDEO_FIELDS = [
  "video_url",
  "input_video_url",
  "source_video_url",
  "video",
  "init_video_url",
  "reference_video_url",
];
const VIDEO_ARRAY_FIELDS = [
  "video_urls",
  "reference_video_urls",
  "input_video_urls",
  "source_video_urls",
];
const END_FIELDS = [
  "end_image_url",
  "last_frame_url",
  "tail_image_url",
  "last_image_url",
  "end_frame_url",
];
const DURATION_FIELDS = ["duration", "duration_seconds", "seconds", "num_seconds", "length"];
const AUDIO_FIELDS = ["generate_audio", "enable_audio", "with_audio", "audio"];
const COUNT_FIELDS = ["num_images", "num_outputs", "num_videos", "n"];

const pick = (s: EndpointSchema, names: string[], ok: (f: FieldInfo) => boolean = () => true) =>
  names.find((n) => s.fields[n] && ok(s.fields[n]!));
const num = (v: unknown) => Number(String(v).match(/-?\d+(\.\d+)?/)?.[0] ?? NaN);

/** Nearest allowed value; the result is in the field's own format (Veo "8s", Kling "5", numbers stay numbers). */
export function snapDuration(
  field: FieldInfo,
  seconds: number,
): { value: unknown; seconds: number } {
  if (field.enum?.length) {
    const opts = field.enum.map((v) => ({ v, s: num(v) })).filter((o) => Number.isFinite(o.s));
    const best = opts.reduce((a, b) =>
      Math.abs(b.s - seconds) < Math.abs(a.s - seconds) ||
      (Math.abs(b.s - seconds) === Math.abs(a.s - seconds) && b.s > a.s)
        ? b
        : a,
    );
    return { value: best.v, seconds: best.s };
  }
  let s = seconds;
  if (field.min !== undefined) s = Math.max(field.min, s);
  if (field.max !== undefined) s = Math.min(field.max, s);
  if (field.type.includes("integer")) s = Math.round(s);
  if (field.type === "string") {
    const def = String(field.default ?? "");
    return { value: /^\d+(\.\d+)?s$/.test(def) ? `${s}s` : String(s), seconds: s };
  }
  return { value: s, seconds: s };
}

const ratio = (ar: string) => {
  const [w, h] = ar.split(/[:x/]/).map(Number);
  return w && h ? w / h : NaN;
};

const IMAGE_SIZE_PRESETS: Record<string, number> = {
  square_hd: 1,
  square: 1,
  portrait_4_3: 3 / 4,
  portrait_16_9: 9 / 16,
  landscape_4_3: 4 / 3,
  landscape_16_9: 16 / 9,
};

// Resolution labels come in two families: video heights ("720p", "1080p", lowercase "4k" = 2160p)
// and image widths ("0.5K", "1K", "2K", "4K" in multiples of 1024). Nearest match within a family,
// rough conversion across families (1080p ≈ 2K, 720p ≈ 1K).
const family = (label: string) =>
  /p$/i.test(label) || /^\d+k$/.test(label)
    ? "p"
    : /K$/.test(label) || /k$/i.test(label)
      ? "k"
      : "?";
export function resolutionPixels(label: string): number {
  const t = label.trim();
  if (/p$/i.test(t)) return num(t);
  if (/^\d+k$/.test(t)) return { 2: 1440, 4: 2160, 8: 4320 }[num(t)] ?? num(t) * 540;
  if (/k$/i.test(t)) return num(t) * 1024;
  return num(t);
}
const CROSS: Record<string, Record<number, number>> = {
  p: { 480: 512, 720: 1024, 1080: 2048, 1440: 2048, 2160: 4096 },
  k: { 512: 480, 1024: 720, 2048: 1080, 4096: 2160 },
};

function nearestResolution(options: string[], wanted: string): string | undefined {
  const exact = options.find((o) => o.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const wf = family(wanted);
  let w = resolutionPixels(wanted);
  let pool = options.filter((o) => family(o) === wf);
  if (!pool.length) {
    w = CROSS[wf]?.[w] ?? w;
    pool = options.filter((o) => family(o) !== "?");
  }
  if (!pool.length || !Number.isFinite(w)) return undefined;
  return pool.reduce((a, b) =>
    Math.abs(resolutionPixels(b) - w) < Math.abs(resolutionPixels(a) - w) ? b : a,
  );
}

/**
 * Map the generic request onto the endpoint's fields. Only fields the schema has are sent;
 * every requested feature either lands in a field, becomes an adjustment note, or an "incompatible" entry.
 */
export function convertForFal(
  schema: EndpointSchema,
  g: GenericParams,
  kind: string,
  native: Record<string, unknown> = {},
): Converted {
  const input: Record<string, unknown> = {};
  const adjustments: string[] = [];
  const incompatible: string[] = [];
  const has = (n: string) => n in schema.fields;
  const id = schema.id;

  if (g.prompt !== undefined) {
    const f = pick(schema, ["prompt", "text"]);
    if (f) input[f] = g.prompt;
    else incompatible.push(`prompt (${id} has no prompt/text field)`);
  }

  // references and end frame
  const refs = g.references ?? [];
  if (refs.length) {
    const arr = pick(
      schema,
      ARRAY_FIELDS,
      (f) => f.type === "array" && (f.itemsType === "string" || f.itemsType === undefined),
    );
    const single = pick(schema, START_FIELDS);
    if (arr && (refs.length > 1 || !single)) {
      const max = schema.fields[arr]!.maxItems;
      input[arr] = max && refs.length > max ? refs.slice(0, max) : refs;
      if (max && refs.length > max)
        adjustments.push(
          `${id} takes at most ${max} reference images; used the first ${max}, dropped ${refs.length - max}`,
        );
    } else if (single) {
      input[single] = refs[0];
      if (refs.length > 1)
        adjustments.push(
          `${id} takes one start image (${single}); used the first reference, ignored ${refs.length - 1} more`,
        );
    } else incompatible.push(`references (${id} takes no image input)`);
  }
  if (g.endImage) {
    const end = pick(schema, END_FIELDS);
    if (end) input[end] = g.endImage;
    else incompatible.push(`end_image (${id} has no last-frame field)`);
  }

  if (g.video) {
    const f = pick(schema, VIDEO_FIELDS);
    const arr = f ? undefined : pick(schema, VIDEO_ARRAY_FIELDS, (x) => x.type === "array");
    if (f) input[f] = g.video;
    else if (arr) input[arr] = [g.video];
    else incompatible.push(`video (${id} takes no source video)`);
  }

  if (g.duration !== undefined) {
    const f = pick(schema, DURATION_FIELDS);
    if (f) {
      const snapped = snapDuration(schema.fields[f]!, g.duration);
      input[f] = snapped.value;
      if (snapped.seconds !== g.duration)
        adjustments.push(
          `duration ${g.duration}s → ${snapped.seconds}s (allowed by ${id}: ${schema.fields[f]!.enum?.join(", ") ?? `${schema.fields[f]!.min ?? "?"}-${schema.fields[f]!.max ?? "?"}`})`,
        );
    } else if (kind === "image") adjustments.push("duration ignored (image model)");
    else adjustments.push(`${id} has no duration control; length is the model's default`);
  }

  if (g.aspect_ratio) {
    const f = schema.fields.aspect_ratio;
    const size = schema.fields.image_size;
    if (f) {
      const options = (f.enum ?? f.presets ?? [])
        .map(String)
        .filter((o) => o !== "auto" && Number.isFinite(ratio(o)));
      if (!options.length || options.includes(g.aspect_ratio)) input.aspect_ratio = g.aspect_ratio;
      else {
        const want = ratio(g.aspect_ratio);
        const best = options.reduce((a, b) =>
          Math.abs(Math.log(ratio(b) / want)) < Math.abs(Math.log(ratio(a) / want)) ? b : a,
        );
        input.aspect_ratio = best;
        adjustments.push(
          `aspect_ratio ${g.aspect_ratio} → ${best} (allowed by ${id}: ${options.join(", ")})`,
        );
      }
    } else if (size?.presets?.length) {
      const want = ratio(g.aspect_ratio);
      const options = size.presets.filter((p) => p in IMAGE_SIZE_PRESETS);
      const best = options.reduce(
        (a, b) =>
          Math.abs(Math.log(IMAGE_SIZE_PRESETS[b]! / want)) <
          Math.abs(Math.log(IMAGE_SIZE_PRESETS[a]! / want))
            ? b
            : a,
        options[0] ?? "",
      );
      if (best) {
        input.image_size = best;
        if (Math.abs(IMAGE_SIZE_PRESETS[best]! - want) > 0.01)
          adjustments.push(`aspect_ratio ${g.aspect_ratio} → image_size ${best} (nearest preset)`);
      }
    } else
      adjustments.push(
        `${id} has no aspect ratio control (follows the reference image or its default)`,
      );
  }

  if (g.resolution) {
    const f = schema.fields.resolution;
    if (f?.enum?.length) {
      const best = nearestResolution(f.enum.map(String), g.resolution);
      if (best) {
        input.resolution = best;
        if (best.toLowerCase() !== g.resolution.toLowerCase())
          adjustments.push(
            `resolution ${g.resolution} → ${best} (allowed by ${id}: ${f.enum.join(", ")})`,
          );
      } else
        adjustments.push(
          `resolution ${g.resolution} not offered by ${id} (${f.enum.join(", ")}); using its default`,
        );
    } else if (f) input.resolution = g.resolution;
    else adjustments.push(`${id} has no resolution control; resolution is its default`);
  }

  if (g.audio !== undefined) {
    const f = pick(schema, AUDIO_FIELDS, (x) => x.type === "boolean");
    if (f) input[f] = g.audio;
    else
      adjustments.push(
        `${id} has no audio switch (audio=${g.audio} not applied; strip audio with ffmpeg -an if needed)`,
      );
  }

  if (g.negative_prompt) {
    if (has("negative_prompt")) input.negative_prompt = g.negative_prompt;
    else adjustments.push(`${id} has no negative_prompt; put exclusions in the prompt instead`);
  }
  if (g.seed !== undefined) {
    if (has("seed")) input.seed = g.seed;
    else adjustments.push(`${id} has no seed field (results not reproducible)`);
  }
  if (g.num_outputs !== undefined && g.num_outputs > 1) {
    const f = pick(schema, COUNT_FIELDS);
    if (f) {
      const max = schema.fields[f]!.max;
      input[f] = max ? Math.min(max, g.num_outputs) : g.num_outputs;
      if (max && g.num_outputs > max)
        adjustments.push(`num_outputs ${g.num_outputs} → ${max} (max of ${id})`);
    } else
      adjustments.push(
        `${id} makes one output per request; submit ${g.num_outputs} jobs for ${g.num_outputs} variants`,
      );
  }
  if (g.loop !== undefined) {
    if (has("loop")) input.loop = g.loop;
    else adjustments.push(`${id} has no loop option`);
  }

  for (const k of Object.keys(native))
    if (!has(k)) adjustments.push(`input.${k} is not in the schema of ${id} (sent as given)`);
  const merged = { ...input, ...native };
  for (const r of schema.required) {
    if (merged[r] !== undefined && merged[r] !== null) continue;
    // A required field with a schema default (e.g. prompt_expansion_mode) is filled, not refused.
    const def = schema.fields[r]?.default;
    if (def !== undefined && def !== null) merged[r] = def;
    else incompatible.push(`missing required field ${r} for ${id}`);
  }
  return { input: merged, adjustments, incompatible };
}

/** Image/frame fields present in an input object (native input that already carries images). */
export const hasVideoInput = (input: Record<string, unknown> | undefined) =>
  !!input && Object.keys(input).some((k) => VIDEO_FIELDS.includes(k));
export const hasImageInput = (input: Record<string, unknown> | undefined) =>
  !!input &&
  Object.keys(input).some((k) => [...START_FIELDS, ...ARRAY_FIELDS, ...END_FIELDS].includes(k));

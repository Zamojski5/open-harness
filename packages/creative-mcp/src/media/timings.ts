// How long generations usually take, per endpoint: hand-seeded for the default models, then learned
// from completed jobs (last 30 runs) in ~/.open-herness/media/timings.json.

import { ohHome } from "../home.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** [typical, p90] seconds from submit to result (seeded by hand, 2026-10). */
const SEED: Record<string, [number, number]> = {
  "fal-ai/veo3.1/fast": [70, 150],
  "fal-ai/veo3.1": [150, 300],
  "fal-ai/nano-banana-2": [15, 40],
  "fal-ai/nano-banana-pro": [30, 80],
  "fal-ai/kling-video/v3/pro": [150, 360],
  "fal-ai/minimax/hailuo-2.3": [120, 300],
  "fal-ai/flux-2-pro": [10, 25],
  "fal-ai/lyria3": [40, 90],
  "fal-ai/elevenlabs/sound-effects/v2": [8, 20],
  "google:veo-3.1-fast-generate-preview": [60, 150],
  "google:veo-3.1-generate-preview": [120, 300],
  "google:gemini-3.1-flash-image": [15, 40],
  "google:gemini-3-pro-image": [30, 80],
  "google:gemini-2.5-flash-image": [10, 30],
  "openai:gpt-image-1": [45, 100],
  "openai:gpt-4o-mini-tts": [5, 15],
  "elevenlabs:tts": [5, 20],
  "elevenlabs:sfx": [6, 15],
  "elevenlabs:music": [45, 120],
};
const BY_KIND: Record<string, [number, number]> = {
  image: [25, 60],
  video: [120, 300],
  speech: [8, 25],
  music: [60, 150],
  sfx: [10, 25],
  other: [60, 180],
};

const file = () => ohHome("media", "timings.json");
let samples: Record<string, number[]> | undefined;

function load(): Record<string, number[]> {
  if (samples) return samples;
  try {
    samples = JSON.parse(readFileSync(file(), "utf8")) as Record<string, number[]>;
  } catch {
    samples = {};
  }
  return samples;
}

/** Timing key: the served fal endpoint, or the route model (ElevenLabs voice suffix stripped). */
export const timingKey = (endpointOrModel: string) =>
  endpointOrModel.replace(/^(elevenlabs:\w+).*/, "$1");

const baseOf = (key: string) =>
  key.replace(
    /\/(image-to-video|first-last-frame-to-video|reference-to-video|text-to-video|image-to-image|edit)$/,
    "",
  );

export function stats(
  key: string,
  kind = "other",
): { typical: number; p90: number; samples: number } {
  const k = timingKey(key);
  const runs = load()[k] ?? [];
  if (runs.length >= 5) {
    const sorted = [...runs].sort((a, b) => a - b);
    return {
      typical: sorted[Math.floor(sorted.length / 2)]!,
      p90: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!,
      samples: runs.length,
    };
  }
  const seed =
    SEED[k] ??
    SEED[baseOf(k)] ??
    Object.entries(SEED).find(([s]) => k.startsWith(s))?.[1] ??
    BY_KIND[kind] ??
    BY_KIND.other!;
  return { typical: seed[0], p90: seed[1], samples: runs.length };
}

export function record(key: string, seconds: number) {
  if (!(seconds > 0)) return;
  const k = timingKey(key);
  const data = load();
  data[k] = [...(data[k] ?? []), Math.round(seconds)].slice(-30);
  try {
    mkdirSync(ohHome("media"), { recursive: true });
    writeFileSync(file(), JSON.stringify(data, null, 1));
  } catch {
    // best effort
  }
}

/** Slowness flags for a running job: unusuallySlow > p90×1.5, stalled > 2×typical. */
export function slowness(key: string, kind: string, elapsedSeconds: number) {
  const s = stats(key, kind);
  return {
    typicalSeconds: s.typical,
    p90Seconds: s.p90,
    unusuallySlow: elapsedSeconds > s.p90 * 1.5,
    stalled: elapsedSeconds > s.typical * 2,
  };
}

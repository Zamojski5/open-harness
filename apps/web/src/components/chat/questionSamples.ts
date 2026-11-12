/**
 * Sample files on a question card: which files a question shows, in which order, and which
 * option each one belongs to.
 */

export type SampleKind = "image" | "video" | "audio" | "other";

export interface QuestionSample {
  readonly path: string;
  readonly kind: SampleKind;
  /** Alt text of a markdown image. */
  readonly label?: string | undefined;
  /** Title of a markdown image. */
  readonly caption?: string | undefined;
  /** Index of the option this sample belongs to. */
  readonly option?: number | undefined;
}

export interface SampleQuestionInput {
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly preview?: string | undefined;
  }>;
}

const MAX_SAMPLES = 24;
const MEDIA_EXTENSIONS: Record<string, SampleKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  ogg: "audio",
};

function sampleKind(path: string): SampleKind {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  return MEDIA_EXTENSIONS[extension] ?? "other";
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g;
const MEDIA_EXTENSION_GROUP = Object.keys(MEDIA_EXTENSIONS).join("|");
// A path-like token ending in a media extension: absolute, ~/, ./, ../ or a bare name. `<path>`
// autolinks (voice auditions) are covered because `<` is not part of the token.
const MEDIA_PATH = new RegExp(
  String.raw`(?:^|[\s(\[<"'\x60])((?:~\/|\.{1,2}\/|\/)?[\w@%+.,=-]+(?:\/[\w@%+.,=-]+)*\.(?:${MEDIA_EXTENSION_GROUP}))(?=$|[\s)\]>"'\x60,.;:!?])`,
  "gi",
);

function markdownImages(text: string): QuestionSample[] {
  return Array.from(text.matchAll(MARKDOWN_IMAGE), (match) => {
    const path = match[2]!.replace(/^file:\/\//, "");
    return {
      path,
      kind: sampleKind(path),
      label: match[1]?.trim() || undefined,
      caption: match[3]?.trim() || undefined,
    };
  });
}

function namedMediaPaths(text: string): string[] {
  const withoutImages = text.replace(MARKDOWN_IMAGE, " ");
  return Array.from(withoutImages.matchAll(MEDIA_PATH), (match) => match[1]!).filter(
    (path) => !/^https?:/i.test(path),
  );
}

const WHOLE_SET_WORDS = /\b(all|both|every|each|these|them|none)\b/i;
const VERDICT_ONLY =
  /^(?:\s*(?:yes|no|approve|approved|redo|skip|ok|okay|reject|accept|keep|retry|fine|good)\b[\s,./!-]*)+$/i;

/** An option a sample can belong to: not a free-text option. */
function isPickable(label: string): boolean {
  return !/\(type below/i.test(label);
}

/** Options like "All of them" or "Approve" answer for the whole set, not one sample. */
function answersWholeSet(label: string): boolean {
  return WHOLE_SET_WORDS.test(label) || VERDICT_ONLY.test(label);
}

function fileWords(path: string): Set<string> {
  const base = path.split(/[\\/]/).at(-1) ?? path;
  return new Set(
    base
      .replace(/\.[a-z0-9]+$/i, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2),
  );
}

function optionWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 2),
  );
}

/**
 * Binds unbound samples to options by a word unique to that file's name appearing in exactly one
 * option, unambiguous on both sides; else, when nothing bound and the counts match (and no sample
 * has a label, and no option answers for the whole set), by position.
 */
function bindToOptions(
  samples: QuestionSample[],
  options: SampleQuestionInput["options"],
): QuestionSample[] {
  const words = samples.map((sample) => fileWords(sample.path));
  const uniqueWords = words.map(
    (set, index) =>
      new Set(
        [...set].filter((word) =>
          words.every((other, otherIndex) => otherIndex === index || !other.has(word)),
        ),
      ),
  );
  const optionTexts = options.map((option) => optionWords(`${option.label} ${option.description}`));
  const boundOptions = new Set(
    samples.flatMap((sample) => (sample.option === undefined ? [] : [sample.option])),
  );
  const proposals = samples.map((sample, index) => {
    if (sample.option !== undefined) return undefined;
    const matches = optionTexts.flatMap((text, optionIndex) =>
      !boundOptions.has(optionIndex) && [...uniqueWords[index]!].some((word) => text.has(word))
        ? [optionIndex]
        : [],
    );
    return matches.length === 1 ? matches[0] : undefined;
  });
  const claimed = new Map<number, number>();
  for (const option of proposals) {
    if (option !== undefined) claimed.set(option, (claimed.get(option) ?? 0) + 1);
  }
  let bound = samples.map((sample, index) => {
    const option = proposals[index];
    return option !== undefined && claimed.get(option) === 1 ? { ...sample, option } : sample;
  });
  const anyBound = bound.some((sample) => sample.option !== undefined);
  const pickable = options.filter((option) => isPickable(option.label));
  if (
    !anyBound &&
    pickable.length === bound.length &&
    pickable.length === options.length &&
    bound.every((sample) => sample.label === undefined) &&
    !options.some((option) => answersWholeSet(option.label))
  ) {
    bound = bound.map((sample, index) => ({ ...sample, option: index }));
  }
  return bound;
}

/**
 * Samples for one question: markdown images in the question, media paths named in its prose, then
 * media named in each option (bound to it when the option names exactly one). Up to 24, no
 * repeats; bound samples first in option order, then the rest.
 */
export function questionSamples(input: SampleQuestionInput): QuestionSample[] {
  const seen = new Set<string>();
  const samples: QuestionSample[] = [];
  const add = (sample: QuestionSample) => {
    if (seen.has(sample.path) || samples.length >= MAX_SAMPLES) return;
    seen.add(sample.path);
    samples.push(sample);
  };
  for (const image of markdownImages(input.question)) add(image);
  for (const path of namedMediaPaths(input.question)) add({ path, kind: sampleKind(path) });
  input.options.forEach((option, index) => {
    const text = `${option.label}\n${option.description}\n${option.preview ?? ""}`;
    const images = markdownImages(text);
    const paths = [...new Set([...images.map((image) => image.path), ...namedMediaPaths(text)])];
    for (const path of paths) {
      const image = images.find((candidate) => candidate.path === path);
      const existing = samples.findIndex((sample) => sample.path === path);
      const option = paths.length === 1 ? index : undefined;
      if (existing !== -1) {
        if (option !== undefined && samples[existing]!.option === undefined) {
          samples[existing] = { ...samples[existing]!, option };
        }
        continue;
      }
      add({ path, kind: sampleKind(path), label: image?.label, caption: image?.caption, option });
    }
  });
  const bound = bindToOptions(samples, input.options);
  return [
    ...bound
      .filter((sample) => sample.option !== undefined)
      .toSorted((left, right) => left.option! - right.option!),
    ...bound.filter((sample) => sample.option === undefined),
  ];
}

const LEADING_VERB = /^(?:approve|choose|pick|use|keep|go with)\s+/i;

/** "2 · Warm grade" for a bound sample; the label or file name otherwise. */
export function sampleDisplayLabel(
  sample: QuestionSample,
  options: SampleQuestionInput["options"],
): string {
  if (sample.option !== undefined) {
    const option = options[sample.option];
    if (option) {
      const text = stripSamplePaths(option.label).replace(LEADING_VERB, "");
      const label = text.charAt(0).toUpperCase() + text.slice(1);
      return `${sample.option + 1} · ${label || option.label}`;
    }
  }
  return sample.label ?? sample.path.split(/[\\/]/).at(-1) ?? sample.path;
}

/** Option text with the sample paths it names cut out. */
export function stripSamplePaths(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE, "")
    .replace(MEDIA_PATH, (match, path: string) => match.slice(0, match.length - path.length))
    .replace(/<\s*>/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The stage starts on the recommended option's sample, else the first sample. */
export function initialSampleIndex(
  samples: ReadonlyArray<QuestionSample>,
  options: SampleQuestionInput["options"],
): number {
  const recommended = options.findIndex((option) => /\(recommended\)/i.test(option.label));
  if (recommended === -1) return 0;
  const index = samples.findIndex((sample) => sample.option === recommended);
  return index === -1 ? 0 : index;
}

/** Spreads URLs fetched for the non-null resources back onto the full list. */
export function spreadResolvedUrls<T>(
  resolved: ReadonlyArray<T | null>,
  urls: ReadonlyArray<string | null>,
): Array<string | null> {
  const result: Array<string | null> = [];
  let next = 0;
  for (const entry of resolved) {
    if (entry === null) {
      result.push(null);
    } else {
      result.push(urls[next] ?? null);
      next += 1;
    }
  }
  return result;
}

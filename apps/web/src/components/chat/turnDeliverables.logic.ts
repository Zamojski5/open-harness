/**
 * Files a turn verifiably produced: successful writes, finished generation outputs, and the
 * `takes/`/`renders/`/`delivery/` paths its reply names. There is no explicit present tool.
 */

export type DeliverableKind = "image" | "video" | "audio" | "document" | "model" | "other";

const KINDS: Record<string, DeliverableKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  exr: "image",
  tif: "image",
  tiff: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  pdf: "document",
  docx: "document",
  pptx: "document",
  xlsx: "document",
  html: "document",
  md: "document",
  glb: "model",
  gltf: "model",
  usdz: "model",
  blend: "model",
};

function deliverableKind(path: string): DeliverableKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? null : (KINDS[extension] ?? null);
}

export interface Deliverable {
  readonly path: string;
  readonly kind: DeliverableKind;
}

const REPLY_PATH = new RegExp(
  String.raw`(?:^|[\s(\[<"'\x60])((?:~\/|\.{1,2}\/|\/)?(?:[\w@%+.,=-]+\/)*(?:takes|renders|outputs?|deliverables|delivery)\/(?:[\w@%+.,=-]+\/)*[\w@%+.,=-]+\.[a-z0-9]+)(?=$|[\s)\]>"'\x60,;:!?]|\.(?:\s|$))`,
  "gi",
);

/** `takes/…`, `renders/…` style paths named in the reply. */
export function replyDeliverablePaths(text: string): string[] {
  return Array.from(text.matchAll(REPLY_PATH), (match) => match[1]!);
}

/** The home folder behind a workspace root like /Users/me/… or /home/me/…, if it is one. */
function homeOf(workspaceRoot: string | undefined): string | null {
  return /^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/.exec(workspaceRoot ?? "")?.[1] ?? null;
}

/**
 * Workspace-relative inside the root, absolute otherwise; `~/` is expanded against the home the
 * workspace lives in, or dropped (null) when that home is unknown.
 */
function normalize(path: string, workspaceRoot: string | undefined): string | null {
  let trimmed = path.replace(/^\.\//, "");
  if (trimmed.startsWith("~/")) {
    const home = homeOf(workspaceRoot);
    if (home === null) return null;
    trimmed = `${home}/${trimmed.slice(2)}`;
  }
  const root = workspaceRoot?.replace(/\/+$/, "");
  if (root && trimmed.startsWith(`${root}/`)) return trimmed.slice(root.length + 1);
  return trimmed;
}

/** Folders whose files are build or test by-products, never deliverables. */
const INCIDENTAL_SEGMENT =
  /(^|\/)(__snapshots__|__screenshots__|node_modules|dist|build|coverage|\.git|\.cache|\.next|\.turbo|\.open-herness|tmp|test-results)(\/|$)/;
const DELIVERABLE_FOLDER = /(^|\/)(takes|renders|outputs?|deliverables|delivery|exports?)\//;

function isIncidental(path: string, kind: DeliverableKind): boolean {
  if (INCIDENTAL_SEGMENT.test(path)) return true;
  // An .html/.md write in a code project is source, not a deliverable, unless it sits in an output
  // folder (e.g. delivery/case-study/CASE.md).
  return /\.(html|md)$/.test(path) && kind === "document" && !DELIVERABLE_FOLDER.test(path);
}

/**
 * Deliverables of one turn, unique and in first-seen order: what it generated, what it wrote
 * (minus build/test by-products), and paths its reply names only when the turn also wrote or
 * generated them or one of its tool results names them. Files deleted in the turn are left out.
 */
export function collectTurnDeliverables(input: {
  readonly written: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  readonly generated: ReadonlyArray<string>;
  readonly replyText: string;
  /** Text of the turn's tool results, to confirm paths the reply names. */
  readonly toolOutputs?: ReadonlyArray<string>;
  readonly workspaceRoot: string | undefined;
}): Deliverable[] {
  const norm = (path: string) => normalize(path, input.workspaceRoot);
  const deleted = new Set(input.deleted.map(norm));
  const produced = new Set([...input.generated, ...input.written].map(norm));
  const toolText = (input.toolOutputs ?? []).join("\n");
  const confirmed = (raw: string, path: string) =>
    produced.has(path) ||
    [...produced].some((candidate) => candidate !== null && candidate.endsWith(`/${path}`)) ||
    toolText.includes(raw) ||
    toolText.includes(path);
  const seen = new Set<string>();
  const result: Deliverable[] = [];
  const add = (raw: string, fromReply: boolean) => {
    const path = norm(raw);
    if (path === null) return;
    const kind = deliverableKind(path);
    if (kind === null || seen.has(path) || deleted.has(path)) return;
    if (isIncidental(path, kind)) return;
    if (fromReply && !confirmed(raw, path)) return;
    seen.add(path);
    result.push({ path, kind });
  };
  for (const raw of input.generated) add(raw, false);
  for (const raw of input.written) add(raw, false);
  for (const raw of replyDeliverablePaths(input.replyText)) add(raw, true);
  return result;
}

/** Cards shown before "+N more". */
export const COLLAPSED_DELIVERABLE_COUNT = 4;

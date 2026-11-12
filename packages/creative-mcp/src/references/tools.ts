// Reference tools: find, collect and compare against visual references, the "look before you
// build, compare after you render" loop that keeps creative work grounded.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const run = promisify(execFile);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const abs = (p: string) => resolve(process.cwd(), p);
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

interface Hit {
  id: number;
  title: string;
  image: string;
  thumb?: string;
  page?: string;
  source: string;
}

// Search results by id, so reference_collect can take ids instead of long URLs. Ids are derived
// from the image URL and saved in the project, so an id always means the same image, even after a
// new search or in another server process.
const hits = new Map<number, Hit>();
const hitsFile = () => abs(join(".open-herness", "reference-hits.json"));

function hitId(image: string): number {
  let h = 0;
  for (const ch of image) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1000 + (h % 9000);
}

function rememberHits(list: Hit[]): void {
  let saved: Record<string, Hit> = {};
  try {
    saved = JSON.parse(readFileSync(hitsFile(), "utf8")) as Record<string, Hit>;
  } catch {
    // first search in this project
  }
  for (const h of list) saved[String(h.id)] = h;
  mkdirSync(abs(".open-herness"), { recursive: true });
  writeFileSync(hitsFile(), JSON.stringify(saved));
}

function lookupHit(id: number): Hit | undefined {
  if (hits.has(id)) return hits.get(id);
  try {
    return (JSON.parse(readFileSync(hitsFile(), "utf8")) as Record<string, Hit>)[String(id)];
  } catch {
    return undefined;
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function searchWeb(query: string, count: number): Promise<Omit<Hit, "id">[]> {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`image search HTTP ${res.status}`);
  const html = await res.text();
  const out: Omit<Hit, "id">[] = [];
  for (const match of html.matchAll(/\sm="(\{[^"]*?murl[^"]*?\})"/g)) {
    try {
      const m = JSON.parse(decodeEntities(match[1]!)) as { t?: string; murl?: string; turl?: string; purl?: string };
      if (m.murl) out.push({ title: m.t ?? "", image: m.murl, thumb: m.turl, page: m.purl, source: "web" });
    } catch {
      // skip malformed entries
    }
    if (out.length >= count) break;
  }
  return out;
}

async function searchCommons(query: string, count: number): Promise<Omit<Hit, "id">[]> {
  // Commons matches every word, so drop trailing words until something is found.
  const words = query.split(/\s+/).filter(Boolean);
  for (let n = words.length; n > 0; n--) {
    const found = await searchCommonsExact(words.slice(0, n).join(" "), count);
    if (found.length > 0 || n <= 1) return found;
  }
  return [];
}

async function searchCommonsExact(query: string, count: number): Promise<Omit<Hit, "id">[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&gsrnamespace=6&gsrlimit=${count}&prop=imageinfo&iiprop=url&iiurlwidth=1280&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": "OpenHerness/0.1 (creative references)" }, signal: AbortSignal.timeout(20_000) });
  const data = (await res.json()) as { query?: { pages?: Record<string, { title: string; index?: number; imageinfo?: { thumburl?: string; url: string; descriptionurl?: string }[] }> } };
  return Object.values(data.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p) => {
      const info = p.imageinfo?.[0];
      return info ? [{ title: p.title.replace(/^File:/, ""), image: info.thumburl ?? info.url, thumb: info.thumburl, page: info.descriptionurl, source: "wikimedia-commons" }] : [];
    });
}

async function download(url: string, dest: string): Promise<void> {
  const host = new URL(url).hostname;
  // Wikimedia rate-limits generic browser agents; it asks for a descriptive one.
  const agent = /(^|\.)wikimedia\.org$/.test(host) ? "OpenHerness/0.1 (creative references; https://github.com/pingdotgg/t3code)" : BROWSER_UA;
  const res = await fetch(url, { headers: { "User-Agent": agent, Referer: new URL(url).origin }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/") && !IMAGE_EXT.test(new URL(url).pathname)) throw new Error(`not an image (${type || "unknown type"})`);
  const raw = join(mkdtempSync(join(tmpdir(), "oh-ref-")), "src");
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
  try {
    // Normalise everything (webp, png, huge jpgs) to a jpg of at most 1600 px.
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-vf", "scale='min(1600,iw)':-2", "-frames:v", "1", "-q:v", "3", dest], { timeout: 60_000 });
  } finally {
    rmSync(raw, { force: true });
  }
}

/** Tiles images into one sheet (each fitted into a cell), returned as base64 jpg. */
async function contactSheet(paths: string[], cell = 360, columns = 4): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "oh-sheet-"));
  try {
    const h = Math.round((cell * 3) / 4);
    for (const [i, p] of paths.entries()) {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-i", p, "-vf", `scale=${cell}:${h}:force_original_aspect_ratio=decrease,pad=${cell}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x1c1c1c`, "-frames:v", "1", join(dir, `c${String(i).padStart(3, "0")}.png`)]);
    }
    const cols = Math.min(columns, paths.length);
    const sheet = join(dir, "sheet.jpg");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", join(dir, "c%03d.png"), "-vf", `tile=${cols}x${Math.ceil(paths.length / cols)}:padding=4:color=0x000000`, "-frames:v", "1", "-q:v", "4", sheet]);
    return readFileSync(sheet).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dominant colours of a set of images as hex codes. */
async function palette(paths: string[], colors = 8): Promise<string[]> {
  if (paths.length === 0) return [];
  const dir = mkdtempSync(join(tmpdir(), "oh-pal-"));
  try {
    const inputs = paths.flatMap((p) => ["-i", p]);
    const scaled = paths.map((_, i) => `[${i}:v]scale=200:150:force_original_aspect_ratio=decrease,pad=200:150:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba[s${i}]`).join(";");
    const stack = paths.length > 1 ? `${paths.map((_, i) => `[s${i}]`).join("")}hstack=inputs=${paths.length}[all]` : "[s0]copy[all]";
    const pal = join(dir, "pal.png");
    await run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${scaled};${stack};[all]palettegen=max_colors=${colors}:reserve_transparent=0:stats_mode=full`, "-frames:v", "1", pal]);
    const { stdout } = await run("ffmpeg", ["-loglevel", "error", "-i", pal, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 20 });
    const bytes = stdout as unknown as Buffer;
    const seen = new Set<string>();
    for (let i = 0; i + 2 < bytes.length; i += 3) {
      seen.add(`#${[bytes[i]!, bytes[i + 1]!, bytes[i + 2]!].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
    }
    return [...seen].slice(0, colors);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ref";
const boardDir = (board: string) => abs(join("references", slug(board)));
const boardImages = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => IMAGE_EXT.test(f)).sort().map((f) => join(dir, f)) : []);

interface Source {
  file: string;
  url: string;
  page?: string;
  title?: string;
  note?: string;
}

function readSources(dir: string): Source[] {
  try {
    return JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as Source[];
  } catch {
    return [];
  }
}

export function registerReferenceTools(server: McpServer) {
  server.registerTool(
    "reference_search",
    {
      description:
        "Image search for visual references (concept art, photos, real objects, lighting, materials, typography, layouts). Returns numbered hits and a contact sheet of thumbnails so you can pick the useful ones with reference_collect. Search several specific queries (e.g. 'witcher silver sword concept art', 'misty forest moonlight god rays photo', 'runic glyph engraving') rather than one vague one. source=web is broad; source=commons gives freely licensed Wikimedia photos.",
      inputSchema: {
        query: z.string(),
        count: z.number().int().min(1).max(24).optional(),
        source: z.enum(["web", "commons"]).optional(),
      },
    },
    async ({ query, count = 12, source = "web" }) => {
      try {
        let found = source === "commons" ? await searchCommons(query, count) : await searchWeb(query, count);
        if (found.length === 0 && source === "web") found = await searchCommons(query, count);
        if (found.length === 0) return text(`No images found for "${query}". Try other wording.`);
        const list = found.map((f) => {
          const hit = { ...f, id: hitId(f.image) };
          hits.set(hit.id, hit);
          return hit;
        });
        rememberHits(list);
        const lines = list.map((h) => `#${h.id} ${h.title.slice(0, 90)}${h.page ? ` — ${h.page}` : ""}`);
        // Thumbnails for a quick visual pick; failures are just left out.
        const dir = mkdtempSync(join(tmpdir(), "oh-thumbs-"));
        const thumbs: string[] = [];
        const order: number[] = [];
        await Promise.all(
          list.map(async (h, i) => {
            const dest = join(dir, `${String(i).padStart(3, "0")}.jpg`);
            try {
              await download(h.thumb ?? h.image, dest);
              thumbs[i] = dest;
            } catch {
              // ignore
            }
          }),
        );
        const shown = thumbs.flatMap((t, i) => (t ? [t] : []));
        list.forEach((h, i) => thumbs[i] && order.push(h.id));
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: `${list.length} results for "${query}":\n${lines.join("\n")}\n\nContact sheet (left to right, top to bottom): ${order.map((id) => `#${id}`).join(" ")}` },
        ];
        if (shown.length) content.push({ type: "image", data: await contactSheet(shown, 300, 4), mimeType: "image/jpeg" });
        rmSync(dir, { recursive: true, force: true });
        return { content };
      } catch (error) {
        return fail(`Search failed: ${error instanceof Error ? error.message : String(error)}. You can also find pages with WebSearch and pass image URLs to reference_collect.`);
      }
    },
  );

  server.registerTool(
    "reference_collect",
    {
      description:
        "Save chosen references into the project's moodboard folder ./references/<board>/ (normalised jpgs + sources.json for attribution). Pass hit ids from reference_search and/or direct image URLs or local files. Add a short note per reference saying what to take from it (shape, palette, lighting, composition). Returns the board.",
      inputSchema: {
        board: z.string().describe("Moodboard name, e.g. 'witcher-clearing'"),
        items: z
          .array(z.object({ id: z.number().int().optional(), url: z.string().optional(), note: z.string().optional() }))
          .min(1),
      },
    },
    async ({ board, items }) => {
      const dir = boardDir(board);
      mkdirSync(dir, { recursive: true });
      const sources = readSources(dir);
      const saved: string[] = [];
      const errors: string[] = [];
      let n = boardImages(dir).length;
      for (const item of items) {
        const hit = item.id !== undefined ? lookupHit(item.id) : undefined;
        const url = hit?.image ?? item.url;
        if (!url) {
          errors.push(`#${item.id ?? "?"}: unknown id (search again)`);
          continue;
        }
        n += 1;
        const file = `${String(n).padStart(2, "0")}-${slug(item.note ?? hit?.title ?? "ref")}.jpg`;
        const dest = join(dir, file);
        try {
          if (/^https?:/.test(url)) await download(url, dest);
          else await run("ffmpeg", ["-y", "-loglevel", "error", "-i", abs(url), "-vf", "scale='min(1600,iw)':-2", "-frames:v", "1", "-q:v", "3", dest]);
          sources.push({ file, url, page: hit?.page, title: hit?.title, note: item.note });
          saved.push(file);
        } catch (error) {
          n -= 1;
          // The full-size image can be blocked; fall back to the search thumbnail.
          if (hit?.thumb && hit.thumb !== url) {
            try {
              n += 1;
              await download(hit.thumb, dest);
              sources.push({ file, url: hit.thumb, page: hit.page, title: hit.title, note: item.note });
              saved.push(`${file} (thumbnail)`);
              continue;
            } catch {
              n -= 1;
            }
          }
          errors.push(`${hit ? `#${hit.id}` : url}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2));
      const images = boardImages(dir);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        { type: "text", text: `Board ${dir}: saved ${saved.length}${saved.length ? ` (${saved.join(", ")})` : ""}${errors.length ? `\nFailed: ${errors.join("; ")}` : ""}\n${images.length} references on the board. Next: reference_board for the palette, then write the style brief.` },
      ];
      if (images.length) content.push({ type: "image", data: await contactSheet(images), mimeType: "image/jpeg" });
      return { content };
    },
  );

  server.registerTool(
    "reference_board",
    {
      description:
        "Show a moodboard: all its references in one sheet, their notes, the dominant colour palette (hex) and the style brief (./references/<board>/brief.md) if written. Use it before building and whenever you need to re-anchor on the look. Without board, lists the boards in the project.",
      inputSchema: { board: z.string().optional() },
    },
    async ({ board }) => {
      if (!board) {
        const root = abs("references");
        const boards = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `${d.name} (${boardImages(join(root, d.name)).length} images)`) : [];
        return text(boards.length ? `Boards:\n${boards.join("\n")}` : "No moodboards yet. Start with reference_search.");
      }
      const dir = boardDir(board);
      const images = boardImages(dir);
      if (images.length === 0) return fail(`Board ${dir} is empty.`);
      const notes = readSources(dir).map((s) => `${s.file}${s.note ? `: ${s.note}` : ""}`);
      const colors = await palette(images).catch(() => []);
      const brief = existsSync(join(dir, "brief.md")) ? readFileSync(join(dir, "brief.md"), "utf8") : "(no brief.md yet: write one with palette, shapes/proportions, lighting, composition, mood, and what to avoid)";
      return {
        content: [
          { type: "text" as const, text: `Board ${dir}\nPalette: ${colors.join(" ")}\n\nReferences:\n${notes.join("\n")}\n\nBrief:\n${brief}` },
          { type: "image" as const, data: await contactSheet(images), mimeType: "image/jpeg" },
        ],
      };
    },
  );

  server.registerTool(
    "reference_compare",
    {
      description:
        "Critique step of the quality loop: puts your render/screenshot next to the references in one image, with both palettes. Then score it honestly 1-10 on silhouette/shapes, palette, lighting, composition and detail versus the references, name the 3 biggest differences, fix them and compare again. Stop when every score is 7+ or after 3-4 rounds, and tell the user what is still off.",
      inputSchema: {
        image: z.string().describe("Your render or screenshot (path)"),
        board: z.string().optional().describe("Moodboard to compare against"),
        references: z.array(z.string()).optional().describe("Specific reference files instead of (or in addition to) the whole board"),
      },
    },
    async ({ image, board, references = [] }) => {
      try {
        const render = abs(image);
        if (!existsSync(render)) return fail(`No image at ${render}`);
        const refs = [...(board ? boardImages(boardDir(board)) : []), ...references.map(abs)].slice(0, 6);
        if (refs.length === 0) return fail("Nothing to compare against: pass board or references.");
        const dir = mkdtempSync(join(tmpdir(), "oh-cmp-"));
        try {
          // Render large on the left, references in a 2-column grid on the right, same height.
          const H = 900;
          const cols = refs.length > 3 ? 2 : 1;
          const rows = Math.ceil(refs.length / cols);
          const cellH = Math.floor(H / rows);
          const cellW = Math.round((cellH * 4) / 3);
          const inputs = [render, ...refs].flatMap((p) => ["-i", p]);
          const cells = refs.map((_, i) => `[${i + 1}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=0x1c1c1c,setsar=1[r${i}]`);
          const filled = [...refs.keys()].map((i) => `[r${i}]`);
          // Pad the grid with blank cells so xstack gets a full rectangle.
          for (let i = refs.length; i < rows * cols; i++) {
            cells.push(`color=c=0x1c1c1c:s=${cellW}x${cellH}:d=1[e${i}]`);
            filled.push(`[e${i}]`);
          }
          const layout = filled.map((_, i) => `${(i % cols) * cellW}_${Math.floor(i / cols) * cellH}`).join("|");
          const grid = filled.length > 1 ? `${filled.join("")}xstack=inputs=${filled.length}:layout=${layout}[grid]` : `${filled[0]}copy[grid]`;
          const out = join(dir, "compare.jpg");
          await run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `[0:v]scale=-2:${rows * cellH},setsar=1[main];${cells.join(";")};${grid};[main][grid]hstack=inputs=2,pad=iw+0:ih+0[outv]`, "-map", "[outv]", "-frames:v", "1", "-q:v", "3", out], { timeout: 120_000 });
          const [mine, theirs] = await Promise.all([palette([render]).catch(() => []), palette(refs).catch(() => [])]);
          return {
            content: [
              { type: "text" as const, text: `Left: your image. Right: ${refs.length} references.\nYour palette: ${mine.join(" ")}\nReference palette: ${theirs.join(" ")}\nScore silhouette, palette, lighting, composition, detail (1-10 each), list the 3 biggest gaps, fix, compare again.` },
              { type: "image" as const, data: readFileSync(out).toString("base64"), mimeType: "image/jpeg" },
            ],
          };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error).slice(0, 4000));
      }
    },
  );
}

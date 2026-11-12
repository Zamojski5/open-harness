// Local rendering for the case study: HTML templates (OH's monochrome look: black/white, Inter +
// IBM Plex Mono), the same sandboxed headless Chrome brand_capture uses (temp profile, deleted
// after) for the PDF and the video cards, and ffmpeg for the video. No network, no generation.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { END_LINE, SPEC_LINE, type NumberCard } from "./present.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const CHROME =
  process.env.OH_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const hasChrome = () => NodeFS.existsSync(CHROME);
export function hasFfmpeg(): boolean {
  try {
    NodeChildProcess.execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inter from the web app's @fontsource package, embedded; else the installed font. */
function interFace(): string {
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const rel = "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2";
  for (const base of [
    NodePath.resolve(here, "../../../../apps/web"),
    NodePath.resolve(here, "../../../.."),
    NodePath.resolve(here, "../.."),
  ]) {
    const p = NodePath.join(base, rel);
    if (NodeFS.existsSync(p))
      return `@font-face{font-family:"OH Inter";font-weight:100 900;src:url(data:font/woff2;base64,${NodeFS.readFileSync(p).toString("base64")}) format("woff2");}`;
  }
  return `@font-face{font-family:"OH Inter";src:local("Inter"),local("Inter Regular");}`;
}

const BASE_CSS = () => `
${interFace()}
*{box-sizing:border-box;margin:0;padding:0}
:root{--ink:#0a0a0a;--paper:#ffffff;--mute:#6b6b6b;--line:#e4e4e4;
--sans:"OH Inter","Inter",-apple-system,"Helvetica Neue",Arial,sans-serif;
--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
html,body{background:var(--paper);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased}
.mono{font-family:var(--mono)}
`;

export interface PageInput {
  title: string;
  brief: string;
  cards: NumberCard[];
  deliverables: string[];
  methodNotes: string[];
  beforeAfter?: string | undefined;
  spec?: boolean | undefined;
  confidential?: boolean | undefined;
  dateLine: string;
}

/** One A4 page: title + brief, a grid of big numbers with small method notes, deliverables. */
export function pageHtml(p: PageInput): string {
  const cards = p.cards.slice(0, 8);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.title)}</title><style>
${BASE_CSS()}
@page{size:A4;margin:0}
body{width:210mm;height:297mm;overflow:hidden;padding:16mm 15mm 12mm;display:flex;flex-direction:column}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid var(--ink);padding-bottom:4mm}
.kicker{font-family:var(--mono);font-size:8pt;letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
h1{font-size:26pt;font-weight:700;letter-spacing:-.02em;line-height:1.05;margin-top:6mm}
.brief{font-size:10pt;line-height:1.45;margin-top:3mm;color:#262626;max-height:30mm;overflow:hidden}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:7mm;border-top:1px solid var(--line)}
.card{padding:4.5mm 0 4mm;border-bottom:1px solid var(--line)}
.card:nth-child(odd){padding-right:6mm;border-right:1px solid var(--line)}
.card:nth-child(even){padding-left:6mm}
.big{font-size:30pt;font-weight:700;letter-spacing:-.03em;line-height:1}
.big.nr{font-size:16pt;color:var(--mute);font-weight:500}
.label{font-size:9.5pt;font-weight:600;margin-top:1.5mm}
.note{font-family:var(--mono);font-size:6.5pt;line-height:1.35;color:var(--mute);margin-top:1.2mm}
.ba{margin-top:5mm;max-height:52mm;overflow:hidden}
.ba img{width:100%;max-height:52mm;object-fit:contain;object-position:left;filter:grayscale(0)}
.bottom{margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:6mm;padding-top:4mm}
h2{font-family:var(--mono);font-size:7pt;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin-bottom:1.5mm}
ul{list-style:none;font-size:8pt;line-height:1.4}
.method li{font-family:var(--mono);font-size:6pt;color:var(--mute);line-height:1.35}
footer{display:flex;justify-content:space-between;border-top:2px solid var(--ink);margin-top:4mm;padding-top:2.5mm;font-size:8pt}
footer b{font-weight:700}
.spec{font-family:var(--mono);font-size:7pt;margin-top:2mm}
</style></head><body>
<header><span class="kicker">Case study${p.confidential ? " · confidential" : ""}</span><span class="kicker">${esc(p.dateLine)}</span></header>
<h1>${esc(p.title)}</h1>
<p class="brief">${esc(p.brief)}</p>
${p.spec ? `<p class="spec">${esc(SPEC_LINE)}</p>` : ""}
<section class="grid">${cards
    .map(
      (c) =>
        `<div class="card"><div class="big${c.recorded ? "" : " nr"}">${esc(c.big)}</div><div class="label">${esc(c.label)}</div><div class="note">${esc(c.note)}</div></div>`,
    )
    .join("")}</section>
${p.beforeAfter ? `<div class="ba"><h2>Before → after</h2><img src="${esc(p.beforeAfter)}"></div>` : ""}
<section class="bottom">
<div><h2>Deliverables</h2><ul>${
    p.deliverables.length
      ? p.deliverables
          .slice(0, 6)
          .map((d) => `<li>${esc(d)}</li>`)
          .join("")
      : "<li>not recorded</li>"
  }</ul></div>
<div class="method"><h2>Method</h2><ul>${p.methodNotes.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>
</section>
<footer><span><b>${esc(END_LINE)}</b></span><span>Open Herness</span></footer>
</body></html>`;
}

export type CardKind = "title" | "number" | "moment" | "end" | "label";
export interface VideoCard {
  kind: CardKind;
  big?: string | undefined;
  label?: string | undefined;
  note?: string | undefined;
  kicker?: string | undefined;
  dark?: boolean | undefined;
}

/** A full-frame video card (1080×1350 or 1920×1080). */
export function cardHtml(c: VideoCard, w: number, h: number): string {
  const s = Math.min(w, h) / 1080;
  const bg = c.dark ? "#0a0a0a" : "#ffffff";
  const fg = c.dark ? "#ffffff" : "#0a0a0a";
  const mute = c.dark ? "#8a8a8a" : "#6b6b6b";
  const bigSize =
    c.kind === "end" ? 92 : c.kind === "title" ? 96 : (c.big?.length ?? 0) > 9 ? 150 : 200;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${BASE_CSS()}
html,body{width:${w}px;height:${h}px;overflow:hidden;background:${bg};color:${fg}}
body{padding:${90 * s}px;display:flex;flex-direction:column;justify-content:${c.kind === "end" ? "center" : "space-between"}}
.kicker{font-family:var(--mono);font-size:${26 * s}px;letter-spacing:.08em;text-transform:uppercase;color:${mute}}
.big{font-size:${bigSize * s}px;font-weight:700;letter-spacing:-.04em;line-height:.95}
.label{font-size:${44 * s}px;font-weight:600;margin-top:${28 * s}px;line-height:1.15;max-width:90%}
.note{font-family:var(--mono);font-size:${22 * s}px;color:${mute};margin-top:${24 * s}px;line-height:1.4;max-width:88%}
.rule{height:${4 * s}px;background:${fg};width:100%}
.brand{font-size:${34 * s}px;font-weight:700;margin-top:${48 * s}px}
</style></head><body>
${c.kind === "end" ? "" : `<div><div class="kicker">${esc(c.kicker ?? "")}</div></div>`}
<div>${c.big ? `<div class="big">${esc(c.big)}</div>` : ""}${c.label ? `<div class="label">${esc(c.label)}</div>` : ""}${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}${c.kind === "end" ? `<div class="brand">Open Herness</div>` : ""}</div>
${c.kind === "end" ? "" : `<div><div class="rule"></div></div>`}
</body></html>`;
}

const chromeArgs = (profile: string) => [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--mute-audio",
  "--disable-extensions",
  "--disable-background-networking",
  "--allow-file-access-from-files",
  `--user-data-dir=${profile}`,
];

async function withProfile<T>(fn: (profile: string) => Promise<T>): Promise<T> {
  const profile = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-chrome-"));
  try {
    return await fn(profile);
  } finally {
    NodeFS.rmSync(profile, { recursive: true, force: true });
  }
}

export async function htmlToPdf(htmlFile: string, out: string): Promise<void> {
  if (!hasChrome()) throw new Error("Google Chrome not installed; no PDF.");
  await withProfile((profile) =>
    execFile(
      CHROME,
      [
        ...chromeArgs(profile),
        "--no-pdf-header-footer",
        "--virtual-time-budget=4000",
        `--print-to-pdf=${out}`,
        NodeURL.pathToFileURL(htmlFile).href,
      ],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  if (!NodeFS.existsSync(out)) throw new Error("Chrome ran but wrote no PDF.");
}

export async function htmlToPng(htmlFile: string, out: string, w: number, h: number) {
  if (!hasChrome()) throw new Error("Google Chrome not installed; no card images.");
  await withProfile((profile) =>
    execFile(
      CHROME,
      [
        ...chromeArgs(profile),
        `--window-size=${w},${h}`,
        "--virtual-time-budget=3000",
        `--screenshot=${out}`,
        NodeURL.pathToFileURL(htmlFile).href,
      ],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  if (!NodeFS.existsSync(out)) throw new Error("Chrome ran but wrote no screenshot.");
}

/** PDF page count (counts /Type /Page objects; enough to check "one page"). */
export function pdfPages(file: string): number {
  const text = NodeFS.readFileSync(file).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

// Video

export type Segment =
  | {
      type: "image";
      file: string;
      seconds: number;
      blur?: boolean | undefined;
      fit?: "cover" | "contain" | undefined;
    }
  | { type: "frames"; files: string[]; seconds: number; blur?: boolean | undefined };

export const VIDEO_MIN = 45;
export const VIDEO_MAX = 60;

/**
 * Fit segment lengths into [min, max] seconds: stretch everything proportionally when short,
 * shrink when long. Pure (tested).
 */
export function fitDurations(seconds: number[], min = VIDEO_MIN, max = VIDEO_MAX): number[] {
  const total = seconds.reduce((s, x) => s + x, 0);
  if (!total) return seconds;
  const target = total < min ? min : total > max ? max : total;
  const k = target / total;
  const out = seconds.map((s) => Math.round(s * k * 100) / 100);
  // rounding drift goes to the last segment
  const drift = Math.round((target - out.reduce((s, x) => s + x, 0)) * 100) / 100;
  out[out.length - 1] = Math.round((out.at(-1)! + drift) * 100) / 100;
  return out;
}

const FPS = 30;

async function ff(args: string[]) {
  await execFile("ffmpeg", ["-y", "-v", "error", ...args], {
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function scaleFilter(w: number, h: number, fit: "cover" | "contain", blur?: boolean) {
  const base =
    fit === "cover"
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0a`;
  return `${base}${blur ? `,gblur=sigma=${Math.max(2, Math.round(Math.min(w, h) / 30))}` : ""},setsar=1,format=yuv420p`;
}

/** Render segments to one H.264 MP4 (silent unless `music` is a local audio file). */
export async function renderVideo(
  segments: Segment[],
  out: string,
  w: number,
  h: number,
  music?: string,
): Promise<{ seconds: number }> {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-case-vid-"));
  try {
    const clips: string[] = [];
    for (const [i, seg] of segments.entries()) {
      const clip = NodePath.join(tmp, `s${String(i).padStart(3, "0")}.mp4`);
      const fade = Math.min(0.35, seg.seconds / 4);
      const fades = `fade=t=in:st=0:d=${fade},fade=t=out:st=${(seg.seconds - fade).toFixed(2)}:d=${fade}`;
      if (seg.type === "image") {
        await ff([
          "-loop",
          "1",
          "-framerate",
          String(FPS),
          "-t",
          seg.seconds.toFixed(2),
          "-i",
          seg.file,
          "-vf",
          `${scaleFilter(w, h, seg.fit ?? "contain", seg.blur)},${fades}`,
          "-r",
          String(FPS),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          clip,
        ]);
      } else {
        const list = NodePath.join(tmp, `f${i}.txt`);
        const per = seg.seconds / seg.files.length;
        NodeFS.writeFileSync(
          list,
          `${seg.files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration ${per.toFixed(4)}`).join("\n")}\nfile '${seg.files.at(-1)!.replace(/'/g, "'\\''")}'\n`,
        );
        await ff([
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-vf",
          `${scaleFilter(w, h, "contain", seg.blur)},fps=${FPS},${fades}`,
          "-t",
          seg.seconds.toFixed(2),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "20",
          "-pix_fmt",
          "yuv420p",
          clip,
        ]);
      }
      clips.push(clip);
    }
    const list = NodePath.join(tmp, "clips.txt");
    NodeFS.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n"));
    const total = segments.reduce((s, x) => s + x.seconds, 0);
    if (music && NodeFS.existsSync(music))
      await ff([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-i",
        music,
        "-filter_complex",
        `[1:a]atrim=0:${total.toFixed(2)},afade=t=out:st=${Math.max(0, total - 2).toFixed(2)}:d=2[a]`,
        "-map",
        "0:v",
        "-map",
        "[a]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        out,
      ]);
    else
      await ff([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        "-an",
        "-movflags",
        "+faststart",
        out,
      ]);
    return { seconds: Math.round(total * 100) / 100 };
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Side-by-side (or stacked for portrait) before/after still from two take files (image or video). */
export async function beforeAfterImage(a: string, b: string, out: string): Promise<void> {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-case-ba-"));
  try {
    const grab = async (src: string, dst: string) => {
      const still = /\.(png|jpe?g|webp|tiff?)$/i.test(src);
      let at = 0;
      if (!still) {
        try {
          const { stdout } = await execFile("ffprobe", [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            src,
          ]);
          at = Math.max(0, Number(stdout.trim()) / 2) || 0;
        } catch {
          at = 0;
        }
      }
      await ff([
        ...(still ? [] : ["-ss", at.toFixed(2)]),
        "-i",
        src,
        "-frames:v",
        "1",
        "-vf",
        "scale=960:960:force_original_aspect_ratio=decrease,pad=960:960:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0a",
        dst,
      ]);
    };
    await grab(a, NodePath.join(tmp, "a.png"));
    await grab(b, NodePath.join(tmp, "b.png"));
    await ff([
      "-i",
      NodePath.join(tmp, "a.png"),
      "-i",
      NodePath.join(tmp, "b.png"),
      "-filter_complex",
      "[0:v][1:v]hstack=inputs=2,pad=iw+24:ih+24:12:12:color=white",
      "-frames:v",
      "1",
      "-q:v",
      "3",
      out,
    ]);
  } finally {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  }
}

export function probeVideo(
  file: string,
): { width: number; height: number; seconds: number } | undefined {
  try {
    const out = NodeChildProcess.execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8" },
    );
    const j = JSON.parse(out) as {
      streams: { width: number; height: number }[];
      format: { duration: string };
    };
    return {
      width: j.streams[0]!.width,
      height: j.streams[0]!.height,
      seconds: Number(j.format.duration),
    };
  } catch {
    return undefined;
  }
}

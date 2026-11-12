#!/usr/bin/env node
// Figma local decoder CLI. JSON on stdout; errors as one line `error: <message>` on stderr, exit 1.
//
//   decode  INPUT --out DIR [--images referenced|all|none]
//   outline DIR [--depth N] [--page NAME] [--node ID] [--max-lines N]
//   svg     DIR NODE_ID [--out FILE.svg] [--pad PX] [--scale N] [--include-hidden] [--link-images]

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { decodeToDir, loadDecodedDir, type ImagesMode } from "./decode/decode.ts";
import { buildOutline } from "./decode/outline.ts";
import { validNodeId } from "./link.ts";
import { renderSvg } from "./svg/render.ts";

const USAGE = `usage:
  decode  INPUT --out DIR [--images referenced|all|none]
  outline DIR [--depth N] [--page NAME] [--node ID] [--max-lines N]
  svg     DIR NODE_ID [--out FILE.svg] [--pad PX] [--scale N] [--include-hidden] [--link-images]`;

const FLAGS = new Set(["--include-hidden", "--link-images"]);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (FLAGS.has(a)) opt[a] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new Error(`${a} needs a value`);
        opt[a] = v;
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

const numOpt = (v: string | true | undefined, name: string, min: number) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min}`);
  return n;
};

export function run(argv: string[]): { stdout: string } {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  if (cmd === "decode") {
    if (!pos[0] || typeof opt["--out"] !== "string")
      throw new Error("decode needs INPUT and --out DIR");
    const images = (opt["--images"] ?? "referenced") as ImagesMode;
    if (!["referenced", "all", "none"].includes(images))
      throw new Error("--images must be referenced, all or none");
    if (!NodeFS.existsSync(pos[0])) throw new Error(`no such file: ${pos[0]}`);
    return { stdout: JSON.stringify(decodeToDir(pos[0], { out: opt["--out"], images })) };
  }
  if (cmd === "outline") {
    if (!pos[0]) throw new Error("outline needs DIR");
    const node =
      typeof opt["--node"] === "string" ? (validNodeId(opt["--node"]) ?? opt["--node"]) : undefined;
    const text = buildOutline(loadDecodedDir(pos[0]), {
      depth: numOpt(opt["--depth"], "--depth", 1),
      page: typeof opt["--page"] === "string" ? opt["--page"] : undefined,
      node,
      maxLines: numOpt(opt["--max-lines"], "--max-lines", 1),
    });
    return { stdout: text.trimEnd() };
  }
  if (cmd === "svg") {
    if (!pos[0] || !pos[1]) throw new Error("svg needs DIR and NODE_ID");
    const id = validNodeId(pos[1]);
    if (!id) throw new Error(`no node ${pos[1]}; ids look like N:M (see outline.txt)`);
    const result = renderSvg(pos[0], id, {
      out: typeof opt["--out"] === "string" ? NodePath.resolve(opt["--out"]) : undefined,
      pad: numOpt(opt["--pad"], "--pad", 0),
      scale: numOpt(opt["--scale"], "--scale", 0.01),
      includeHidden: opt["--include-hidden"] === true,
      linkImages: opt["--link-images"] === true,
    });
    return { stdout: JSON.stringify(result) };
  }
  throw new Error(USAGE);
}

const isMain =
  process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  try {
    process.stdout.write(`${run(argv).stdout}\n`);
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message.split("\n")[0]}\n`);
    process.exit(1);
  }
}

// @effect-diagnostics nodeBuiltinImport:off -- Small synchronous file housekeeping called from the recorder's timer callback, outside any Effect fiber.
// Process frames for case studies: <project>/.open-herness/process-frames/<epoch-ms>.jpg. Over the
// disk cap the oldest half of the frames is thinned (every second one deleted), repeated until the
// folder fits, so a long project keeps an even timelapse and recording never stops for space.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const DEFAULT_CAP_BYTES = 500 * 1024 * 1024;
export const FRAME_WIDTH = 1280;
const FRAME_PATTERN = /^\d{10,}\.jpe?g$/;

export interface FrameFile {
  name: string;
  bytes: number;
}

export const framesDir = (cwd: string) => NodePath.join(cwd, ".open-herness", "process-frames");

/**
 * Which frames to delete so the total fits under `capBytes`: delete every second frame of the
 * oldest half (keeping the very first), and repeat on what is left. Frames are sorted by name
 * (epoch ms). Never deletes the newest frame. Pure.
 */
export function planThinning(frames: readonly FrameFile[], capBytes: number): string[] {
  let kept = [...frames].sort((a, b) => a.name.localeCompare(b.name));
  let total = kept.reduce((s, f) => s + f.bytes, 0);
  const removed: string[] = [];
  while (total > capBytes && kept.length > 2) {
    const half = Math.max(2, Math.ceil(kept.length / 2));
    const old = kept.slice(0, half);
    const drop = old.filter((_, i) => i % 2 === 1);
    if (!drop.length) break;
    const dropSet = new Set(drop.map((f) => f.name));
    for (const f of drop) {
      removed.push(f.name);
      total -= f.bytes;
    }
    kept = kept.filter((f) => !dropSet.has(f.name));
  }
  // still over (e.g. two huge frames): drop oldest ones, never the newest
  while (total > capBytes && kept.length > 1) {
    const f = kept.shift()!;
    removed.push(f.name);
    total -= f.bytes;
  }
  return removed;
}

export function listFrames(dir: string): FrameFile[] {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((n) => FRAME_PATTERN.test(n));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      return [{ name, bytes: NodeFS.statSync(NodePath.join(dir, name)).size }];
    } catch {
      return [];
    }
  });
}

/** Write one JPEG frame and thin the folder to the cap; returns the folder's state after. */
export function storeFrame(
  cwd: string,
  jpeg: Uint8Array,
  at: number,
  capBytes = DEFAULT_CAP_BYTES,
): { frames: number; bytes: number; removed: number } {
  const dir = framesDir(cwd);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${at}.jpg`), jpeg);
  const frames = listFrames(dir);
  const removed = planThinning(frames, capBytes);
  for (const name of removed) NodeFS.rmSync(NodePath.join(dir, name), { force: true });
  const gone = new Set(removed);
  const left = frames.filter((f) => !gone.has(f.name));
  return {
    frames: left.length,
    bytes: left.reduce((s, f) => s + f.bytes, 0),
    removed: removed.length,
  };
}

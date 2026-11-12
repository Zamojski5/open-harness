// @effect-diagnostics nodeBuiltinImport:off -- The test inspects real frame files on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { framesDir, listFrames, planThinning, storeFrame } from "./FrameStore.ts";
import { ProcessRecorder, type CapturableWindow } from "./ProcessRecorder.ts";

const frames = (n: number, bytes = 10) =>
  Array.from({ length: n }, (_, i) => ({ name: `${1_762_000_000_000 + i * 10_000}.jpg`, bytes }));

describe("process frame store", () => {
  it("under the cap nothing is deleted", () => {
    expect(planThinning(frames(10), 100)).toEqual([]);
  });

  it("over the cap thins every second frame of the oldest half, keeps first and newest", () => {
    const list = frames(10); // 100 bytes
    const removed = planThinning(list, 90);
    expect(removed).toEqual([list[1]!.name, list[3]!.name]);
    expect(removed).not.toContain(list[0]!.name);
    expect(removed).not.toContain(list[9]!.name);
  });

  it("repeats thinning until it fits, and never removes the newest frame", () => {
    const list = frames(40);
    const removed = planThinning(list, 120);
    const left = list.filter((f) => !removed.includes(f.name));
    expect(left.reduce((s, f) => s + f.bytes, 0)).toBeLessThanOrEqual(120);
    expect(left.at(-1)!.name).toBe(list.at(-1)!.name);
    expect(left[0]!.name).toBe(list[0]!.name);
    expect(planThinning([{ name: "1762000000000.jpg", bytes: 999 }], 10)).toEqual([]);
  });

  it("storeFrame writes <epoch>.jpg and enforces the cap on disk", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-frames-"));
    for (let i = 0; i < 12; i++)
      storeFrame(cwd, new Uint8Array(100), 1_762_000_000_000 + i * 1000, 800);
    const left = listFrames(framesDir(cwd));
    expect(left.reduce((s, f) => s + f.bytes, 0)).toBeLessThanOrEqual(800);
    expect(left.some((f) => f.name === "1762000011000.jpg")).toBe(true);
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  });

  it("the recorder captures only the window it is given, resized to 1280 px wide", async () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-rec-"));
    const resized: number[] = [];
    const win: CapturableWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: async () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 2560, height: 1600 }),
          resize: ({ width }) => {
            resized.push(width);
            return { toJPEG: () => new Uint8Array([1, 2, 3]) };
          },
          toJPEG: () => new Uint8Array([9]),
        }),
      },
    };
    const states: boolean[] = [];
    const rec = new ProcessRecorder(
      () => win,
      (s) => states.push(s.recording),
    );
    rec.start(cwd, 3600);
    // start() takes a first frame at once; let it finish before the explicit tick
    await rec.settled();
    expect(rec.current.frames).toBe(1);
    await rec.tick(1_762_000_123_000);
    rec.stop();
    expect(resized).toContain(1280);
    expect(NodeFS.existsSync(NodePath.join(framesDir(cwd), "1762000123000.jpg"))).toBe(true);
    expect(rec.current.recording).toBe(false);
    expect(states.at(-1)).toBe(false);
    expect(await rec.tick()).toBe(false);
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  });

  it("captures only the main pane, and nothing while another project is on screen", async () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-rec-"));
    let onScreen: string | null = "/elsewhere";
    const rects: unknown[] = [];
    const win: CapturableWindow = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => ({
          project: onScreen,
          pane: { x: 280.4, y: 0, width: 1000, height: 800 },
        }),
        capturePage: async (rect) => {
          rects.push(rect);
          return {
            isEmpty: () => false,
            getSize: () => ({ width: 1000, height: 800 }),
            resize: () => ({ toJPEG: () => new Uint8Array([1]) }),
            toJPEG: () => new Uint8Array([2]),
          };
        },
      },
    };
    const rec = new ProcessRecorder(() => win);
    rec.start(cwd, 3600);
    await rec.settled();
    expect(rec.current.frames).toBe(0);
    expect(rects).toEqual([]);
    onScreen = cwd;
    expect(await rec.tick(1_762_000_200_000)).toBe(true);
    expect(rects).toEqual([{ x: 280, y: 0, width: 1000, height: 800 }]);
    rec.stop();
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  });

  it("drops a frame captured after recording was turned off, and stops when the window closes", async () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-rec-"));
    let destroyed = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const win: CapturableWindow = {
      isDestroyed: () => destroyed,
      webContents: {
        capturePage: async () => {
          await gate;
          return {
            isEmpty: () => false,
            getSize: () => ({ width: 800, height: 600 }),
            resize: () => ({ toJPEG: () => new Uint8Array([1]) }),
            toJPEG: () => new Uint8Array([2]),
          };
        },
      },
    };
    const rec = new ProcessRecorder(() => win);
    rec.start(cwd, 3600);
    rec.stop();
    release();
    expect(await rec.settled()).toBe(false);
    expect(listFrames(framesDir(cwd))).toEqual([]);
    rec.start(cwd, 3600);
    await rec.settled();
    destroyed = true;
    expect(await rec.tick()).toBe(false);
    expect(rec.current.recording).toBe(false);
    expect(rec.current.error).toMatch(/closed/);
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  });
});

// @effect-diagnostics globalTimers:off globalDate:off -- The capture timer runs at the Electron callback boundary, outside any Effect fiber.
// Records the process for case studies: captures ONLY this app's own window with
// webContents.capturePage() (no screen-recording permission, never other windows or the screen)
// every N seconds, resized to at most 1280 px wide JPEG, into the project's process-frames folder.
// Only the main pane is captured (the sidebar lists other projects and threads), and a frame is
// skipped while the renderer shows another project than the one being recorded.

import type { DesktopProcessRecordingState } from "@t3tools/contracts";
import { DEFAULT_CAP_BYTES, FRAME_WIDTH, framesDir, listFrames, storeFrame } from "./FrameStore.ts";

/** The part of a BrowserWindow the recorder needs (so tests can pass a fake). */
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturableWindow {
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  webContents: {
    /** absent in tests: then the whole page is captured and no project check is made */
    executeJavaScript?(code: string): Promise<unknown>;
    capturePage(rect?: CaptureRect): Promise<{
      isEmpty(): boolean;
      getSize(): { width: number; height: number };
      resize(options: { width: number; quality?: "good" | "better" | "best" }): {
        toJPEG(quality: number): Uint8Array;
      };
      toJPEG(quality: number): Uint8Array;
    }>;
  };
}

const DEFAULT_INTERVAL_SECONDS = 10;

/** What the renderer shows: the project on screen and the main pane (sidebar excluded). */
const VIEW_PROBE = `(() => {
  const main = document.querySelector('main[data-slot="sidebar-inset"]');
  const r = main ? main.getBoundingClientRect() : null;
  return {
    project: document.documentElement.dataset.ohActiveProject ?? null,
    pane: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null,
  };
})()`;

type View = { project: string | null; pane: CaptureRect | null };

const asView = (value: unknown): View | undefined => {
  const v = value as View | null;
  return v && typeof v === "object" && "project" in v ? v : undefined;
};
const MIN_INTERVAL_SECONDS = 2;

export class ProcessRecorder {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private pending: Promise<boolean> = Promise.resolve(false);
  private state: DesktopProcessRecordingState = {
    recording: false,
    cwd: null,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    frames: 0,
    bytes: 0,
    capBytes: DEFAULT_CAP_BYTES,
    lastFrameAt: null,
    error: null,
  };

  private readonly window: () => CapturableWindow | undefined;
  private readonly onState: (state: DesktopProcessRecordingState) => void;
  private readonly capBytes: number;

  constructor(
    window: () => CapturableWindow | undefined,
    onState: (state: DesktopProcessRecordingState) => void = () => {},
    capBytes = DEFAULT_CAP_BYTES,
  ) {
    this.window = window;
    this.onState = onState;
    this.capBytes = capBytes;
    this.state = { ...this.state, capBytes };
  }

  get current(): DesktopProcessRecordingState {
    return this.state;
  }

  private publish(patch: Partial<DesktopProcessRecordingState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  start(cwd: string, intervalSeconds = DEFAULT_INTERVAL_SECONDS): DesktopProcessRecordingState {
    this.stop(false);
    const seconds = Math.max(MIN_INTERVAL_SECONDS, Math.round(intervalSeconds));
    const existing = listFrames(framesDir(cwd));
    this.publish({
      recording: true,
      cwd,
      intervalSeconds: seconds,
      frames: existing.length,
      bytes: existing.reduce((s, f) => s + f.bytes, 0),
      error: null,
    });
    this.pending = this.tick();
    this.timer = setInterval(() => {
      this.pending = this.tick();
    }, seconds * 1000);
    return this.state;
  }

  /** Resolves when the capture in flight (if any) has finished. */
  settled(): Promise<boolean> {
    return this.pending;
  }

  stop(publish = true): DesktopProcessRecordingState {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (publish && this.state.recording) this.publish({ recording: false });
    else this.state = { ...this.state, recording: false };
    return this.state;
  }

  /** One capture; skipped while the previous one runs or the window is gone/minimised. */
  async tick(now = Date.now()): Promise<boolean> {
    const cwd = this.state.cwd;
    if (!this.state.recording || !cwd || this.busy) return false;
    const win = this.window();
    if (!win || win.isDestroyed()) {
      // the recorded window is gone: stop instead of claiming to record forever
      this.stop(false);
      this.publish({ recording: false, error: "The recorded window was closed." });
      return false;
    }
    if (win.isMinimized?.()) return false;
    this.busy = true;
    try {
      let rect: CaptureRect | undefined;
      if (win.webContents.executeJavaScript) {
        const view = asView(await win.webContents.executeJavaScript(VIEW_PROBE));
        // another project (or none) on screen, or no main pane to crop to: no frame
        if (!view || view.project !== cwd || !view.pane) return false;
        const p = view.pane;
        rect = {
          x: Math.max(0, Math.round(p.x)),
          y: Math.max(0, Math.round(p.y)),
          width: Math.round(p.width),
          height: Math.round(p.height),
        };
        if (rect.width < 16 || rect.height < 16) return false;
      }
      const image = await (rect
        ? win.webContents.capturePage(rect)
        : win.webContents.capturePage());
      if (image.isEmpty()) return false;
      // turned off or switched project while the capture ran: drop the frame
      if (!this.state.recording || this.state.cwd !== cwd) return false;
      const { width } = image.getSize();
      const jpeg =
        width > FRAME_WIDTH
          ? image.resize({ width: FRAME_WIDTH, quality: "good" }).toJPEG(70)
          : image.toJPEG(70);
      const stored = storeFrame(cwd, jpeg, now, this.capBytes);
      this.publish({ frames: stored.frames, bytes: stored.bytes, lastFrameAt: now, error: null });
      return true;
    } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      this.busy = false;
    }
  }
}

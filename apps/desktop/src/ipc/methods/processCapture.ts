import {
  DesktopProcessRecordingRequestSchema,
  DesktopProcessRecordingStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { ProcessRecorder, type CapturableWindow } from "../../processCapture/ProcessRecorder.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

// One recorder per app: it follows the window that turned it on (the app's own window only).
let target: CapturableWindow | undefined;
let notify: ((state: unknown) => void) | undefined;
const recorder = new ProcessRecorder(
  () => target,
  (state) => notify?.(state),
);

export const setProcessRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_PROCESS_RECORDING_CHANNEL,
  payload: DesktopProcessRecordingRequestSchema,
  result: DesktopProcessRecordingStateSchema,
  handler: Effect.fn("desktop.ipc.processCapture.set")(function* (request) {
    if (!request.enabled) return recorder.stop();
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) return { ...recorder.current, error: "No app window to record." };
    const win = window.value;
    target = win;
    notify = (state) => {
      if (!win.isDestroyed())
        win.webContents.send(IpcChannels.PROCESS_RECORDING_STATE_CHANNEL, state);
    };
    return recorder.start(request.cwd, request.intervalSeconds);
  }),
});

export const getProcessRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_PROCESS_RECORDING_CHANNEL,
  payload: Schema.Void,
  result: DesktopProcessRecordingStateSchema,
  handler: Effect.fn("desktop.ipc.processCapture.get")(function* () {
    return recorder.current;
  }),
});

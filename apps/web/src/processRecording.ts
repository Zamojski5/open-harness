// Case-study process capture (desktop only): state of the main-process recorder that captures this
// app's own window into <project>/.open-herness/process-frames/, plus the case-study prompt.

import type { DesktopProcessRecordingState } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

let state: DesktopProcessRecordingState | null = null;
const listeners = new Set<() => void>();
let wired = false;

function emit(next: DesktopProcessRecordingState | null) {
  state = next;
  for (const listener of listeners) listener();
}

function wire() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (wired || !bridge?.getProcessRecording) return;
  wired = true;
  bridge.onProcessRecordingState(emit);
  void bridge.getProcessRecording().then(emit, () => {});
}

function subscribe(listener: () => void) {
  wire();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The recorder's state; null outside the desktop app or before it answered. */
export function useProcessRecording(): DesktopProcessRecordingState | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

export const processRecordingAvailable = () =>
  typeof window !== "undefined" && typeof window.desktopBridge?.setProcessRecording === "function";

export const isRecordingProject = (cwd: string) => state?.recording === true && state.cwd === cwd;

/** Start recording this project (stops any other), or stop when it is the one recording. */
export async function toggleProcessRecording(cwd: string): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge?.setProcessRecording) return;
  emit(await bridge.setProcessRecording({ cwd, enabled: !isRecordingProject(cwd) }));
}

export const CASE_STUDY_PROMPT =
  "Build a case study of this project with the case-study skill: ask me about confidentiality first (client names, relative numbers only, spec campaign, my own agency-time estimate if I want a comparison), then run case_study_build and show me the PDF, the video and the numbers with how each was measured.";

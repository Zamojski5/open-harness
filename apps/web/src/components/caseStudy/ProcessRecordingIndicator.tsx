import { useEffect } from "react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { toggleProcessRecording, useProcessRecording } from "../../processRecording";
import { useProjects } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Tells the desktop recorder which project is on screen (data-oh-active-project on <html>): it
 * pauses while another project is open, so one client's case study never shows another's work.
 */
function ActiveProjectMarker() {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const root = thread
    ? projects.find((p) => p.environmentId === thread.environmentId && p.id === thread.projectId)
        ?.workspaceRoot
    : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a DOM attribute the desktop recorder reads in step with the project on screen while mounted
  useEffect(() => {
    const el = document.documentElement;
    if (root) el.dataset.ohActiveProject = root;
    else delete el.dataset.ohActiveProject;
    return () => {
      delete el.dataset.ohActiveProject;
    };
  }, [root]);
  return null;
}

/** Visible while the app records its own window for a case study; click to stop. */
export function ProcessRecordingIndicator() {
  const recording = useProcessRecording();
  if (!recording?.recording || !recording.cwd) return null;
  const cwd = recording.cwd;
  const folder = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const pill = (
    <button
      type="button"
      aria-label={`Recording process of ${folder}. Click to stop.`}
      onClick={() => void toggleProcessRecording(cwd)}
      className="fixed right-3 bottom-3 z-50 flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 font-mono text-2xs text-foreground shadow-sm"
    >
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-destructive" />
      REC · {folder}
    </button>
  );
  return (
    <>
      <ActiveProjectMarker />
      <Tooltip>
        <TooltipTrigger render={pill} />
        <TooltipPopup side="top">
          Recording the main pane of this window (not the sidebar) every {recording.intervalSeconds}{" "}
          s into .open-herness/process-frames, paused while another project is open (
          {recording.frames} frames
          {recording.error ? `, last error: ${recording.error}` : ""}). Click to stop.
        </TooltipPopup>
      </Tooltip>
    </>
  );
}

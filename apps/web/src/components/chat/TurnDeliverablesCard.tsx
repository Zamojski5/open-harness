import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  BoxIcon,
  FileIcon,
  FileTextIcon,
  FolderOpenIcon,
  MusicIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import { useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";
import {
  COLLAPSED_DELIVERABLE_COUNT,
  type Deliverable,
  type DeliverableKind,
} from "./turnDeliverables.logic";
import { spreadResolvedUrls } from "./questionSamples";

const KIND_ICON: Record<DeliverableKind, typeof FileIcon> = {
  image: FileIcon,
  video: FileIcon,
  audio: MusicIcon,
  document: FileTextIcon,
  model: BoxIcon,
  other: FileIcon,
};

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function absolutePath(path: string, workspaceRoot: string | undefined): string {
  if (path.startsWith("/") || !workspaceRoot) return path;
  return `${workspaceRoot.replace(/\/+$/, "")}/${path}`;
}

type ActionState = "idle" | "opening" | "failed";

/**
 * The files the latest turn produced, at its end: a thumbnail for media, the name, and Open
 * (side panel), Open in app and Reveal. Folds after four.
 */
export function TurnDeliverablesCard(props: {
  readonly deliverables: ReadonlyArray<Deliverable>;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionState, setActionState] = useState<Record<string, ActionState>>({});
  const canOperate = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthOrchestrationOperateScope,
  );
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const shown = expanded
    ? props.deliverables
    : props.deliverables.slice(0, COLLAPSED_DELIVERABLE_COUNT);
  const media = shown.map((item) =>
    item.kind === "image" || item.kind === "video"
      ? resolveViewedImageAsset(item.path, {
          threadId: props.threadRef.threadId,
          workspaceRoot: props.workspaceRoot,
        })
      : null,
  );
  const urls = useAssetUrls(
    props.threadRef.environmentId,
    media.flatMap((asset) => (asset === null ? [] : [asset.resource])),
  );
  if (props.deliverables.length === 0) return null;
  const srcs = spreadResolvedUrls(media, urls);
  const external = async (path: string, reveal: boolean) => {
    const key = `${reveal ? "reveal" : "open"}:${path}`;
    setActionState((current) => ({ ...current, [key]: "opening" }));
    const result = await openInEditor({
      environmentId: props.threadRef.environmentId,
      input: {
        cwd: absolutePath(path, props.workspaceRoot),
        editor: "file-manager",
        ...(reveal ? { reveal: true } : {}),
      },
    });
    setActionState((current) => ({
      ...current,
      [key]: result._tag === "Failure" ? "failed" : "idle",
    }));
  };
  const label = (path: string, reveal: boolean, idle: string) => {
    const state = actionState[`${reveal ? "reveal" : "open"}:${path}`] ?? "idle";
    return state === "opening" ? "Opening…" : state === "failed" ? "Failed, retry" : idle;
  };
  const rest = props.deliverables.length - COLLAPSED_DELIVERABLE_COUNT;
  return (
    <div className="chat-content-lane pb-2" data-turn-deliverables>
      <div className="rounded-xl border border-border bg-card p-2">
        <p className="px-1 pb-1.5 text-xs text-muted-foreground">
          {props.deliverables.length === 1
            ? "1 file from this turn"
            : `${props.deliverables.length} files from this turn`}
        </p>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-1.5">
          {shown.map((item, index) => {
            const Icon = KIND_ICON[item.kind];
            const src = srcs[index] ?? null;
            return (
              <li
                key={item.path}
                className="group/deliverable flex min-w-0 flex-col overflow-hidden rounded-md border border-border"
              >
                <button
                  type="button"
                  aria-label={`Open ${fileName(item.path)} in the side panel`}
                  className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted/30"
                  onClick={() => useRightPanelStore.getState().openFile(props.threadRef, item.path)}
                >
                  {src !== null && item.kind === "image" ? (
                    <img src={src} alt="" className="size-full object-cover" draggable={false} />
                  ) : src !== null && item.kind === "video" ? (
                    <video
                      src={`${src}#t=1`}
                      muted
                      preload="metadata"
                      className="size-full object-cover"
                    />
                  ) : (
                    <Icon aria-hidden className="size-5 text-muted-foreground" />
                  )}
                </button>
                <div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
                  <span className="truncate text-xs text-foreground">{fileName(item.path)}</span>
                  <span className="truncate font-mono text-2xs text-muted-foreground">
                    {item.path}
                  </span>
                  {canOperate ? (
                    <span className="flex gap-2 pt-0.5 text-2xs">
                      <InlineButton tone="muted" onClick={() => void external(item.path, false)}>
                        <SquareArrowOutUpRightIcon aria-hidden className="size-3" />
                        {label(item.path, false, "Open in app")}
                      </InlineButton>
                      <InlineButton tone="muted" onClick={() => void external(item.path, true)}>
                        <FolderOpenIcon aria-hidden className="size-3" />
                        {label(item.path, true, "Reveal")}
                      </InlineButton>
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {rest > 0 ? (
          <InlineButton
            tone="muted"
            className="mt-1.5"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show fewer" : `All ${props.deliverables.length} files`}
          </InlineButton>
        ) : null}
      </div>
    </div>
  );
}

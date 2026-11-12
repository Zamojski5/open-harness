import type { ScopedThreadRef } from "@t3tools/contracts";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, ImageOffIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  sampleDisplayLabel,
  spreadResolvedUrls,
  type QuestionSample,
  type SampleQuestionInput,
} from "./questionSamples";

type SampleView = "reel" | "grid";

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function SampleMedia(props: {
  readonly sample: QuestionSample;
  readonly src: string | null;
  readonly variant: "stage" | "thumb";
}) {
  const { sample, src, variant } = props;
  if (src === null || sample.kind === "audio" || sample.kind === "other") {
    return (
      <span className="flex size-full items-center justify-center gap-1 overflow-hidden px-1 text-2xs text-muted-foreground">
        {src === null && sample.kind !== "audio" && sample.kind !== "other" ? (
          <ImageOffIcon aria-label="File unavailable" className="size-3.5 shrink-0" />
        ) : (
          <span className="truncate font-mono">{fileName(sample.path)}</span>
        )}
      </span>
    );
  }
  if (sample.kind === "video") {
    return variant === "stage" ? (
      <video
        src={src}
        controls
        preload="metadata"
        playsInline
        className="size-full object-contain"
      />
    ) : (
      <video src={`${src}#t=1`} muted preload="metadata" className="size-full object-cover" />
    );
  }
  return (
    <img
      src={src}
      alt={sample.label ?? fileName(sample.path)}
      className={cn("size-full", variant === "stage" ? "object-contain" : "object-cover")}
      draggable={false}
    />
  );
}

/**
 * Samples on a question card: a large stage with a filmstrip ("reel"), or a compare
 * grid. Thumbnails carry the option number, or a check once that option is picked. Selecting an
 * option moves the stage to its sample; moving through samples never selects anything.
 */
export function QuestionSamplesReel(props: {
  readonly samples: ReadonlyArray<QuestionSample>;
  readonly options: SampleQuestionInput["options"];
  readonly pickedOptions: ReadonlySet<number>;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
}) {
  const { samples, index } = props;
  const [view, setView] = useState<SampleView>("reel");
  const resolved = samples.map((sample) =>
    resolveViewedImageAsset(sample.path, {
      threadId: props.threadRef.threadId,
      workspaceRoot: props.workspaceRoot,
    }),
  );
  const urls = useAssetUrls(
    props.threadRef.environmentId,
    resolved.flatMap((asset) => (asset === null ? [] : [asset.resource])),
  );
  const srcs = spreadResolvedUrls(resolved, urls);
  const active = samples[index] ?? samples[0];
  if (!active) return null;
  const activeIndex = samples.indexOf(active);
  const step = (delta: number) =>
    props.onIndexChange((activeIndex + delta + samples.length) % samples.length);
  const openSample = (sample: QuestionSample) =>
    useRightPanelStore.getState().openFile(props.threadRef, sample.path);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (view !== "reel" || samples.length < 2) return;
    if (event.target instanceof HTMLMediaElement) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      step((event.key === "ArrowRight") !== rtl ? 1 : -1);
    }
  };
  const badge = (sample: QuestionSample) =>
    sample.option !== undefined && props.pickedOptions.has(sample.option) ? (
      <span className="absolute end-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <CheckIcon className="size-2.5" aria-label="Picked" />
      </span>
    ) : sample.option !== undefined && sample.option < 9 ? (
      <span className="absolute end-0.5 top-0.5">
        <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-sm bg-background/90 px-0.5 font-mono text-3xs text-foreground">
          {sample.option + 1}
        </span>
      </span>
    ) : null;
  const caption = active.caption;
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-question-samples={view} onKeyDown={onKeyDown}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-foreground">
          {sampleDisplayLabel(active, props.options)}
          {caption ? <span className="text-muted-foreground"> · {caption}</span> : null}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {activeIndex + 1} / {samples.length}
        </span>
        {samples.length > 1 ? (
          <span
            role="group"
            aria-label="Sample view"
            className="flex shrink-0 rounded-md border border-border p-0.5"
          >
            {(["reel", "grid"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setView(option)}
                className={cn(
                  "rounded-sm px-1.5 text-2xs",
                  view === option ? "bg-foreground text-background" : "text-muted-foreground",
                )}
              >
                {option === "reel" ? "Reel" : "Compare"}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {view === "reel" ? (
        <>
          <div
            className="relative overflow-hidden rounded-md border border-border bg-muted/30"
            style={{ height: "clamp(7rem, 24dvh, 15rem)" }}
          >
            <button
              type="button"
              aria-label={`Open ${fileName(active.path)}`}
              className="flex size-full items-center justify-center"
              onDoubleClick={() => openSample(active)}
              onClick={(event) => {
                if (active.kind !== "video") {
                  event.preventDefault();
                  openSample(active);
                }
              }}
            >
              <SampleMedia sample={active} src={srcs[activeIndex] ?? null} variant="stage" />
            </button>
            {samples.length > 1 ? (
              <>
                <button
                  type="button"
                  aria-label="Previous sample"
                  onClick={() => step(-1)}
                  className="absolute start-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 text-foreground shadow-xs"
                >
                  <ChevronLeftIcon className="size-3.5 rtl:rotate-180" />
                </button>
                <button
                  type="button"
                  aria-label="Next sample"
                  onClick={() => step(1)}
                  className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 text-foreground shadow-xs"
                >
                  <ChevronRightIcon className="size-3.5 rtl:rotate-180" />
                </button>
              </>
            ) : null}
          </div>
          {samples.length > 1 ? (
            <div className="flex gap-1 overflow-x-auto pb-0.5">
              {samples.map((sample, sampleIndex) => (
                <button
                  key={sample.path}
                  type="button"
                  aria-label={sampleDisplayLabel(sample, props.options)}
                  aria-current={sampleIndex === activeIndex || undefined}
                  onClick={() => props.onIndexChange(sampleIndex)}
                  className={cn(
                    "relative h-8 w-14 shrink-0 overflow-hidden rounded-sm border",
                    sampleIndex === activeIndex
                      ? "border-foreground"
                      : "border-transparent opacity-55 hover:opacity-80",
                  )}
                >
                  <SampleMedia sample={sample} src={srcs[sampleIndex] ?? null} variant="thumb" />
                  {badge(sample)}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-1.5">
          {samples.map((sample, sampleIndex) => (
            <button
              key={sample.path}
              type="button"
              aria-label={sampleDisplayLabel(sample, props.options)}
              onClick={() => {
                props.onIndexChange(sampleIndex);
                setView("reel");
              }}
              className="relative aspect-video overflow-hidden rounded-md border border-border bg-muted/30"
            >
              <SampleMedia sample={sample} src={srcs[sampleIndex] ?? null} variant="thumb" />
              {badge(sample)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

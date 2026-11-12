import type { ScopedThreadRef, UserInputQuestion } from "@t3tools/contracts";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";

import { useAssetUrls } from "../../assets/assetUrls";
import { useRightPanelStore } from "../../rightPanelStore";
import {
  questionSamples,
  sampleDisplayLabel,
  spreadResolvedUrls,
  stripSamplePaths,
} from "./questionSamples";

function answerValues(answer: unknown): string[] {
  if (Array.isArray(answer))
    return answer.filter((value): value is string => typeof value === "string");
  return typeof answer === "string" ? answer.split(/,\s*/) : [];
}

/**
 * After a question with samples is answered: one row per picked sample with its
 * thumbnail and "You picked …", or, when nothing picked maps to a sample, a row of all sample
 * thumbnails. Audio samples are left out.
 */
export function QuestionPickedSamples(props: {
  readonly question: UserInputQuestion;
  readonly answer: unknown;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
}) {
  const samples = questionSamples(props.question).filter((sample) => sample.kind !== "audio");
  const values = new Set(answerValues(props.answer));
  const picked = samples.filter((sample) => {
    const option = sample.option === undefined ? undefined : props.question.options[sample.option];
    return option !== undefined && values.has(option.value ?? option.label);
  });
  const shown = picked.length > 0 ? picked : samples;
  const resolved = shown.map((sample) =>
    resolveViewedImageAsset(sample.path, {
      threadId: props.threadRef.threadId,
      workspaceRoot: props.workspaceRoot,
    }),
  );
  const urls = useAssetUrls(
    props.threadRef.environmentId,
    resolved.flatMap((asset) => (asset === null ? [] : [asset.resource])),
  );
  if (shown.length === 0) return null;
  const srcs = spreadResolvedUrls(resolved, urls);
  const open = (path: string) => useRightPanelStore.getState().openFile(props.threadRef, path);
  const thumb = (index: number, className: string) => {
    const sample = shown[index]!;
    const src = srcs[index] ?? null;
    return src === null ? (
      <span className={`${className} block rounded-sm bg-muted`} />
    ) : sample.kind === "video" ? (
      <video
        src={`${src}#t=1`}
        muted
        preload="metadata"
        className={`${className} rounded-sm object-cover`}
      />
    ) : (
      <img src={src} alt="" className={`${className} rounded-sm object-cover`} />
    );
  };
  if (picked.length > 0) {
    return (
      <div className="space-y-1" data-question-picked-samples>
        {picked.map((sample, index) => (
          <button
            key={sample.path}
            type="button"
            className="flex items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground"
            onClick={() => open(sample.path)}
          >
            {thumb(index, "h-14 w-24")}
            <span>
              You picked{" "}
              <strong className="font-medium text-foreground">
                {stripSamplePaths(
                  sampleDisplayLabel(sample, props.question.options).replace(/^\d+ · /, ""),
                )}
              </strong>
              {sample.caption ? ` · ${sample.caption}` : null}
            </span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5" data-question-picked-samples>
      {shown.map((sample, index) => (
        <button
          key={sample.path}
          type="button"
          aria-label={`Open ${sample.path}`}
          onClick={() => open(sample.path)}
        >
          {thumb(index, "h-11 w-19")}
        </button>
      ))}
    </div>
  );
}

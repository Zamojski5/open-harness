import "~/index.css";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

// Visual check of the ui-quick-wins states.

function swatch(fill: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${fill}"/><text x="160" y="100" font-family="Inter,sans-serif" font-size="28" text-anchor="middle" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SWATCHES = [
  swatch("#3b3b3b", "warm"),
  swatch("#6b6b6b", "cool"),
  swatch("#111111", "night"),
  swatch("#9a9a9a", "day"),
];

vi.mock("../../assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssetUrls: (_env: unknown, resources: ReadonlyArray<unknown>) =>
    resources.map((_, index) => SWATCHES[index % SWATCHES.length]!),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAtomCommand: () => async () => AsyncResult.success(undefined),
}));
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEnvironmentQuery: () => ({
    data: { freeBytes: 3_412_000_000, lowDisk: true, cloudSync: "none" },
    error: null,
  }),
}));
vi.mock("./CommandOutputPanel", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCommandOutputStreaming: () => false,
}));

import { ComposerBannerStack } from "./ComposerBannerStack";
import { GenerationStatusCards } from "./GenerationStatusCards";
import { parseGenerationJobs } from "./generationJobs.logic";
import { QuestionSamplesReel } from "./QuestionSamplesReel";
import { questionSamples } from "./questionSamples";
import { ExitCodeBadge, HeadTailOutput, ToolRowDiffStat, ToolRowFileLinks } from "./ToolRowParts";
import { TurnDeliverablesCard } from "./TurnDeliverablesCard";
import { TurnEndedCard } from "./TurnEndedCard";
import { deriveTurnEndedCard } from "./turnEndedCard.logic";
import { useDiskNoticeBanner } from "./useDiskNoticeBanner";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

function Frame(props: { readonly children: ReactNode }) {
  return (
    <div
      data-shot
      className="bg-background p-4 text-foreground"
      style={{ width: 720, ["--chat-content-max-width" as string]: "680px" }}
    >
      {props.children}
    </div>
  );
}

async function shoot(name: string, node: ReactNode) {
  await page.viewport(760, 1000);
  await using screen = await render(<Frame>{node}</Frame>, { router: false });
  const frame = screen.container.querySelector("[data-shot]") as HTMLElement;
  await expect.element(page.elementLocator(frame)).toBeVisible();
  // Saved next to this file under __screenshots__; copied to docs/ui-quick-wins/ for review.
  await page.screenshot({ path: `__screenshots__/ui-quick-wins/${name}.png`, element: frame });
}

const base = {
  latestRun: { status: "failed", userMessageId: "u1" },
  messages: [{ id: "u1", role: "user" as const, text: "Render shot 4", attachments: [] }],
  runHadWork: true,
  working: false,
  readOnly: false,
};

it("turn-ended cards", async () => {
  const busy = deriveTurnEndedCard({ ...base, failure: { message: "Overloaded (529)" } })!;
  const context = deriveTurnEndedCard({
    ...base,
    failure: { kind: "context-length", message: "prompt is too long: 214000 tokens > 200000" },
  })!;
  const stopped = deriveTurnEndedCard({
    ...base,
    latestRun: { status: "interrupted", userMessageId: "u1" },
    failure: null,
  })!;
  await shoot(
    "turn-ended-cards",
    <div className="space-y-2">
      <TurnEndedCard model={busy} disabled={false} onAction={() => {}} />
      <TurnEndedCard model={context} disabled={false} onAction={() => {}} />
      <TurnEndedCard model={stopped} disabled={false} onAction={() => {}} />
    </div>,
  );
});

it("tool rows", async () => {
  await shoot(
    "tool-rows",
    <div className="space-y-3 text-sm">
      <p className="flex items-baseline gap-1.5">
        <ToolRowFileLinks
          files={[
            { path: "/work/src/app.ts", linkable: true },
            { path: "/work/src/new.ts", oldPath: "/work/src/old.ts", linkable: true },
            { path: "/work/src/gone.ts", linkable: false },
          ]}
          workspaceRoot="/work"
          threadRef={threadRef}
        />
        <ToolRowDiffStat additions={42} deletions={7} />
      </p>
      <p className="flex items-baseline gap-1.5">
        <span className="text-secondary-label">make build</span>
        <span className="font-mono text-xs text-destructive">main.c:3: error: expected ';'</span>
        <ExitCodeBadge label="exit 2" />
      </p>
      <HeadTailOutput
        className="font-mono text-xs text-muted-foreground whitespace-pre-wrap"
        text={Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")}
      />
    </div>,
  );
});

it("generation status", async () => {
  const jobs = parseGenerationJobs(
    [
      "job j1 [running] veo-3.1-fast → fal:fal-ai/veo3.1/fast · 42s",
      "  IN_PROGRESS",
      "  typicalSeconds=70 (p90 150s), elapsed 42s",
      "job j2 [queued] nano-banana-pro · 3s",
      "  typicalSeconds=30 (p90 80s), elapsed 3s",
    ].join("\n"),
    // An observation "in the future" freezes the ticking clock at the reported elapsed time.
    8.64e15,
  );
  await shoot("generation-status", <GenerationStatusCards jobs={jobs} />);
});

it("question samples", async () => {
  const question = {
    question: "Which grade for shot 4? takes/shot4_warm.png takes/shot4_cool.png",
    options: [
      { label: "Warm grade", description: "Golden hour" },
      { label: "Cool grade", description: "Blue hour" },
    ],
  };
  const samples = questionSamples(question);
  await shoot(
    "question-samples",
    <QuestionSamplesReel
      samples={samples}
      options={question.options}
      pickedOptions={new Set([0])}
      threadRef={threadRef}
      workspaceRoot="/work"
      index={0}
      onIndexChange={() => {}}
    />,
  );
});

it("deliverables", async () => {
  await shoot(
    "deliverables",
    <TurnDeliverablesCard
      deliverables={[
        { path: "takes/shot4_v3.png", kind: "image" },
        { path: "takes/shot4_v3.mp4", kind: "video" },
        { path: "report.pdf", kind: "document" },
        { path: "takes/vo_take2.wav", kind: "audio" },
        { path: "scene.glb", kind: "model" },
      ]}
      threadRef={threadRef}
      workspaceRoot="/work"
    />,
  );
});

function DiskBanner() {
  const item = useDiskNoticeBanner({
    environmentId: EnvironmentId.make("env"),
    projectId: "screenshot-project",
    path: "/work",
  });
  return item ? <ComposerBannerStack items={[item]} /> : <p>no banner</p>;
}

it("disk warning", async () => {
  await shoot("disk-warning", <DiskBanner />);
});

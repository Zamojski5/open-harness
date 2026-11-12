import { describe, expect, it } from "vite-plus/test";

import { collectTurnDeliverables, replyDeliverablePaths } from "./turnDeliverables.logic";

const base = {
  written: [] as string[],
  deleted: [] as string[],
  generated: [] as string[],
  replyText: "",
  workspaceRoot: "/Users/me/work",
};

describe("turn deliverables", () => {
  it("finds takes/ and renders/ paths in the reply", () => {
    expect(
      replyDeliverablePaths("Done: `takes/shot-04.mp4`. Also renders/frame_0108.png. See notes.md"),
    ).toEqual(["takes/shot-04.mp4", "renders/frame_0108.png"]);
  });
  it("merges generated and written files, unique and relative, without deleted ones", () => {
    expect(
      collectTurnDeliverables({
        ...base,
        generated: ["/Users/me/work/takes/a.png"],
        written: [
          "/Users/me/work/takes/a.png",
          "/Users/me/work/src/app.ts",
          "/Users/me/work/report.pdf",
          "/Users/me/work/old.png",
        ],
        deleted: ["/Users/me/work/old.png"],
        replyText: "Latest: takes/a.png",
      }),
    ).toEqual([
      { path: "takes/a.png", kind: "image" },
      { path: "report.pdf", kind: "document" },
    ]);
  });
  it("M6: leaves out test snapshots, build output and source .html", () => {
    expect(
      collectTurnDeliverables({
        ...base,
        written: [
          "/Users/me/work/test/__snapshots__/x.png",
          "/Users/me/work/node_modules/pkg/logo.png",
          "/Users/me/work/dist/index.html",
          "/Users/me/work/src/index.html",
          "/Users/me/work/exports/site.html",
        ],
      }),
    ).toEqual([{ path: "exports/site.html", kind: "document" }]);
  });
  it("M6: a path the reply only mentions is not a deliverable of this turn", () => {
    expect(
      collectTurnDeliverables({
        ...base,
        replyText: "The earlier takes/v2-final.mp4 remains unchanged.",
      }),
    ).toEqual([]);
    expect(
      collectTurnDeliverables({
        ...base,
        replyText: "New cut: takes/v3.mp4",
        toolOutputs: ["ffmpeg wrote takes/v3.mp4"],
      }),
    ).toEqual([{ path: "takes/v3.mp4", kind: "video" }]);
  });
  it("M6: expands ~ against the workspace's home, or drops it when unknown", () => {
    expect(
      collectTurnDeliverables({
        ...base,
        generated: ["~/Desktop/Open-Herness-FILM/takes/final.mp4"],
      }),
    ).toEqual([{ path: "/Users/me/Desktop/Open-Herness-FILM/takes/final.mp4", kind: "video" }]);
    expect(
      collectTurnDeliverables({
        ...base,
        workspaceRoot: "/srv/work",
        generated: ["~/takes/final.mp4"],
      }),
    ).toEqual([]);
  });
  it("case study: delivery/ files named by the tool result show, README.md writes do not", () => {
    expect(
      collectTurnDeliverables({
        ...base,
        written: ["README.md", "docs/notes.md"],
        replyText:
          "Done: delivery/case-study/case-study.pdf, delivery/case-study/case-study.mp4 and delivery/case-study/CASE.md.",
        toolOutputs: [
          "Case study written to delivery/case-study/:\n- delivery/case-study/CASE.md\n- delivery/case-study/case-study.pdf\n- delivery/case-study/case-study.mp4",
        ],
      }),
    ).toEqual([
      { path: "delivery/case-study/case-study.pdf", kind: "document" },
      { path: "delivery/case-study/case-study.mp4", kind: "video" },
      { path: "delivery/case-study/CASE.md", kind: "document" },
    ]);
  });
});

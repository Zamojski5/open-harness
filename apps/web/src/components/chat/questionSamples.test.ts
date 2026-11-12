import { describe, expect, it } from "vite-plus/test";

import {
  initialSampleIndex,
  questionSamples,
  sampleDisplayLabel,
  stripSamplePaths,
} from "./questionSamples";

const opt = (label: string, description = "") => ({ label, description });

describe("questionSamples", () => {
  it("takes markdown images with alt and title, then named paths", () => {
    const samples = questionSamples({
      question: 'Which grade? ![Warm](takes/warm.png "v2") or takes/cool.png',
      options: [opt("Keep going")],
    });
    expect(samples).toEqual([
      { path: "takes/warm.png", kind: "image", label: "Warm", caption: "v2" },
      { path: "takes/cool.png", kind: "image" },
    ]);
  });
  it("binds a file named in exactly one option, bound samples first", () => {
    const samples = questionSamples({
      question: "Pick one. Reference: refs/mood.jpg",
      options: [opt("Option A", "takes/a.mp4"), opt("Option B", "takes/b.mp4 and takes/c.mp4")],
    });
    expect(samples.map((sample) => [sample.path, sample.option, sample.kind])).toEqual([
      ["takes/a.mp4", 0, "video"],
      ["refs/mood.jpg", undefined, "image"],
      ["takes/b.mp4", undefined, "video"],
      ["takes/c.mp4", undefined, "video"],
    ]);
  });
  it("binds by a word unique to the file name", () => {
    const samples = questionSamples({
      question: "Compare takes/shot_warm.png and takes/shot_cool.png",
      options: [opt("Cool look"), opt("Warm look")],
    });
    expect(samples.map((sample) => [sample.path, sample.option])).toEqual([
      ["takes/shot_cool.png", 0],
      ["takes/shot_warm.png", 1],
    ]);
  });
  it("binds by position when counts match and nothing else bound", () => {
    const samples = questionSamples({
      question: "Which? takes/1.png takes/2.png",
      options: [opt("First"), opt("Second")],
    });
    expect(samples.map((sample) => sample.option)).toEqual([0, 1]);
  });
  it("does not bind by position when an option answers for the whole set", () => {
    const samples = questionSamples({
      question: "OK? takes/1.png takes/2.png",
      options: [opt("Approve"), opt("Redo both")],
    });
    expect(samples.map((sample) => sample.option)).toEqual([undefined, undefined]);
  });
  it("ignores URLs and caps at 24", () => {
    const many = Array.from({ length: 30 }, (_, index) => `f${index}.png`).join(" ");
    expect(questionSamples({ question: many, options: [] })).toHaveLength(24);
    expect(questionSamples({ question: "https://x.com/a.png", options: [] })).toEqual([]);
  });
});

describe("labels", () => {
  it("numbers bound samples and strips a leading verb and the path", () => {
    const options = [opt("Use takes/warm.png warm grade")];
    expect(sampleDisplayLabel({ path: "takes/warm.png", kind: "image", option: 0 }, options)).toBe(
      "1 · Warm grade",
    );
    expect(stripSamplePaths("Go with </takes/x.mp3>")).toBe("Go with");
  });
  it("starts on the recommended option's sample", () => {
    const options = [opt("A"), opt("B (recommended)")];
    const samples = questionSamples({ question: "1.png 2.png", options });
    expect(initialSampleIndex(samples, options)).toBe(1);
  });
});

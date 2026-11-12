import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { parseFigmaLink, validNodeId } from "../src/figma/link.ts";

const SCRIPT = NodeURL.fileURLToPath(
  new URL("../plugin/skills/figma/scripts/figma-link.mjs", import.meta.url),
);
const cli = (arg?: string) => {
  try {
    const out = NodeChildProcess.execFileSync(
      process.execPath,
      arg === undefined ? [SCRIPT] : [SCRIPT, arg],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { code: 0, out: JSON.parse(out) };
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return { code: e.status, err: e.stderr };
  }
};

const cases: [string, { fileKey: string; nodeId: string | null; kind: string }][] = [
  [
    "https://www.figma.com/design/Ab3dEf9hIj/Poster-Draft?node-id=12-345&t=Qw8kLm2Zp7-1",
    { fileKey: "Ab3dEf9hIj", nodeId: "12:345", kind: "design" },
  ],
  [
    "https://www.figma.com/design/MainKey001/Brand/branch/BrKey77zz/Brand?node-id=3-9",
    { fileKey: "BrKey77zz", nodeId: "3:9", kind: "design" },
  ],
  [
    "https://figma.com/file/Legacy12345/Old-File",
    { fileKey: "Legacy12345", nodeId: null, kind: "file" },
  ],
  [
    "https://www.figma.com/design/Ab3dEf9hIj/X?node-id=I52-7%3B901-44%3B6-2",
    { fileKey: "Ab3dEf9hIj", nodeId: "I52:7;901:44;6:2", kind: "design" },
  ],
  [
    "https://www.figma.com/board/Jam00000k1/Retro",
    { fileKey: "Jam00000k1", nodeId: null, kind: "board" },
  ],
];

describe("figma link parser", () => {
  it.each(cases)("parses %s", (url, want) => {
    expect(parseFigmaLink(url)).toEqual(want);
    expect(cli(url)).toEqual({ code: 0, out: want });
  });

  it("accepts a bare key in the app parser only", () => {
    expect(parseFigmaLink("Ab3dEf9hIjKl")).toEqual({ fileKey: "Ab3dEf9hIjKl", nodeId: null });
    expect(cli("Ab3dEf9hIjKl").code).toBe(1);
  });

  it.each([
    "https://figma.co/design/Ab3dEf9hIj/x",
    "https://myfigma.com/design/Ab3dEf9hIj/x",
    "https://figma.com.evil.io/design/Ab3dEf9hIj/x",
  ])("rejects non-Figma host %s", (url) => {
    expect(() => parseFigmaLink(url)).toThrow("Not a Figma link");
    expect(cli(url)).toMatchObject({ code: 1, err: expect.stringContaining("Not a Figma link") });
  });

  it("needs a kind and key", () => {
    expect(() => parseFigmaLink("https://www.figma.com/files/recent")).toThrow(
      "No file key in this link",
    );
  });

  it("prints usage and exits 2 without an argument", () => {
    expect(cli()).toMatchObject({ code: 2, err: expect.stringContaining("usage") });
  });

  it("validates node ids", () => {
    expect(validNodeId("7-21")).toBe("7:21");
    expect(validNodeId("I40-3;88-15")).toBe("I40:3;88:15");
    expect(validNodeId("I40:3;88:15")).toBe("I40:3;88:15");
    expect(validNodeId("Frame 1")).toBeNull();
    expect(validNodeId("7")).toBeNull();
  });
});

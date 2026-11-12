import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { run } from "../src/figma/cli.ts";
import { decodeToDir } from "../src/figma/decode/decode.ts";
import { renderSvg } from "../src/figma/svg/render.ts";
import { clipboardHtml, designFixture, figArchive } from "./figma-fixture.ts";

let dir = "";
let out = "";
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oh-figma-svg-"));
  out = NodePath.join(dir, "out");
  const p = NodePath.join(dir, "a.fig");
  NodeFS.writeFileSync(p, figArchive(designFixture()));
  decodeToDir(p, { out });
});
afterEach(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

const svgOf = (r: { svg: string }) => NodeFS.readFileSync(r.svg, "utf8");

describe("svg renderer", () => {
  it("draws a frame and reports every approximation", () => {
    const r = renderSvg(out, "1:10", { pad: 10, scale: 2 });
    expect(r).toMatchObject({ node: "1:10", name: "Hero", width: 200, height: 100 });
    expect(r.svg).toBe(NodePath.join(out, "svg", "1-10.svg"));
    const svg = svgOf(r);
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="440" height="240" viewBox="0 0 220 120">/,
    );
    expect(r.approximations).toEqual({
      "text without baked glyphs (skipped)": 2,
      "angular gradient drawn as radial": 1,
      "stroke without baked outline drawn centred": 1,
      "shadow spread ignored": 1,
      "effect inner_shadow not drawn": 1,
    });
    // approximations are ordered by count
    expect(Object.values(r.approximations)[0]).toBe(2);
  });

  it("composes transforms and draws the quadratic path as a curve", () => {
    const svg = svgOf(renderSvg(out, "1:10", { pad: 10 }));
    // Brand block at frame (0,0), root offset by pad 10: square path with a Q segment
    expect(svg).toContain(
      '<path d="M10 10L20 10Q20 20 10 20Z" fill="#FF0000" fill-rule="nonzero"/>',
    );
    // its baked stroke outline is filled, not stroked
    expect(svg).toContain(
      '<path d="M10 10L30 10L30 30L10 30Z" fill="#000000" fill-rule="nonzero"/>',
    );
    // legacy-close blob still renders
    expect(svg).toContain('d="M200 100L205 100L205 105ZM201 101L202 102Z" fill="#808080"');
  });

  it("uses stopsVar when stops are blank and maps gradients through the inverse paint transform", () => {
    const svg = svgOf(renderSvg(out, "1:12"));
    expect(svg).toContain(
      '<linearGradient id="g1" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="matrix(50 0 0 20 0 0)"><stop offset="0" stop-color="#000000" stop-opacity="1"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="1"/></linearGradient>',
    );
    expect(svg).toContain('<radialGradient id="g2"');
    expect(svg).toContain('stop-opacity="0.5"');
  });

  it("embeds image fills with a sniffed MIME type and cover placement, or links them", () => {
    const svg = svgOf(renderSvg(out, "1:13"));
    // 4x2 image into a 40x40 box, cover: scale 20, centred horizontally (-20)
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain(
      'width="4" height="2" preserveAspectRatio="none" transform="matrix(20 0 0 20 -20 0)"',
    );
    const linked = svgOf(
      renderSvg(out, "1:13", { linkImages: true, out: NodePath.join(dir, "l.svg") }),
    );
    expect(linked).toContain(`href="file://${NodePath.join(out, "images")}`);
  });

  it("clips siblings above a mask and never draws the mask itself", () => {
    const svg = svgOf(renderSvg(out, "1:14"));
    expect(svg).toMatch(/<clipPath id="m\d+"><path d="M30 15C30 23/);
    expect(svg).not.toContain('fill="#000000"');
    expect(svg).toMatch(
      /<g clip-path="url\(#m\d+\)"><path d="M0 0L30 0L30 30L0 30L0 0Z" fill="#00FF00"/,
    );
  });

  it("does not draw boolean operands when the boolean has solved geometry", () => {
    const svg = svgOf(renderSvg(out, "1:17"));
    expect(svg).toContain('fill="#333333" fill-rule="evenodd"');
    expect(svg).not.toContain("#1AE51A");
  });

  it("draws instances from their component with overrides and derived glyph layout", () => {
    const r = renderSvg(out, "1:20");
    const svg = svgOf(r);
    expect(svg).toContain('fill="#0000FF"');
    // overridden text "Go" uses the derived layout: two glyphs, the second placed 3px right
    const white = svg.match(/<path d="([^"]+)" fill="#FFFFFF"/);
    expect(white?.[1]).toBe("M5 13L6 13L6 6L5 6ZM8 13L9 13L9 6L8 6Z");
    expect(r.approximations).toEqual({});
  });

  it("reports a missing component, hidden layers on request, and missing images", () => {
    const hidden = svgOf(
      renderSvg(out, "1:10", { includeHidden: true, out: NodePath.join(dir, "h.svg") }),
    );
    expect(hidden).toContain("#00FFFF");
    NodeFS.rmSync(NodePath.join(out, "images"), { recursive: true });
    const r = renderSvg(out, "1:13", { out: NodePath.join(dir, "m.svg") });
    expect(r.approximations).toEqual({
      "no image bytes for this fill (rerun decode with --images all; pastes never carry pixels)": 1,
    });
  });

  it("errors on an unknown node with the id hint", () => {
    expect(() => renderSvg(out, "8:8")).toThrow("no node 8:8; ids look like N:M (see outline.txt)");
    expect(() => run(["svg", out, "Frame"])).toThrow("ids look like N:M");
  });

  it("renders a paste after its images were fetched by hash into images/", () => {
    const f = designFixture();
    const p = NodePath.join(dir, "paste.html");
    NodeFS.writeFileSync(p, clipboardHtml(f.message, { fileKey: "K" }));
    const po = NodePath.join(dir, "paste");
    decodeToDir(p, { out: po });
    expect(renderSvg(po, "1:13").approximations).toHaveProperty([
      "no image bytes for this fill (rerun decode with --images all; pastes never carry pixels)",
    ]);
    NodeFS.mkdirSync(NodePath.join(po, "images"));
    // fetched later with an arbitrary extension: matched by hash prefix, MIME sniffed from bytes
    NodeFS.writeFileSync(NodePath.join(po, "images", `${f.imageHash}.bin`), f.imageBytes);
    const r = renderSvg(po, "1:13", { out: NodePath.join(dir, "p.svg") });
    expect(r.approximations).toEqual({});
    expect(svgOf(r)).toContain("data:image/png;base64,");
  });
});

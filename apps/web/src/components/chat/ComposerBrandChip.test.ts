import { describe, expect, it } from "vite-plus/test";

import { brandChipPresentation } from "./ComposerBrandChip";

const active = {
  state: "active" as const,
  name: "Acme",
  source: "brand/brand.md",
  enabled: true,
  choices: [],
};

describe("brandChipPresentation", () => {
  it("hides the chip when the project has no brand", () => {
    expect(brandChipPresentation(null)).toBeNull();
    expect(brandChipPresentation({ state: "none", enabled: true, choices: [] })).toBeNull();
  });

  it("names the active brand and offers to turn it off", () => {
    expect(brandChipPresentation(active)).toMatchObject({
      label: "Brand: Acme",
      toggle: true,
      active: true,
    });
  });

  it("shows the thread's switch, preferring the optimistic value", () => {
    expect(brandChipPresentation({ ...active, enabled: false })).toMatchObject({
      label: "Brand off",
      active: false,
    });
    expect(brandChipPresentation(active, false)?.label).toBe("Brand off");
  });

  it("asks to choose among several brands without a toggle", () => {
    const view = brandChipPresentation({
      state: "choose",
      enabled: true,
      choices: ["acme", "bolt"],
    });
    expect(view).toMatchObject({ label: "Choose brand", toggle: false });
    expect(view?.tooltip).toContain("acme, bolt");
    expect(view?.tooltip).toContain("brand/ACTIVE");
  });
});

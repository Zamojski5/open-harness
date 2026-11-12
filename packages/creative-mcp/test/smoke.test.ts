import { describe, expect, it } from "vite-plus/test";
import { ohHome } from "../src/home.ts";
import { isolate } from "./isolate.ts";

const env = isolate();

describe("test isolation", () => {
  it("points OH_HOME at a temp dir and blocks the network", async () => {
    expect(ohHome("x")).toBe(`${env.home}/x`);
    await expect(fetch("https://fal.ai/")).rejects.toThrow(/unexpected network call/);
  });
});

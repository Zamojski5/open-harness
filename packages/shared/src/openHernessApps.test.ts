import { describe, expect, it } from "vite-plus/test";

import {
  OPEN_HERNESS_APPS,
  formatOpenHernessAppReference,
  matchOpenHernessApps,
  openHernessAppContextId,
  openHernessAppIdForContextId,
  type OpenHernessAppAvailability,
} from "./openHernessApps.ts";
import { collectComposerContextReferences } from "./composerContextReferences.ts";

const entry = (
  id: string,
  name: string,
  status: OpenHernessAppAvailability["status"] = "installed",
  kind: OpenHernessAppAvailability["kind"] = "desktop",
): OpenHernessAppAvailability => ({ id, name, kind, use: "", status });

const apps = [
  entry("blender", "Blender", "ready"),
  entry("davinci-resolve", "DaVinci Resolve", "not-installed"),
  entry("premiere-pro", "Premiere Pro"),
  entry("after-effects", "After Effects", "not-installed"),
  entry("remotion", "Remotion", "on-demand", "framework"),
  entry("figma", "Figma", "configured", "service"),
  entry("mcp-linear", "linear", "configured", "service"),
];

const names = (list: ReadonlyArray<OpenHernessAppAvailability>) => list.map((app) => app.name);

describe("matchOpenHernessApps", () => {
  it("ranks name prefix, then word prefix, then substring/alias/id", () => {
    expect(names(matchOpenHernessApps(apps, "re"))).toEqual([
      "Remotion",
      "DaVinci Resolve",
      "Premiere Pro",
    ]);
    expect(names(matchOpenHernessApps(apps, "Pro"))).toEqual(["Premiere Pro"]);
    // "ae" is an After Effects alias; "resolve" also matches its id.
    expect(names(matchOpenHernessApps(apps, "ae"))).toEqual(["After Effects"]);
    expect(names(matchOpenHernessApps(apps, "davinci"))).toEqual(["DaVinci Resolve"]);
    expect(matchOpenHernessApps(apps, "zzz")).toEqual([]);
  });

  it("puts available desktop apps first for an empty query", () => {
    expect(names(matchOpenHernessApps(apps, " "))).toEqual([
      "Blender",
      "Premiere Pro",
      "Figma",
      "linear",
      "Remotion",
      "After Effects",
      "DaVinci Resolve",
    ]);
  });

  it("lists available apps before missing ones within a rank", () => {
    const list = [entry("a1", "Alpha", "not-installed"), entry("a2", "Alpine", "installed")];
    expect(names(matchOpenHernessApps(list, "al"))).toEqual(["Alpine", "Alpha"]);
  });
});

describe("app chips", () => {
  it("serialises to a context link the composer and server both read", () => {
    const text = `cut it ${formatOpenHernessAppReference({ id: "davinci-resolve", name: "DaVinci Resolve" })}`;
    const [reference] = collectComposerContextReferences(text);
    expect(reference).toMatchObject({
      kind: "app",
      contextId: "app_davinci-resolve",
      label: "DaVinci Resolve",
    });
    expect(openHernessAppIdForContextId(reference!.contextId)).toBe("davinci-resolve");
  });

  it("resolves hashed ids of MCP servers from the extra ids", () => {
    const id = openHernessAppContextId("mcp-my.server");
    expect(openHernessAppIdForContextId(id)).toBeUndefined();
    expect(openHernessAppIdForContextId(id, ["mcp-my.server"])).toBe("mcp-my.server");
  });

  it("covers every catalog app with a valid context id", () => {
    for (const app of OPEN_HERNESS_APPS) {
      expect(openHernessAppIdForContextId(openHernessAppContextId(app.id))).toBe(app.id);
    }
  });
});

/**
 * Open Herness: the creative apps the agent can drive, shared by the server (prompt app list,
 * availability, the app context block) and the web composer (the "@" app picker).
 *
 * An install path ending in `*` matches any entry in that folder starting with the rest
 * (versioned Adobe/Maxon/Epic folders).
 */

import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";

export type OpenHernessAppKind = "desktop" | "framework" | "service";

/** `ready`: installed and driven by OH's built-in creative tools; `on-demand`: set up per project. */
export type OpenHernessAppStatus =
  | "ready"
  | "installed"
  | "configured"
  | "on-demand"
  | "not-installed";

export interface OpenHernessApp {
  readonly id: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly kind: OpenHernessAppKind;
  /** One line: what the app is for. */
  readonly use: string;
  /** Creative plugin skill id (Claude loads it as `open-herness:<skill>`). */
  readonly skill?: string;
  readonly installPaths?: ReadonlyArray<string>;
  /** How the agent drives it once loaded. */
  readonly tools?: string;
  /** Driven by the always-attached open-herness-creative MCP server. */
  readonly builtInTools?: boolean;
  /** How the user gets it working when it is missing. */
  readonly connect: string;
  /** Text for the session prompt's app list; apps without it are not listed there. */
  readonly prompt?: string;
}

const BRIDGE = (prefix: string) =>
  `If the claude.ai "Bridge Higgsfield" connector is connected in Claude, its ${prefix} tools drive the open app too.`;

export const OPEN_HERNESS_APPS: ReadonlyArray<OpenHernessApp> = [
  {
    id: "blender",
    name: "Blender",
    kind: "desktop",
    use: "3D scenes, modelling, lighting, animation, renders",
    skill: "blender",
    installPaths: ["/Applications/Blender.app"],
    builtInTools: true,
    tools: `open-herness-creative blender_* tools. ${BRIDGE("bl_*")}`,
    connect: "Install Blender from blender.org into /Applications.",
    prompt:
      "3D scenes, modelling, materials, lighting, 3D animation, renders (creative tools: blender_*)",
  },
  {
    id: "effectcraft",
    name: "EffectCraft",
    kind: "desktop",
    use: "2D motion graphics and compositing",
    skill: "effectcraft",
    installPaths: ["/Applications/EffectCraft.app"],
    builtInTools: true,
    tools: "effectcraft_launch, then the effectcraft MCP tools",
    connect: "Install EffectCraft into /Applications (open-herness-setup skill).",
    prompt:
      "2D motion graphics and compositing, After Effects-style (effectcraft_launch + effectcraft MCP tools)",
  },
  {
    id: "lightcraft",
    name: "LightCraft",
    kind: "desktop",
    use: "photo library and raw development",
    skill: "lightcraft",
    installPaths: ["/Applications/LightCraft.app"],
    builtInTools: true,
    tools: "the lightcraft MCP tools",
    connect: "Install LightCraft into /Applications (open-herness-setup skill).",
    prompt:
      "photo library and raw development, Lightroom-style: exposure, colour grading, masks, presets, batch export (lightcraft MCP tools)",
  },
  {
    id: "photocraft",
    name: "PhotoCraft",
    kind: "desktop",
    use: "layered image editing with PSD files",
    skill: "photocraft",
    installPaths: ["/Applications/PhotoCraft.app"],
    builtInTools: true,
    tools: "the photocraft MCP tools",
    connect: "Install PhotoCraft into /Applications (open-herness-setup skill).",
    prompt:
      "layered image editing with real PSD files: layers, masks, adjustment layers, filters, type (photocraft MCP tools)",
  },
  {
    id: "vectorcraft",
    name: "VectorCraft",
    kind: "desktop",
    use: "vector illustration (AI, EPS, PDF, SVG)",
    skill: "vectorcraft",
    installPaths: ["/Applications/VectorCraft.app"],
    builtInTools: true,
    tools: "the vectorcraft MCP tools",
    connect: "Install VectorCraft into /Applications (open-herness-setup skill).",
    prompt: "vector illustration; opens and writes AI, EPS, PDF, SVG (vectorcraft MCP tools)",
  },
  {
    id: "filmcraft",
    name: "FilmCraft",
    kind: "desktop",
    use: "video editing, colour and sound",
    skill: "filmcraft",
    installPaths: ["/Applications/FilmCraft.app"],
    builtInTools: true,
    tools: "the filmcraft MCP tools",
    connect: "Install FilmCraft into /Applications (open-herness-setup skill).",
    prompt:
      "video editing timeline, colour grading and sound, export to H.264/HEVC/ProRes (filmcraft MCP tools)",
  },
  {
    id: "designcraft",
    name: "DesignCraft",
    kind: "desktop",
    use: "page layout and publishing",
    skill: "designcraft",
    installPaths: ["/Applications/DesignCraft.app"],
    builtInTools: true,
    tools: "the designcraft MCP tools",
    connect: "Install DesignCraft into /Applications (open-herness-setup skill).",
    prompt: "page layout and publishing: posters, spreads, brochures, PDF (designcraft MCP tools)",
  },
  {
    id: "krita",
    name: "Krita",
    kind: "desktop",
    use: "digital painting and textures",
    skill: "krita",
    installPaths: ["/Applications/krita.app", "/Applications/Krita.app"],
    connect: "Install Krita from krita.org into /Applications.",
    prompt: "digital painting, illustration, textures",
  },
  {
    id: "gimp",
    name: "GIMP",
    kind: "desktop",
    use: "raster image editing",
    skill: "gimp",
    installPaths: ["/Applications/GIMP.app", "/Applications/GIMP-2.10.app"],
    connect: "Install GIMP from gimp.org into /Applications.",
    prompt: "raster image editing",
  },
  {
    id: "inkscape",
    name: "Inkscape",
    kind: "desktop",
    use: "vector graphics, logos, SVG",
    skill: "inkscape",
    installPaths: ["/Applications/Inkscape.app"],
    connect: "Install Inkscape from inkscape.org into /Applications.",
    prompt: "vector graphics, logos, SVG",
  },
  {
    id: "audacity",
    name: "Audacity",
    kind: "desktop",
    use: "audio editing",
    skill: "audacity",
    installPaths: ["/Applications/Audacity.app"],
    connect: "Install Audacity from audacityteam.org into /Applications.",
    prompt: "audio editing",
  },
  {
    id: "davinci-resolve",
    name: "DaVinci Resolve",
    aliases: ["resolve", "davinci"],
    kind: "desktop",
    use: "editing, colour grading, Fusion",
    skill: "davinci-resolve",
    installPaths: ["/Applications/DaVinci Resolve/DaVinci Resolve.app"],
    connect: "Install DaVinci Resolve from blackmagicdesign.com.",
    prompt: "editing, colour grading, Fusion compositing",
  },
  {
    id: "kdenlive",
    name: "Kdenlive",
    kind: "desktop",
    use: "open-source video editing",
    skill: "kdenlive",
    installPaths: ["/Applications/kdenlive.app", "/Applications/Kdenlive.app"],
    connect: "Install Kdenlive from kdenlive.org into /Applications.",
    prompt: "video editing",
  },
  {
    id: "godot",
    name: "Godot",
    kind: "desktop",
    use: "games and interactive scenes",
    skill: "godot",
    installPaths: ["/Applications/Godot.app"],
    connect: "Install Godot from godotengine.org into /Applications.",
    prompt: "games and interactive scenes",
  },
  {
    id: "obs",
    name: "OBS",
    aliases: ["obs studio"],
    kind: "desktop",
    use: "screen and camera recording",
    skill: "obs",
    installPaths: ["/Applications/OBS.app"],
    connect: "Install OBS Studio from obsproject.com and turn on its WebSocket server.",
    prompt: "screen and camera recording",
  },
  {
    id: "garageband",
    name: "GarageBand",
    kind: "desktop",
    use: "music (manual app, no automation)",
    installPaths: ["/Applications/GarageBand.app"],
    connect: "Install GarageBand from the Mac App Store.",
    prompt: "music (manual app, no automation)",
  },
  {
    id: "after-effects",
    name: "After Effects",
    aliases: ["ae", "adobe after effects"],
    kind: "desktop",
    use: "motion graphics and compositing (Adobe)",
    skill: "after-effects",
    installPaths: ["/Applications/Adobe After Effects*"],
    tools: `ExtendScript and aerender as the skill describes. ${BRIDGE("ae_*")}`,
    connect: "Install After Effects with Adobe Creative Cloud.",
  },
  {
    id: "premiere-pro",
    name: "Premiere Pro",
    aliases: ["premiere", "pr", "adobe premiere"],
    kind: "desktop",
    use: "video editing (Adobe)",
    skill: "premiere-pro",
    installPaths: ["/Applications/Adobe Premiere Pro*"],
    tools: `XML timelines and project edits as the skill describes. ${BRIDGE("pr_*")}`,
    connect: "Install Premiere Pro with Adobe Creative Cloud.",
  },
  {
    id: "photoshop",
    name: "Photoshop",
    aliases: ["ps", "adobe photoshop"],
    kind: "desktop",
    use: "layered image editing (Adobe)",
    skill: "photoshop",
    installPaths: ["/Applications/Adobe Photoshop*"],
    connect: "Install Photoshop with Adobe Creative Cloud.",
  },
  {
    id: "illustrator",
    name: "Illustrator",
    aliases: ["ai", "adobe illustrator"],
    kind: "desktop",
    use: "vector artwork (Adobe)",
    skill: "illustrator",
    installPaths: ["/Applications/Adobe Illustrator*"],
    connect: "Install Illustrator with Adobe Creative Cloud.",
  },
  {
    id: "final-cut-pro",
    name: "Final Cut Pro",
    aliases: ["fcp", "final cut"],
    kind: "desktop",
    use: "video editing (Apple), FCPXML hand-off",
    skill: "final-cut-pro",
    installPaths: ["/Applications/Final Cut Pro*"],
    connect: "Install Final Cut Pro from the Mac App Store.",
  },
  {
    id: "capcut",
    name: "CapCut",
    kind: "desktop",
    use: "social video editing (project hand-off)",
    skill: "capcut",
    installPaths: ["/Applications/CapCut.app"],
    connect: "Install CapCut desktop from capcut.com, or finish the hand-off on the web or phone.",
  },
  {
    id: "descript",
    name: "Descript",
    kind: "desktop",
    use: "text-based video and podcast editing",
    skill: "descript",
    installPaths: ["/Applications/Descript.app"],
    connect: "Install Descript from descript.com.",
  },
  {
    id: "unreal-engine",
    name: "Unreal Engine",
    aliases: ["unreal", "ue5", "ue"],
    kind: "desktop",
    use: "real-time 3D, levels, Movie Render Queue",
    skill: "unreal-engine",
    installPaths: ["/Users/Shared/Epic Games/UE_*", "/Applications/Epic Games Launcher.app"],
    connect: "Install Unreal Engine through the Epic Games Launcher.",
  },
  {
    id: "unity-engine",
    name: "Unity",
    aliases: ["unity engine"],
    kind: "desktop",
    use: "games and interactive 3D",
    skill: "unity-engine",
    installPaths: ["/Applications/Unity Hub.app", "/Applications/Unity/Hub/Editor/*"],
    connect: "Install Unity Hub and an Editor from unity.com.",
  },
  {
    id: "cinema-4d",
    name: "Cinema 4D",
    aliases: ["c4d", "maxon"],
    kind: "desktop",
    use: "3D scenes and Redshift renders (Maxon)",
    skill: "cinema-4d",
    installPaths: ["/Applications/Maxon Cinema 4D*"],
    tools: `c4dpy as the skill describes. ${BRIDGE("c4d_*")}`,
    connect: "Install Cinema 4D with the Maxon App.",
  },
  {
    id: "houdini",
    name: "Houdini",
    aliases: ["sidefx"],
    kind: "desktop",
    use: "procedural 3D and FX",
    skill: "houdini",
    installPaths: ["/Applications/Houdini*"],
    connect: "Install Houdini from sidefx.com.",
  },
  {
    id: "ableton-live",
    name: "Ableton Live",
    aliases: ["ableton", "live"],
    kind: "desktop",
    use: "music production",
    skill: "ableton-live",
    installPaths: ["/Applications/Ableton Live*"],
    connect: "Install Ableton Live from ableton.com.",
  },
  {
    id: "reaper",
    name: "REAPER",
    kind: "desktop",
    use: "multitrack audio and mixing",
    skill: "reaper",
    installPaths: ["/Applications/REAPER.app", "/Applications/REAPER64.app"],
    connect: "Install REAPER from reaper.fm.",
  },
  {
    id: "roblox-studio",
    name: "Roblox Studio",
    aliases: ["roblox"],
    kind: "desktop",
    use: "Roblox experiences",
    skill: "roblox-studio",
    installPaths: ["/Applications/RobloxStudio.app", "/Applications/Roblox Studio.app"],
    connect: "Install Roblox Studio from create.roblox.com.",
  },
  {
    id: "figma",
    name: "Figma",
    kind: "service",
    use: "design files: exports, colours, text styles",
    skill: "figma",
    installPaths: ["/Applications/Figma.app"],
    tools: "the Figma MCP server or the REST API, as the skill describes",
    connect: "Connect the Figma MCP server in Claude (or give a Figma access token).",
  },
  {
    id: "comfyui",
    name: "ComfyUI",
    kind: "service",
    use: "local image/video model workflows",
    skill: "comfyui",
    installPaths: ["/Applications/ComfyUI.app"],
    tools: "ComfyUI's local HTTP API",
    connect: "Install ComfyUI and start it so its local API answers.",
  },
  {
    id: "remotion",
    name: "Remotion",
    kind: "framework",
    use: "videos made in React",
    skill: "remotion",
    connect: "Set up per project by the agent (needs Node).",
  },
  {
    id: "hyperframes",
    name: "HyperFrames",
    kind: "framework",
    use: "videos made from HTML and GSAP",
    skill: "hyperframes",
    connect: "Set up per project by the agent (needs Node).",
  },
  {
    id: "manim",
    name: "Manim",
    kind: "framework",
    use: "maths and diagram animation",
    skill: "manim",
    connect: "Set up per project by the agent (needs Python).",
  },
];

/** Prefix for apps that are MCP tool servers from the user's config. */
export const MCP_APP_ID_PREFIX = "mcp-";

export interface OpenHernessAppAvailability {
  readonly id: string;
  readonly name: string;
  readonly kind: OpenHernessAppKind;
  readonly use: string;
  readonly status: OpenHernessAppStatus;
  readonly skill?: string | undefined;
  /** Where it was found (install path or config file). */
  readonly detail?: string | undefined;
}

export function findOpenHernessApp(id: string): OpenHernessApp | undefined {
  return OPEN_HERNESS_APPS.find((app) => app.id === id);
}

export function openHernessAppStatusLabel(status: OpenHernessAppStatus): string {
  return status === "not-installed"
    ? "not installed"
    : status === "on-demand"
      ? "on demand"
      : status;
}

const AVAILABLE = new Set<OpenHernessAppStatus>(["ready", "installed", "configured", "on-demand"]);

export function isOpenHernessAppAvailable(status: OpenHernessAppStatus): boolean {
  return AVAILABLE.has(status);
}

function rankOf(app: OpenHernessAppAvailability, aliases: ReadonlyArray<string>, query: string) {
  const name = app.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.split(/[\s-]+/).some((word) => word.startsWith(query))) return 1;
  if (
    name.includes(query) ||
    app.id.includes(query) ||
    aliases.some((alias) => alias.toLowerCase().includes(query))
  )
    return 2;
  return undefined;
}

/**
 * Apps matching an "@" query. Name prefix ranks first, then a word prefix, then a substring of
 * the name, id or an alias; available apps before missing ones within a rank. An empty query
 * lists available desktop apps first.
 */
export function matchOpenHernessApps(
  apps: ReadonlyArray<OpenHernessAppAvailability>,
  rawQuery: string,
): OpenHernessAppAvailability[] {
  const query = rawQuery.trim().toLowerCase();
  const missingLast = (app: OpenHernessAppAvailability) =>
    isOpenHernessAppAvailable(app.status) ? 0 : 1;
  if (query === "") {
    const order = (app: OpenHernessAppAvailability) =>
      missingLast(app) * 2 + (app.kind === "desktop" ? 0 : 1);
    return [...apps].sort(
      (left, right) => order(left) - order(right) || left.name.localeCompare(right.name),
    );
  }
  const ranked: { app: OpenHernessAppAvailability; rank: number }[] = [];
  for (const app of apps) {
    const rank = rankOf(app, findOpenHernessApp(app.id)?.aliases ?? [], query);
    if (rank !== undefined) ranked.push({ app, rank });
  }
  return ranked
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        missingLast(left.app) - missingLast(right.app) ||
        left.app.name.localeCompare(right.app.name),
    )
    .map((entry) => entry.app);
}

/** Composer context kind of an app chip. Not a known record kind: the server resolves it. */
export const OPEN_HERNESS_APP_CONTEXT_KIND = "app";

export function openHernessAppContextId(appId: string) {
  return toKindScopedComposerContextId(OPEN_HERNESS_APP_CONTEXT_KIND, appId);
}

/** The text a picked app leaves in the prompt: a context link the editor shows as a chip. */
export function formatOpenHernessAppReference(app: { readonly id: string; readonly name: string }) {
  return formatComposerContextReference({
    kind: OPEN_HERNESS_APP_CONTEXT_KIND,
    contextId: openHernessAppContextId(app.id),
    label: app.name,
  });
}

/** The catalog app (or MCP server id among `extraIds`) a chip's context id points at. */
export function openHernessAppIdForContextId(
  contextId: string,
  extraIds: ReadonlyArray<string> = [],
): string | undefined {
  return [...OPEN_HERNESS_APPS.map((app) => app.id), ...extraIds].find(
    (id) => openHernessAppContextId(id) === contextId,
  );
}

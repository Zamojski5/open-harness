#!/usr/bin/env node
// Open Herness creative MCP server: tools that let agents work in open-source creative apps.
// stdio transport; the working directory is the agent's project (outputs go to ./takes/).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAssetTools } from "./assets/tools.ts";
import { registerBlenderDiagnostics } from "./blender/diagnostics.ts";
import { registerBlenderLook } from "./blender/look.ts";
import { registerBlenderTools } from "./blender/tools.ts";
import { registerEffectCraftTools } from "./effectcraft/tools.ts";
import { registerAssembleTools } from "./media/assemble.ts";
import { registerFinalizeTools } from "./media/finalize.ts";
import { registerLocalJobTools } from "./media/localjobs.ts";
import { registerMediaTools } from "./media/tools.ts";
import { registerProjectTools } from "./project/tools.ts";
import { registerQualityTools } from "./quality/tools.ts";
import { registerReferenceTools } from "./references/tools.ts";
import { registerWatchTools } from "./references/watch.ts";
import { installResultBounds } from "./bounds.ts";
import { registerGoalTools } from "./goal/tools.ts";
import { registerCaseStudyTools } from "./case/tools.ts";
import { statusLine as figmaStatusLine } from "./figma/connection.ts";
import { registerFigmaTools } from "./figma/tools.ts";

const server = new McpServer(
  { name: "open-herness-creative", version: "0.1.0" },
  {
    instructions: [
      "Creative tools from Open Harness for open-source creative apps.",
      "",
      "Quality goal: when the user states a bar (e.g. 8/10 against references, a deadline, a budget), call goal_set first (spend cap only from the user's own words, or localOnly for free work), then after each version you show call goal_review with the new files and fix its gaps; you are held at the end of a turn until the bar is met or a limit is hit, then report the latest score and what still falls short and close with goal_end.",
      "",
      "Quality loop (for anything visual, always): 1) Research first: reference_search with several specific queries, reference_collect the best 5-8 into a moodboard with a note on what each contributes, reference_board for the palette, then write references/<board>/brief.md (palette hex, shapes/proportions, lighting, composition, mood, what to avoid). 2) Build in steps, looking at a screenshot after each. 3) After each preview render, reference_compare against the board, score it, fix the 3 biggest gaps, repeat (max 3-4 rounds). 4) When done, tell the user honestly what still differs from the references.",
      "",
      "Choosing the app: Blender for 3D scenes, modelling, materials, physically lit renders and 3D animation. EffectCraft (effectcraft_launch, then the effectcraft MCP tools) for 2D motion graphics and compositing: titles and kinetic typography, logo animation, layering renders with text, glows/blur/colour grading effects, transitions, Lottie. Combine them: render plates in Blender (transparent PNG sequences or MP4), then composite, title and grade them in EffectCraft. ffmpeg for cutting, concatenating and mixing audio. Craft apps (headless MCP servers lightcraft, photocraft, vectorcraft, filmcraft, designcraft; load the matching skill): LightCraft to develop and grade stills and frames (Lightroom-style), PhotoCraft for layered PSD work, VectorCraft for vector art, FilmCraft for timeline edits, colour grading, sound and export, DesignCraft for print/page layout; craft_launch opens the saved file in the app so the user sees it.",
      "",
      "Blender workflow:",
      "1. blender_status, then blender_launch (opens the user's Blender window with a live bridge; reuses a running one). Work in the live scene so the user watches progress.",
      "2. blender_exec runs bpy in that scene. One logical step per call (e.g. build the floor; then the hero object; then materials; then lights; then camera; then animation). After each visual step call blender_screenshot (shading=material) and look at it before continuing; fix problems immediately.",
      "3. Use blender_scene to read exact names, transforms and dimensions instead of guessing.",
      "4. Scripting tips: prefer bpy.data / direct properties over bpy.ops (ops depend on context). Give objects and materials clear names. Build materials with nodes (Principled BSDF: Base Color, Roughness, Metallic, Emission Color + Emission Strength for glow). Set scene.camera and aim cameras with a Track To constraint to an empty. Use Area lights for soft studio light; for EEVEE glow enable bloom-like effect via emission strength and a dark world. Keyframe with obj.keyframe_insert(data_path, frame=…); set scene.frame_start/frame_end and render.fps.",
      "5. blender_render renders in a background process into ./takes/ (stills return the image; animations produce MP4). Previews: engine=eevee, resolution_percentage=50. Finals: eevee at 100% or cycles with 64-256 samples. Tell the user the output path.",
      "6. blender_save keeps the .blend in the project (e.g. scenes/<name>.blend) so work is not lost; blender_script runs headless batch jobs (exports to glTF/FBX/OBJ, procedural generation, conversions).",
      "Never block the live UI with long renders inside blender_exec; use blender_render.",
      "Assets: before modelling from primitives, look for free CC0 HDRIs, PBR textures and models with asset_search (Poly Haven), then asset_apply_hdri / asset_apply_material / asset_import_model put them in the live scene (asset_download just fetches files into ./assets/polyhaven/).",
      "",
      "media_flicker finds 1-2 frame glitches and flicker (A-B-A pops) with a before/glitch/after strip; run it on AI video and rendered animations before delivery.",
      "loop_check verifies a seamless loop (last->first SSIM + motion continuity) for loops, GIFs and backgrounds, with fix advice.",
      "blender_light_solo renders each light / the world alone with per-light share, cast and clipping: use it when a render looks washed out, flat or tinted.",
      "blender_compare_reference compares each object's screen region in a render with a reference (colour, contrast, speculars, texture) and names the gap + fix direction.",
      "blender_render_budget probes seconds/frame, fits an animation into a time budget (degraded copy in ./takes/), then render with blender_render frames_dir + interleaved (resumable, early preview).",
      "Research: reference_download <url> <board> saves a public video with a receipt (references/<board>/library.json); media_watch <path> watches it with sound (measured cuts, loudness, model breakdown cross-checked against the frames and OCR) and returns frames to look at. Use the reference-research skill for the loop; never cite a breakdown claim you have not checked.",
      "Quality harness: run media_review on every final render/export (fix its errors and warnings, then present); log each take with takes_log (what changed vs the previous take, rubric score) and compare candidates with takes_compare; never overwrite takes. When the user corrects you or states a lasting preference, save it at once with house_style (one testable rule + why) and confirm in one line.",
      "",
      "Project brief: at the start of work call project_brief get; if empty, agree goal/audience/deliverables/tone/constraints with the user and project_brief set. Log every approved direction, picked take or ruled-out option with project_brief decide (one dated line, with why). It lives in CLAUDE.md/AGENTS.md and survives new chats and compaction.",
      "Cast: for any character, location or prop that recurs across shots make a cast card (cast_create: fixed description + role-tagged refs) and use cast_sheet's description and hero refs in every generation; check likeness against the sheet. Cards of real people or licensed IP stay draft until the user confirms consent in their own words (cast_update consent=true + user_quote); never generate a draft card's likeness.",
      "Brand: brand_capture <url> pulls palette, fonts, logos, copy and a screenshot into ./brand/<name>/ (then curate ./brand/brand.md with the brand-kit skill); brand_motion <video> measures cut rate and shot lengths to match a brand's pacing.",
      "",
      "Case study: case_study_build turns this project's own logs (time, spend, drafts, iterations, reviews, deliverables, the recorded process) into ./delivery/case-study/ (CASE.md, numbers.json, one-page PDF, 45-60 s video), locally. Load the case-study skill first; for client work ask about confidentiality before building.",
      "Figma: load the figma skill for any Figma link, .fig/.deck file or copied layers. figma_decode reads local copies and pastes offline (summary.json first, figma_svg draws nodes); figma_status/figma_get/figma_render/figma_images use the user's own token (Keychain or FIGMA_TOKEN), one call at a time.",
      ...(figmaStatusLine() ? [figmaStatusLine()!] : []),
      "",
      "Media: media_generate makes images/video/voice/music/SFX on the user's own keys (fal.ai, Google, OpenAI, ElevenLabs) into ./takes/; check keys and search models with media_models; if a key is missing, ask the user and store it with media_set_key, or produce the asset locally (Blender, speak_local). Combine with Blender: render a still in Blender, then pass it as a reference to an image-to-video model (end_image for a last frame); add music/voice to renders with ffmpeg. Review videos with media_frames.",
      "Media cost and failures: before paid work run media_estimate and tell the user the price and who pays (null = unknown, say so); OH_SPEND_CAP_USD caps spend per day. Generic parameters are snapped to each model's real fields; report the adjustments line, and an 'incompatible: X' error means the model can't do X (pick another or drop it, tell the user). Failed jobs carry category + hint: capacity/outage are already retried and route:'auto' falls back between fal and Google for Veo/Nano Banana when the request was not accepted; moderation allows one reworded retry and never lowering safety settings; billing means tell the user which key/plan is empty and offer a cheaper or local route. If jobs_wait flags unusuallySlow/stalled, stop polling and offer keep waiting / switch model / cancel. media_assemble renders a declarative edit recipe (clips with in/out, overlapping transitions, J/L cuts, music ducking, loudness target) and writes <out>.edit.json; run plan_validate first. render_finalize turns a rendered frame folder into one verified video (frame count, size, duration, full decode) before frames are deleted. For anything that takes over a minute use jobs_run (detached, tracked, exit code kept) or jobs_watch (poll a command until a pattern matches) and check with jobs_local_status/jobs_local_wait instead of polling in the foreground. jobs_status {collect:true} re-fetches accepted jobs after a restart or failed download; media_provenance {path} shows how any take was made.",
    ].join("\n"),
  },
);

installResultBounds(server);
registerBlenderTools(server);
registerBlenderDiagnostics(server);
registerBlenderLook(server);
registerMediaTools(server);
registerAssembleTools(server);
registerFinalizeTools(server);
registerLocalJobTools(server);
registerReferenceTools(server);
registerWatchTools(server);
registerEffectCraftTools(server);
registerQualityTools(server);
registerAssetTools(server);
registerProjectTools(server);
registerGoalTools(server);
registerCaseStudyTools(server);
registerFigmaTools(server);

await server.connect(new StdioServerTransport());

import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Open Herness composer context: the project's brand state and the apps the "@" picker offers.

export const OpenHernessComposerContextInput = Schema.Struct({
  cwd: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export type OpenHernessComposerContextInput = typeof OpenHernessComposerContextInput.Type;

export const OpenHernessBrandStatus = Schema.Struct({
  state: Schema.Literals(["active", "choose", "none"]),
  name: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  /** False when this thread switched the brand block off. */
  enabled: Schema.Boolean,
  /** Capture folders under brand/. */
  choices: Schema.Array(Schema.String),
  /** Size of the block the agent gets, for the chip's tooltip. */
  blockChars: Schema.optional(Schema.Number),
});
export type OpenHernessBrandStatus = typeof OpenHernessBrandStatus.Type;

export const OpenHernessAppAvailabilityEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["desktop", "framework", "service"]),
  use: Schema.String,
  status: Schema.Literals(["ready", "installed", "configured", "on-demand", "not-installed"]),
  skill: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type OpenHernessAppAvailabilityEntry = typeof OpenHernessAppAvailabilityEntry.Type;

export const OpenHernessComposerContextResult = Schema.Struct({
  brand: OpenHernessBrandStatus,
  apps: Schema.Array(OpenHernessAppAvailabilityEntry),
});
export type OpenHernessComposerContextResult = typeof OpenHernessComposerContextResult.Type;

export const OpenHernessSetBrandContextInput = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
});
export type OpenHernessSetBrandContextInput = typeof OpenHernessSetBrandContextInput.Type;

export const OpenHernessSetBrandContextResult = Schema.Struct({
  enabled: Schema.Boolean,
});
export type OpenHernessSetBrandContextResult = typeof OpenHernessSetBrandContextResult.Type;

export class OpenHernessComposerContextError extends Schema.TaggedError<OpenHernessComposerContextError>()(
  "OpenHernessComposerContextError",
  { message: Schema.String },
) {}

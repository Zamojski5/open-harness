import type {
  OpenHernessComposerContextInput,
  OpenHernessComposerContextResult,
} from "@t3tools/contracts";

import { listAppAvailability } from "./appContext.ts";
import { isBrandContextEnabled, resolveBrand } from "./brandContext.ts";

/** What the composer shows: the brand chip state and the "@" picker's apps. */
export async function openHernessComposerContext(
  input: OpenHernessComposerContextInput,
): Promise<OpenHernessComposerContextResult> {
  const brand = await resolveBrand(input.cwd);
  return {
    brand: {
      state: brand.state,
      ...(brand.name === undefined ? {} : { name: brand.name }),
      ...(brand.source === undefined ? {} : { source: brand.source }),
      enabled: isBrandContextEnabled(input.threadId),
      choices: [...brand.choices],
      ...(brand.block === undefined ? {} : { blockChars: brand.block.length }),
    },
    apps: listAppAvailability(input.cwd),
  };
}

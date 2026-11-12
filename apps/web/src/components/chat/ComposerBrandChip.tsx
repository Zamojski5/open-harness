import type { EnvironmentId, OpenHernessBrandStatus, ThreadId } from "@t3tools/contracts";
import { PaletteIcon } from "lucide-react";
import { memo, useState } from "react";

import { openHernessSetBrandContext } from "~/state/openHerness";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** What the brand chip shows; null hides it. Exported for tests. */
export function brandChipPresentation(
  brand: OpenHernessBrandStatus | null | undefined,
  enabledOverride?: boolean,
): { label: string; tooltip: string; toggle: boolean; active: boolean } | null {
  if (!brand || brand.state === "none") return null;
  if (brand.state === "choose") {
    return {
      label: "Choose brand",
      tooltip: `This project has several brands (${brand.choices.join(", ")}) and none is chosen, so the agent gets no brand. Ask the agent to use one, or write its folder name into brand/ACTIVE.`,
      toggle: false,
      active: false,
    };
  }
  const name = brand.name ?? "Brand";
  const enabled = enabledOverride ?? brand.enabled;
  return enabled
    ? {
        label: `Brand: ${name}`,
        tooltip: `The agent gets a short ${name} brand summary (palette, fonts, logos, voice) with every message, from ${brand.source ?? "brand/"}. Click to turn it off for this thread.`,
        toggle: true,
        active: true,
      }
    : {
        label: "Brand off",
        tooltip: `${name} brand context is off for this thread. Click to turn it back on.`,
        toggle: true,
        active: false,
      };
}

/** Small chip beside the composer: brand context on/off for this thread, or "choose brand". */
export const ComposerBrandChip = memo(function ComposerBrandChip(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  brand: OpenHernessBrandStatus | null | undefined;
  onChanged?: () => void;
}) {
  const setBrandContext = useAtomCommand(openHernessSetBrandContext, { reportFailure: true });
  // Shows the new state right away; the next composer-context read confirms it.
  const [override, setOverride] = useState<{ threadId: ThreadId; enabled: boolean } | null>(null);
  const enabledOverride =
    override !== null && override.threadId === props.threadId ? override.enabled : undefined;
  const view = brandChipPresentation(props.brand, enabledOverride);
  if (view === null) return null;
  const toggle = async () => {
    if (!view.toggle || props.threadId === null) return;
    const threadId = props.threadId;
    const enabled = !view.active;
    setOverride({ threadId, enabled });
    const result = await setBrandContext({
      environmentId: props.environmentId,
      input: { threadId, enabled },
    });
    if (result._tag !== "Success") setOverride(null);
    props.onChanged?.();
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="compact"
            variant={view.active ? "ghost" : "ghost-muted"}
            data-composer-brand-chip={view.active ? "on" : view.toggle ? "off" : "choose"}
            aria-pressed={view.toggle ? view.active : undefined}
            disabled={view.toggle && props.threadId === null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void toggle()}
            className="max-w-48"
          >
            <PaletteIcon aria-hidden="true" className={view.active ? "" : "opacity-60"} />
            <span className="truncate">{view.label}</span>
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {view.tooltip}
      </TooltipPopup>
    </Tooltip>
  );
});

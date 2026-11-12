import { formatOpenHernessAppReference } from "@t3tools/shared/openHernessApps";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { composerAppItems } from "./useComposerMenuItems";

const APPS = [
  { id: "blender", name: "Blender", kind: "desktop", use: "3D scenes", status: "ready" },
  {
    id: "davinci-resolve",
    name: "DaVinci Resolve",
    kind: "desktop",
    use: "editing, colour",
    status: "not-installed",
  },
  {
    id: "mcp-linear",
    name: "linear",
    kind: "service",
    use: "MCP tool server",
    status: "configured",
  },
] as const;

function Menu(props: {
  items: ComposerCommandItem[];
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const [active, setActive] = useState<string | null>(props.items[0]?.id ?? null);
  return (
    <ComposerCommandMenu
      listId="suggestions"
      items={props.items}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="path"
      activeItemId={active}
      onHighlightedItemChange={setActive}
      onSelect={props.onSelect}
    />
  );
}

describe("@ app picker", () => {
  it("lists matching apps with their status and selects one", async () => {
    const onSelect = vi.fn();
    const items = composerAppItems(APPS, "");
    expect(items.map((item) => item.label)).toEqual(["Blender", "linear", "DaVinci Resolve"]);
    await using screen = await render(<Menu items={items} onSelect={onSelect} />, {
      router: false,
    });
    const listbox = screen.getByRole("listbox", { name: "Files, folders and apps" });
    await expect.element(listbox).toBeVisible();
    await expect.element(screen.getByText("ready · 3D scenes")).toBeVisible();
    await expect.element(screen.getByText("not installed · editing, colour")).toBeVisible();
    await userEvent.click(screen.getByText("DaVinci Resolve"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ type: "app", appId: "davinci-resolve", status: "not-installed" }),
    );
  });

  it("narrows by the query", () => {
    expect(composerAppItems(APPS, "lin").map((item) => item.appId)).toEqual(["mcp-linear"]);
    expect(composerAppItems(APPS, "zz")).toEqual([]);
  });

  it("shows a picked app as an app chip in the composer", async () => {
    const value = `cut the trailer ${formatOpenHernessAppReference({ id: "davinci-resolve", name: "DaVinci Resolve" })} `;
    await using screen = await render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
      { router: false },
    );
    await expect.element(screen.getByLabelText("App, DaVinci Resolve")).toBeVisible();
    expect(screen.container.querySelector("[data-context-unresolved]")).toBeNull();
  });
});

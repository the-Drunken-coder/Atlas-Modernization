import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { countsByKind } from "../../atlas/selectors.js";
import { storySnapshot } from "../../storybook/fixtures.js";
import { SidebarRail } from "./SidebarRail.js";
import { SidebarPanel } from "./SidebarPanel.js";
import { AppShell } from "./AppShell.js";

const meta = {
  title: "UI/Layout/App Shell",
  component: AppShell,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
  args: { collapsed: false, rail: null, panel: null, map: null },
  render: () => <ShellStory initialCollapsed={false} />
};

export const CollapsedToRail: Story = {
  args: { collapsed: true, rail: null, panel: null, map: null },
  render: () => <ShellStory initialCollapsed />
};

function ShellStory({ initialCollapsed }: { initialCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [activeList, setActiveList] = useState<"assets" | "tracks" | "geofeatures" | "commands">("assets");
  return (
    <div className="sb-atlas-root">
      <AppShell
        collapsed={collapsed}
        rail={
          <SidebarRail
            collapsed={collapsed}
            activeList={activeList}
            counts={countsByKind(storySnapshot)}
            onSelectList={setActiveList}
            onToggleCollapsed={() => setCollapsed((value) => !value)}
          />
        }
        panel={
          <SidebarPanel title="Assets" onCollapse={() => setCollapsed(true)}>
            <div className="panel__empty">Panel content lives here.</div>
          </SidebarPanel>
        }
        map={
          <div className="fallback-map">
            <span className="fallback-map__badge">Map workspace</span>
          </div>
        }
      />
    </div>
  );
}

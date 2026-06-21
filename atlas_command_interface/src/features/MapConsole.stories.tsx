import type { Meta, StoryObj } from "@storybook/react-vite";
import { AtlasStaticProvider } from "../state/atlas-context.js";
import { makeStoryAtlasValue } from "../storybook/fixtures.js";
import { MapConsole } from "./MapConsole.js";

const meta = {
  title: "Features/Map Console",
  component: MapConsole,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof MapConsole>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveOperationalState: Story = {
  render: () => (
    <AtlasStaticProvider value={makeStoryAtlasValue()}>
      <MapConsole />
    </AtlasStaticProvider>
  )
};

export const Reconnecting: Story = {
  render: () => (
    <AtlasStaticProvider value={makeStoryAtlasValue({ health: { running: true, healthy: false, degraded: true } })}>
      <MapConsole />
    </AtlasStaticProvider>
  )
};

export const ConnectionError: Story = {
  render: () => (
    <AtlasStaticProvider
      value={makeStoryAtlasValue({
        status: "error",
        error: "Atlas Core is not reachable at /atlas"
      })}
    >
      <MapConsole />
    </AtlasStaticProvider>
  )
};

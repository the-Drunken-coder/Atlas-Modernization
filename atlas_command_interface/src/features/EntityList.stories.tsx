import type { Meta, StoryObj } from "@storybook/react-vite";
import { storyAssets, storyGeofeatures, storyTracks } from "../storybook/fixtures.js";
import { EntityList } from "./EntityList.js";

const meta = {
  title: "Features/Entity List",
  component: EntityList,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="sb-atlas-workbench">
        <div className="sb-atlas-panel">
          <Story />
        </div>
      </div>
    )
  ]
} satisfies Meta<typeof EntityList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Assets: Story = {
  args: {
    entities: storyAssets,
    selectedId: storyAssets[0].entity_id,
    emptyLabel: "No assets yet",
    onSelect: console.info
  }
};

export const Tracks: Story = {
  args: {
    entities: storyTracks,
    selectedId: storyTracks[0].entity_id,
    emptyLabel: "No tracks yet",
    onSelect: console.info
  }
};

export const GeoFeatures: Story = {
  args: {
    entities: storyGeofeatures,
    selectedId: storyGeofeatures[0].entity_id,
    emptyLabel: "No geo features yet",
    onSelect: console.info
  }
};

export const Empty: Story = {
  args: {
    entities: [],
    emptyLabel: "No assets yet",
    onSelect: console.info
  }
};

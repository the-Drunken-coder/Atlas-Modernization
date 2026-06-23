import type { Meta, StoryObj } from "@storybook/react-vite";
import { buildMapSources } from "./map-sources.js";
import { MapView } from "./MapView.js";
import { storyEntities, storyGeofeatures } from "../../storybook/fixtures.js";
import { entityGeometry } from "../../atlas/entities.js";

const meta = {
  title: "UI/Map/Map View",
  component: MapView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="sb-atlas-workbench">
        <div className="sb-atlas-map-frame">
          <Story />
        </div>
      </div>
    )
  ]
} satisfies Meta<typeof MapView>;

export default meta;
type Story = StoryObj<typeof meta>;

const editingGeometry = entityGeometry(storyGeofeatures[0]);
if (!editingGeometry) throw new Error("EditingPolygon story requires a geofeature with geometry");

export const TacticalPicture: Story = {
  args: {
    sources: buildMapSources(storyEntities, "asset-summit-01"),
    selectedId: "asset-summit-01",
    initialCenter: [-77.0366, 38.9037],
    onSelectEntity: console.info,
    onMapContextMenu: console.info,
    onBackgroundClick: console.info
  }
};

export const EditingPolygon: Story = {
  args: {
    sources: buildMapSources(storyEntities, "geo-area-alpha"),
    selectedId: "geo-area-alpha",
    initialCenter: [-77.0366, 38.9037],
    editing: {
      geometry: editingGeometry,
      onChange: console.info
    },
    onSelectEntity: console.info,
    onMapContextMenu: console.info,
    onBackgroundClick: console.info
  }
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { storyAssets, storyCommandCatalog, storyGeofeatures, storySnapshot, storyTracks } from "../storybook/fixtures.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { entityGeometry } from "../atlas/entities.js";
import { AssetInspector } from "./assets/AssetInspector.js";
import { GeofeatureInspector } from "./geofeatures/GeofeatureInspector.js";
import { TrackInspector } from "./tracks/TrackInspector.js";

const meta = {
  title: "Features/Inspectors",
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="sb-atlas-workbench">
        <div className="sb-atlas-row">
          <Story />
        </div>
      </div>
    )
  ]
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Asset: Story = {
  render: () => (
    <div className="sb-atlas-panel">
      <AssetInspector entity={storyAssets[0]} snapshot={storySnapshot} catalog={storyCommandCatalog} onPickCommand={console.info} />
    </div>
  )
};

export const Track: Story = {
  render: () => (
    <div className="sb-atlas-panel">
      <TrackInspector entity={storyTracks[0]} />
    </div>
  )
};

export const GeoFeatureReadonly: Story = {
  render: () => (
    <div className="sb-atlas-panel">
      <GeofeatureInspector
        entity={storyGeofeatures[0]}
        editing={false}
        saving={false}
        onStartEdit={console.info}
        onChangeDraft={console.info}
        onSave={console.info}
        onCancel={console.info}
      />
    </div>
  )
};

export const GeoFeatureEditing: Story = {
  render: () => <EditingGeofeatureStory />
};

function EditingGeofeatureStory() {
  const entity = storyGeofeatures[0];
  const [draft, setDraft] = useState<UiGeometry | undefined>(() => entityGeometry(entity));
  return (
    <div className="sb-atlas-panel">
      <GeofeatureInspector
        entity={entity}
        editing
        draft={draft}
        saving={false}
        onStartEdit={console.info}
        onChangeDraft={setDraft}
        onSave={console.info}
        onCancel={console.info}
      />
    </div>
  );
}

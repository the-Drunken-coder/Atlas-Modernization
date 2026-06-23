import type { Meta, StoryObj } from "@storybook/react-vite";
import { JsonDrawer } from "./JsonDrawer.js";
import { Button, IconButton, SelectField, TextField } from "./controls.js";
import { CopyIcon, GeofeaturesIcon, TracksIcon } from "./icons.js";
import { ClassificationPill, LinkStatePill, StatusPill, TaskStatusPill } from "./StatusPill.js";

const meta = {
  title: "UI/Primitives",
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="sb-atlas-workbench">
        <Story />
      </div>
    )
  ]
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ButtonsAndFields: Story = {
  render: () => (
    <div className="sb-atlas-stack" style={{ maxWidth: 420 }}>
      <div className="sb-atlas-row">
        <Button>Default</Button>
        <Button variant="primary">Primary</Button>
        <Button variant="ghost">Ghost</Button>
        <IconButton label="Copy">
          <CopyIcon size={16} />
        </IconButton>
      </div>
      <TextField label="Callsign" defaultValue="Summit Rover 01" />
      <TextField label="Telemetry channel" mono defaultValue="atlas.feed.asset-summit-01" />
      <SelectField
        label="Layer"
        defaultValue="assets"
        options={[
          { value: "assets", label: "Assets" },
          { value: "tracks", label: "Tracks" },
          { value: "geofeatures", label: "Geo Features" }
        ]}
      />
    </div>
  )
};

export const StatusEncoding: Story = {
  render: () => (
    <div className="sb-atlas-stack">
      <div className="sb-atlas-row">
        <LinkStatePill state="connected" />
        <LinkStatePill state="degraded" />
        <LinkStatePill state="disconnected" />
        <ClassificationPill value="friendly" />
        <ClassificationPill value="hostile" />
        <ClassificationPill value="unknown" />
      </div>
      <div className="sb-atlas-row">
        <TaskStatusPill status="pending" />
        <TaskStatusPill status="acknowledged" />
        <TaskStatusPill status="completed" />
        <TaskStatusPill status="failed" />
        <StatusPill label="To Be Determined" color="var(--text-3)" />
      </div>
    </div>
  )
};

export const Icons: Story = {
  render: () => (
    <div className="sb-atlas-row">
      <IconButton label="Tracks">
        <TracksIcon size={18} />
      </IconButton>
      <IconButton label="Geo Features">
        <GeofeaturesIcon size={18} />
      </IconButton>
      <IconButton label="Copy">
        <CopyIcon size={18} />
      </IconButton>
    </div>
  )
};

export const DebugDrawer: Story = {
  render: () => (
    <div className="sb-atlas-panel" style={{ padding: 12 }}>
      <JsonDrawer
        defaultOpen
        value={{
          entity_id: "asset-summit-01",
          status: "on_task",
          telemetry: { latitude: 38.9037, longitude: -77.0366 },
          debug: { source: "storybook fixture" }
        }}
      />
    </div>
  )
};

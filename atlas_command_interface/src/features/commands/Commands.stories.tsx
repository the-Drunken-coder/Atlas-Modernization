import type { Meta, StoryObj } from "@storybook/react-vite";
import { commandsForTargeting } from "../../atlas/command-targeting.js";
import { storyAssets, storyCommandCatalog } from "../../storybook/fixtures.js";
import { CommandForm } from "./CommandForm.js";
import { CommandList } from "./CommandList.js";

const meta = {
  title: "Features/Commands",
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

const selectedAsset = storyAssets[0];
if (!selectedAsset) throw new Error("Commands stories require at least one asset fixture");

const sidebarCommands = commandsForTargeting(storyCommandCatalog, selectedAsset, "none");
const mapCommand = commandsForTargeting(storyCommandCatalog, selectedAsset, "map_point")[0];
const formCommand = sidebarCommands.find((entry) => entry.command.id === "set_mode") ?? sidebarCommands[0];
if (!mapCommand) throw new Error("Commands stories require a map-point command fixture");
if (!formCommand) throw new Error("Commands stories require a sidebar command fixture");

export const SidebarCommandList: Story = {
  render: () => (
    <div className="sb-atlas-panel" style={{ padding: 12 }}>
      <CommandList availabilities={sidebarCommands} onPick={console.info} />
    </div>
  )
};

export const PositionCommandForm: Story = {
  render: () => (
    <div className="sb-atlas-modal-frame">
      <CommandForm
        command={mapCommand.command}
        targeting={mapCommand.targeting}
        formParameters={mapCommand.formParameters}
        mapPoint={{ lat: 38.95523, lng: -77.02881 }}
        credential="storybook-key"
        submitting={false}
        onCredentialChange={console.info}
        onCancel={console.info}
        onSubmit={console.info}
      />
    </div>
  )
};

export const ParameterCommandForm: Story = {
  render: () => (
    <div className="sb-atlas-modal-frame">
      <CommandForm
        command={formCommand.command}
        targeting={formCommand.targeting}
        formParameters={formCommand.formParameters}
        credential=""
        submitting={false}
        error="Command API key is required."
        onCredentialChange={console.info}
        onCancel={console.info}
        onSubmit={console.info}
      />
    </div>
  )
};

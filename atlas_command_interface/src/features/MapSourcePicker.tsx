import type { MapSourceConfig } from "../app/config.js";
import { SelectField } from "../ui/primitives/controls.js";

/** Map overlay picker listing the configured map sources; unavailable ones are disabled. */
export function MapSourcePicker({
  sources,
  value,
  onChange
}: {
  sources: MapSourceConfig[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="map-overlay-tr map-source-control">
      <SelectField
        label="Map"
        value={value}
        options={sources.map((source) => ({
          label: source.unavailableReason ? `${source.label} (${source.unavailableReason})` : source.label,
          value: source.id,
          disabled: !source.style
        }))}
        onChange={(event) => {
          const source = sources.find((entry) => entry.id === event.currentTarget.value);
          if (source?.style) onChange(source.id);
        }}
      />
    </div>
  );
}

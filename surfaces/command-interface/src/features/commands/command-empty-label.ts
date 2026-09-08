import type { CommandCatalog, EntityResource } from "@the-drunken-coder/atlas-sdk";
import type { CommandManifestStatus } from "../assets/AssetInspector.js";

/** Explain an empty command list without changing the caller's targeting filter. */
export function commandEmptyLabel(
  catalog: CommandCatalog | undefined,
  manifest: EntityResource["command_manifest"],
  status: CommandManifestStatus
): string {
  if (!catalog) return "Command Catalog unavailable";
  if (catalog.length === 0) return "No Commands are defined in Atlas Protocol";
  if (status === "loading") return "Loading Asset Commands";
  if (status === "unavailable") return "Asset Commands unavailable";
  if (!manifest?.length) return "This Asset has no Commands";
  return "No operator inputs are available for this Asset's Commands";
}

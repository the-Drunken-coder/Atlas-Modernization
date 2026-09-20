// Tests exercise a release-shaped package. Checked-in source metadata remains explicitly unreleased.
export const PACKAGE_NAME = "atlas-core";
export const PACKAGE_VERSION = "0.2.1";
export const PACKAGE_IMAGE: string | undefined =
  "ghcr.io/the-drunken-coder/atlas-core@sha256:339280ff27c5879838898278ef2f51b3bdfe5ace493a81d623cb3c3e3f62e0f9";
export const PACKAGE_PLUGIN_CONTRACTS = {
  coreToPluginProtocolMajors: [1],
  pluginToSourceGatewayProtocolMajors: [1],
  atlasProtocolRevision: "sha256:a1c6465a21b2962e7ff955a3ef6f2ac6bfc37ca74de787c7ceb1ae1ee58aca94",
  supportedPackageSchemaMajors: [1],
  supportedInteractions: ["map_area"]
} as const;

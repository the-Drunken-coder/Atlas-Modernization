// Tests exercise a release-shaped package. Checked-in source metadata remains explicitly unreleased.
export const PACKAGE_NAME = "atlas-core";
export const PACKAGE_VERSION = "0.2.1";
export const PACKAGE_IMAGE: string | undefined =
  "ghcr.io/the-drunken-coder/atlas-core@sha256:339280ff27c5879838898278ef2f51b3bdfe5ace493a81d623cb3c3e3f62e0f9";
export const PACKAGE_PLUGIN_CONTRACTS = {
  coreToPluginProtocolMajors: [1],
  pluginToSourceGatewayProtocolMajors: [1],
  atlasProtocolRevision: "sha256:90dc0125b5ff56f8645eee6a6829a0135962f868adc4c641fef24aa3835a4a2b",
  supportedPackageSchemaMajors: [1],
  supportedInteractions: ["map_area"]
} as const;

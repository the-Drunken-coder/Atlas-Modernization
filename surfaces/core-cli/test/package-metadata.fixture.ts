// Tests exercise a release-shaped package. Checked-in source metadata remains explicitly unreleased.
export const PACKAGE_NAME = "atlas-core";
export const PACKAGE_VERSION = "0.2.1";
export const PACKAGE_IMAGE: string | undefined =
  "ghcr.io/the-drunken-coder/atlas-core@sha256:339280ff27c5879838898278ef2f51b3bdfe5ace493a81d623cb3c3e3f62e0f9";
export const PACKAGE_PLUGIN_CONTRACTS = {
  coreToPluginProtocolMajors: [1],
  pluginToSourceGatewayProtocolMajors: [1],
  atlasProtocolRevision: "sha256:6cb482d1c7f2344d88c3eff5a828653fd6a52743afb2177b3c44da17fb82b518",
  supportedPackageSchemaMajors: [1],
  supportedInteractions: ["map_area"]
} as const;

import type { CommandInputRegistry } from "../../../../surfaces/command-interface/src/features/commands/command-input-registry.tsx";

/** Build-only input for the canonical queued conformance Command. */
export const COMMAND_INPUT_REGISTRY = {
  "fixture.queued": {
    targeting: "none",
    buildInput: () => ({ value: "browser-command-fixture" })
  }
} satisfies CommandInputRegistry;

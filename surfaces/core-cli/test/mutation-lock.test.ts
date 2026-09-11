import { describe, expect, it } from "vitest";
import { isMutationLockOwner, isMutationOwnerActive, type MutationLockOwner } from "../src/application.js";
import { createOwnerIdentity } from "../src/deployment-transaction.js";

describe("mutation lock ownership", () => {
  it("accepts a deployment owner with the complete boot and process identity", () => {
    const owner = deploymentOwner(createOwnerIdentity("engine-1"));

    expect(isMutationLockOwner(owner)).toBe(true);
    expect(isMutationOwnerActive(owner)).toBe(true);
  });

  it("treats an incomplete identity as active and therefore unreclaimable", () => {
    const owner = deploymentOwner({
      pid: 2_147_483_647,
      bootIdentity: "boot-1",
      processStartIdentity: undefined,
      dockerEngineId: "engine-1"
    });

    expect(isMutationLockOwner(owner)).toBe(false);
    expect(isMutationOwnerActive(owner as MutationLockOwner)).toBe(true);
  });

  it("reclaims only a provably dead owner while preserving legacy Plugin-disable records", () => {
    const deadOwner = deploymentOwner({
      pid: 2_147_483_647,
      bootIdentity: "boot-1",
      processStartIdentity: "process-1",
      dockerEngineId: "engine-1"
    });
    const legacyPluginOwner: MutationLockOwner = {
      schema: 1,
      id: "a".repeat(32),
      pid: 2_147_483_647,
      operation: "plugin-disable"
    };

    expect(isMutationLockOwner(deadOwner)).toBe(true);
    expect(isMutationOwnerActive(deadOwner)).toBe(false);
    expect(isMutationLockOwner(legacyPluginOwner)).toBe(true);
    expect(isMutationOwnerActive(legacyPluginOwner)).toBe(false);
  });
});

function deploymentOwner(identity: {
  pid: number;
  bootIdentity: string;
  processStartIdentity: string | undefined;
  dockerEngineId: string;
}): MutationLockOwner {
  return {
    schema: 1,
    id: "b".repeat(32),
    operation: "deployment",
    ...identity
  } as MutationLockOwner;
}

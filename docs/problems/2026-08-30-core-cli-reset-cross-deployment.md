# Problem Report

1. **Time & Date:** 2026-08-30T14:53:48Z
2. **Name:** Reset from an uninitialized home can delete another Atlas Core deployment
3. **Issue:** `atlas-core reset` treats the current Docker engine's containers and durable volumes as the selected deployment when the selected `ATLAS_CORE_HOME` has no matching state file. A fresh or mispointed configuration directory can therefore authorize deletion of the deployment owned by another configuration directory on the same engine.
4. **Severity:** S1 (Blocker)
5. **Location:** `surfaces/core-cli/src/application.ts` (`dockerDeploymentIdentity()` at lines 260-273, `AtlasCoreDeployment.reset()` at lines 834-900, and `#assertResetConfigurationMatchesRuntime()` at lines 3066-3075)
6. **Expected:** Reset must stop when the selected configuration directory does not contain a matching deployment identity. It may delete durable resources only after proving that they belong to the selected deployment, even when the operator confirms the destructive action.
7. **Actual:** Every configuration directory derives the same resource names from the current Docker engine ID. After confirmation, `reset()` calls `#assertResetConfigurationMatchesRuntime()`. That check validates directory and file permissions, but compares the Docker engine only when `state.json` parses to a state object. With no state it performs no configuration ownership check. `#reset()` then discovers resources with the expected Compose and engine labels, removes the containers and both durable volumes, and initializes a new deployment in the previously empty directory.
8. **Reproduction:**
   1. Initialize Atlas Core with `ATLAS_CORE_HOME` set to directory A against a fake Docker engine ID. Leave its engine-scoped containers and paired volumes present.
   2. Set `ATLAS_CORE_HOME` to an empty directory B while keeping the same fake Docker engine ID.
   3. In a safe fake `CommandRunner`, expose directory A's resources with the expected Compose and `io.atlas.core.engine` labels, report both volumes as used only by the expected containers, and return successful preflight and image-pull responses.
   4. Invoke `runCLI(["reset"], context)` with `confirmReset` returning `true`.
   5. Observe container and volume removal calls for directory A's deployment, followed by a new `state.json` in directory B.
9. **Notes:** PR #298 replaced the retired fixed-name layout with engine-scoped names, preventing collisions across Docker engines. It did not distinguish two configuration directories on the same engine. Initialization refuses to adopt existing resources without matching configuration, but reset still bypasses that guard when state is absent. Reverified against `cc30a42cd5bae36e26b1465d14523d62822527da` on 2026-09-03.

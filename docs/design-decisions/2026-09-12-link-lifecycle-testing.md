# One Link lifecycle owns process assembly and cleanup

Status: accepted by the developer on 2026-09-12 and implemented under issue #388.

1. **Time and date:** 2026-09-12, America/New_York
2. **Name:** One shared Link startup and shutdown module serves the production CLI and laboratory process runner
3. **Context:** The production `serve` command currently opens the serial radio, constructs every Link module, performs mode-specific configuration and joining, waits for a process signal, and tears everything down. Existing tests assemble the same modules by hand. This leaves the executable lifecycle outside the test seam required by the testing plan in issue #370.
4. **Decision:** Add one `startLinkService` function in `packages/meshtastic-link/src/lifecycle.ts`. It accepts a caller-supplied factory that returns the existing exported `MeshtasticSerialRadio`, the parsed Link inputs shared by both process callers, and the current transport options. It returns only the loopback address and one `close` operation. The production CLI supplies `MeshtasticSerialRadio.open(path)`. The laboratory runner supplies `MeshtasticSerialRadio.openTransport(transportFactory)`. The lifecycle module constructs the radio, transmission gate, profile manager, Link service, HTTP server, mode-specific join service, and Link transport. After the current pre-`try` construction window, it owns their startup and cleanup. Process callers own argument and file parsing, choosing the radio factory, reporting readiness, deciding when shutdown begins, and calling `close`.
5. **Alternatives considered:** Keeping assembly in the CLI was rejected because process tests would continue to reimplement the behavior they claim to verify. Passing a low-level Meshtastic `Types.Transport` into the lifecycle was rejected because serial versus laboratory transport selection belongs to the caller and `MeshtasticSerialRadio` already adapts both into the complete configuration and Link radio behavior. A new generic radio or lifecycle framework was rejected because both required callers already produce the same `MeshtasticSerialRadio`. Passing `LinkService`, `LinkHTTPServer`, joins, transports, clocks, or callbacks through the public interface was rejected because neither caller needs them. Folding signal handlers into the module was rejected because the module owns how shutdown happens, while each process caller owns when to request it.
6. **Consequences:** Startup and cleanup become callable through one small interface. The production CLI keeps its macOS serial path, file checks, defaults, output, signal behavior, startup ordering, and error precedence. The laboratory process can use an ephemeral loopback port and the production Meshtastic device protocol without opening USB. It still cannot establish physical RF, real serial framing, relay, firmware, or expanded platform support. Each caller invokes `close` once. The proposal adds no repeated or concurrent close guarantee and makes no product-defect repair.
7. **Location:** Production files are `packages/meshtastic-link/src/lifecycle.ts`, `packages/meshtastic-link/src/cli.ts`, and the package export and focused test files. Issues #389 and #390 own the laboratory transport, compiled process runner, process acceptance, artifacts, and dedicated workflow.

## Reviewed source

This proposal uses checkout `4c454498` on `codex/test-388-link-design` as implementation truth.

- [`cli.ts`](../../packages/meshtastic-link/src/cli.ts) lines 111 through 254 currently own the entire production lifecycle. Common argument checks and profile and key-file validation happen before the radio opens. The Gateway membership requirement happens after HTTP starts. Gateway and Asset assembly then diverge, and cleanup runs after signal completion or startup failure.
- [`radio.ts`](../../packages/meshtastic-link/src/radio.ts) lines 86 through 100 define the existing Link radio and transmission-gate interfaces. Lines 301 through 333 expose both `MeshtasticSerialRadio.open(path)` and `openTransport(factory)`. Both paths use the same Meshtastic SDK device protocol. Lines 657 through 669 reject pending sends and close the owned transport and device.
- [`profile.ts`](../../packages/meshtastic-link/src/profile.ts) lines 98 through 110 define the existing configuration adapter and membership input. Lines 161 through 186 implement the distinct Asset and Gateway preparation paths.
- [`joining.ts`](../../packages/meshtastic-link/src/joining.ts) lines 158 through 188 and 384 through 456 show that each join service owns packet subscriptions and drains active join work during `close`.
- [`service.ts`](../../packages/meshtastic-link/src/service.ts) lines 393 through 414 stop the Task dispatcher, timers, subscriptions, Link transport, and transmission gate. Lines 639 through 676 own the loopback HTTP listener and its client cleanup.
- The accepted [service interface](../atlas-meshtastic-link/service-interface.md) says one Link service exclusively owns the radio and Shared Picture. The accepted [radio configuration contract](../atlas-meshtastic-link/radio-configuration.md) requires profile convergence before discovery or Gateway operation and requires Asset membership to be cleared on every start.

## Exact proposed interface

```ts
import type { FrameEncoding } from "./frame.js";
import type { AssetAuthenticationPolicy, GatewayAuthenticationPolicy } from "./joining.js";
import type { RadioProfile } from "./profile.js";
import type { MeshtasticSerialRadio } from "./radio.js";

type CommonStartLinkServiceOptions = {
  nodeID: string;
  profile: RadioProfile;
  openRadio: () => Promise<MeshtasticSerialRadio>;
  port?: number;
  frameEncoding?: FrameEncoding;
  adaptiveRetries?: boolean;
  stateDeltas?: boolean;
};

export type StartLinkServiceOptions =
  | (CommonStartLinkServiceOptions & {
      mode: "asset";
      authentication: AssetAuthenticationPolicy;
    })
  | (CommonStartLinkServiceOptions & {
      mode: "gateway";
      authentication: GatewayAuthenticationPolicy;
      membershipPath?: string;
    });

export type RunningLinkService = {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
};

export function startLinkService(options: StartLinkServiceOptions): Promise<RunningLinkService>;
```

The production defaults remain inside the shared lifecycle: port `7331`, `canonical-json`, adaptive retries off, state deltas off, a `RealClock`, loopback host `127.0.0.1`, and transport retry jitter of 1,000 milliseconds. The CLI keeps its current string validation and error text. The laboratory runner passes port `0` to obtain an isolated listener.

`membershipPath` stays optional at the type level so the extracted module can preserve one odd but observable part of the current CLI order. Gateway `--membership` is currently required only after the radio and HTTP listener start. The CLI passes its parsed optional value, and the lifecycle raises the existing `--membership is required` error at the first Gateway-specific step. Moving that check before radio open would be sensible, but it would change failure ordering and is not part of this proposal.

The radio factory returns the existing concrete adapter instead of introducing another radio interface. Startup needs all three capabilities that adapter already combines: `LinkRadio`, `RadioConfigurationAdapter`, and `nodeNumber()`. `SimulatedRadio` is intentionally insufficient because it bypasses the Meshtastic device configuration and readback path required by issues #389 and #390.

The return value does not expose the `LinkService`, Shared Picture, join services, transport, HTTP server, radio, clock, or membership store. Process acceptance observes status, publications, confirmations, and failure through the same loopback HTTP interface available to a real Link client.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| Production CLI | Parse the current arguments, read and validate the profile and protected join-key file, construct the selected authentication policy, choose `MeshtasticSerialRadio.open(serialPath)`, print the existing readiness JSON, wait for `SIGINT` or `SIGTERM`, and call `close`. The shared lifecycle preserves the current late Gateway membership requirement. |
| Laboratory process runner | Create its test-owned `Types.Transport`, construct the production authentication policy, choose `MeshtasticSerialRadio.openTransport(transportFactory)`, print machine-readable readiness and artifact metadata, wait for its controller or process signal, and call `close`. |
| Shared lifecycle module | Invoke the radio factory, assemble all Link modules, preserve the current constructor window, bind loopback HTTP, perform the selected mode's startup, return readiness, and perform the current ordered cleanup after that window. |
| `MeshtasticSerialRadio` | Run the Meshtastic SDK device protocol, configuration exchange, packet conversion, queue-status settlement, reconnect behavior, and closure of its physical or laboratory transport. |
| `LinkService` | Own the Shared Picture, local operations, Task dispatcher, subscription state, transport attachment, service status, and internal stop behavior. |
| `GatewayMembershipStore` | Load and update the Gateway membership record and source generation at the existing filesystem path. |

If `openRadio` rejects, the factory owns partial-open cleanup. Both approved creation paths provide that behavior through `MeshtasticSerialRadio.openTransport`, which the physical `open(path)` path also delegates to. The current constructor window begins after the factory resolves and ends when the shared startup `try` begins. Once startup succeeds, callers must not send through or close the radio directly.

## Startup order

The extraction preserves the current order. This is part of the interface because callers and failure tests need to know when HTTP is reachable and what a successful start means.

### Common startup

1. The caller parses the mode, node ID, transport options, and optional membership value, then validates the profile and reads the protected join-key file. It constructs the authentication policy. The production radio factory retains the current serial required-option and `/dev/cu.*` checks when invoked.
2. `startLinkService` creates one `RealClock`, then invokes `openRadio`. For production this resolves the required serial argument, checks the `/dev/cu.*` path, and opens the real serial transport. For the laboratory runner this opens the supplied stream transport. Both paths configure the Meshtastic SDK connection before resolving.
3. The lifecycle creates one `LinkRadioGate`, `RadioProfileManager`, `LinkService`, and `LinkHTTPServer`. The extraction preserves the current pre-`try` constructor window described below.
4. The shared startup `try` begins. The HTTP server listens on `127.0.0.1` before radio-profile preparation. The service status therefore begins as `configuring`, matching current behavior.
5. The lifecycle follows exactly one mode-specific branch.

### Gateway startup

1. Require `membershipPath` with the existing `--membership is required` error, then construct `GatewayMembershipStore` and load the durable record.
2. Reject a membership whose Gateway node ID differs from `nodeID`.
3. Preflight the encoded join acceptance against the current native PKI payload budget.
4. Call `RadioProfileManager.prepareGateway`. This applies and verifies the static profile, then installs and verifies the durable private membership.
5. Call `activateGateway` to advance the durable Gateway generation.
6. Construct `LinkTransport` with that generation, the Link service session and Shared Picture, the gated radio, the selected transport options, and the active private channel.
7. Attach the transport to `LinkService`. This activates the service and creates its ordered Task dispatcher.
8. Construct `GatewayJoinService` so it can admit Assets and announce admitted source generations through the attached transport.
9. Resolve `startLinkService` with the listening address. A resolved Gateway start means the profile and membership were verified, the transport is active, and the join listener is installed.

### Asset startup

1. Call `RadioProfileManager.prepareAssetForJoin`. This applies and verifies the static profile, clears all prior private memberships, and verifies they are absent.
2. Set the service lifecycle to `discovering`.
3. Read the local radio node number and construct `AssetJoinService` with the service session, public rendezvous channel, authentication policy, and membership installer.
4. Start discovery. The join service sends asynchronously and keeps its existing timed retry behavior.
5. Resolve `startLinkService` with the listening address. A resolved Asset start means configuration and membership clearing succeeded and discovery started. It does not mean authenticated joining finished.
6. When the existing join callback reports `joined`, construct and attach the Asset `LinkTransport` once, using the accepted source generation and Gateway node. That transition changes service status to `active`.

Join attempts that fail after Asset startup remain asynchronous. They keep the service in `discovering` with the current deferred-attempt detail and retry policy. They do not reject the already resolved start call. A later physical or laboratory radio disconnect keeps the current error-status behavior.

## Shutdown order

The process caller decides when to shut down. Both callers wait for `SIGINT` or `SIGTERM` in their own process code and then invoke the same `RunningLinkService.close` operation. The acceptance controller may also end a laboratory process through that signal path.

`close` performs the current cleanup sequence and attempts every applicable step even when an earlier step fails:

1. Call `LinkService.stop`. This closes the Task dispatcher, cancels service timers, clears subscriptions, stops the attached transport, fails pending transport work according to its current rules, and aborts the radio gate.
2. Close the Asset join service when present. It unsubscribes, cancels retries, and waits for active join work to settle.
3. Close the Gateway join service when present. It unsubscribes, clears transient admission state, and waits for active admission work to settle.
4. Close the HTTP server when it successfully listened. This disconnects local client state, closes SSE and HTTP connections, and releases the loopback port.
5. Close the gated radio. This rejects pending sends and closes the underlying serial or laboratory transport and Meshtastic device.

Each process caller invokes `close` once. The extracted function does not promise behavior for repeated or concurrent calls. That keeps the proposal within the CLI's current one-shot shutdown behavior.

## Failure cleanup and errors

Once the lifecycle enters the current startup `try` block, a failure first records the service's `error` lifecycle without allowing a faulty status listener to replace the startup error. It then runs the same ordered cleanup and rejects with the original startup error.

This proposal preserves the current primary-error rule. Cleanup errors do not replace a startup error. When normal `close` has no prior startup error, it attempts all steps and rejects with an `AggregateError` if one or more cleanup steps fail. The refactor does not add logging, change error text, attach suppressed errors, or repair any cleanup behavior found by later acceptance.

Failure before `openRadio` resolves leaves no object for the shared lifecycle to close. `MeshtasticSerialRadio.openTransport` already disconnects its partially configured transport and device before rethrowing its configuration error. A different factory is outside this accepted interface.

Gateway activation retains its present durable ordering. If a later step fails after `activateGateway`, cleanup does not roll back the advanced source generation. Asset preparation retains its present destructive ordering for stale private membership. This refactor must not add rollback or a second startup path.

### Existing constructor window remains outside this refactor

Current `cli.ts` opens the radio and constructs `LinkRadioGate`, `RadioProfileManager`, `LinkService`, and `LinkHTTPServer` before entering its `try` block. A synchronous constructor failure after the radio opens can therefore bypass the current cleanup loop. For example, `LinkService` performs its own node-ID validation in its constructor. This is a source concern, not a verified product defect from a user-facing test.

Issue #388 preserves that window. The extracted module opens the radio and constructs the same four objects before entering the moved `try` block. A constructor failure therefore keeps the current process-exit cleanup behavior. Issues #389 and #390 may test rejected startup through established user-facing inputs. If a new test initially exposes this or another cleanup problem, the test owner must pause for developer assessment and leave any confirmed repair to a separate product ticket.

## Production CLI caller

The `serve` parser keeps all current validation and supplies the real serial factory. The following example omits only the unchanged parsing code:

```ts
const authentication = new PreSharedKeyAuthenticationPolicy(joinKey);
const membershipPath = option(argv, "--membership");
const common = {
  nodeID,
  profile,
  openRadio: () => MeshtasticSerialRadio.open(requiredOption(argv, "--serial")),
  port,
  frameEncoding,
  adaptiveRetries,
  stateDeltas
};
const running =
  mode === "gateway"
    ? await startLinkService({ ...common, mode, authentication, membershipPath })
    : await startLinkService({ ...common, mode, authentication });

console.log(
  JSON.stringify({
    listening: `http://${running.address.host}:${running.address.port}`,
    mode,
    node_id: nodeID
  })
);

try {
  await waitForShutdown();
} finally {
  await running.close();
}
```

This preserves the existing `serve` command, serial-path check, protected profile and key reads, late Gateway membership requirement, readiness JSON, and process-signal behavior.

## Laboratory process caller

Issues #389 and #390 own the concrete laboratory transport and process executable. Their compiled runner uses the same function and selects the existing stream-transport entry point. `openLaboratoryTransport` below is test-owned and must return the Meshtastic `Types.Transport` expected by `MeshtasticSerialRadio.openTransport`.

```ts
const authentication = new PreSharedKeyAuthenticationPolicy(joinKey);
const common = {
  nodeID,
  profile: createUSShortFastProfile(frequencySlot, testedFirmware),
  openRadio: () => MeshtasticSerialRadio.openTransport(openLaboratoryTransport),
  port: 0,
  frameEncoding: "canonical-json" as const
};
const running =
  mode === "gateway"
    ? await startLinkService({ ...common, mode, authentication, membershipPath: temporaryMembershipPath })
    : await startLinkService({ ...common, mode, authentication });

console.log(
  JSON.stringify({
    listening: `http://${running.address.host}:${running.address.port}`,
    mode,
    node_id: nodeID,
    profile: "SHORT_FAST",
    seed
  })
);

try {
  await waitForShutdown();
} finally {
  await running.close();
}
```

The laboratory transport must emulate the device messages needed by the production Meshtastic SDK adapter, including initial configuration, readback, configuration commits and reconnects, radio node identity, packet delivery, queue status, and disconnect. It may control failure timing and packet delivery, but assertions must use the loopback Link interface as their result.

## Evidence limits for the laboratory caller

The laboratory process exercises:

- The compiled shared lifecycle used by the CLI
- The Meshtastic SDK device protocol above `Types.Transport`
- Radio profile apply, reconnect, readback, and verification behavior supplied by `MeshtasticSerialRadio`
- Gateway membership activation and Asset authenticated joining
- `LinkRadioGate`, `LinkTransport`, `LinkService`, local HTTP, Shared Picture, application confirmation, and ordered cleanup

It bypasses:

- CLI argument parsing and the `MeshtasticSerialRadio.open` `/dev/cu.*` path guard
- `openSerialTransport`, `SerialPort`, baud-rate setup, USB open and close behavior, and device-frame parsing
- Physical Meshtastic firmware, real QueueStatus timing, RF airtime, contention, loss, relaying, range, and antenna behavior
- Actual macOS USB execution and any Linux or Windows serial-support claim

Existing CLI, device-framing, serial, radio-adapter, profile, joining, transport, and deterministic simulation tests keep their distinct protection. The lifecycle extraction must not replace them merely because the process acceptance is broader.

## Planned implementation checks after approval

Issue #388 may add focused tests for the exact shared interface and rewire the CLI after this decision is accepted. Those checks should cover both mode-specific startup paths, HTTP-before-preparation ordering, cleanup after failures inside the existing startup `try` region, aggregate cleanup failure, and unchanged CLI parsing and defaults. They must not turn the constructor-window concern into a repair. The work should run the Meshtastic Link workspace check and `git diff --check`.

Issues #389 and #390 add the user-facing compiled-process cases. On the first failure of any new user-facing case, they must preserve the exact revision, command, profile, seed, expected outcome, observed outcome, and artifacts, then pause that case for developer assessment. A confirmed product defect remains outside this prerequisite refactor and its test-only dependents.

No #388 implementation needs root manifests, the root lockfile, shared acceptance scripts, Core setup, or central workflows. The current #371 owner retains those files. The #391 owner retains portable CLI tests and its dedicated workflow. The later Link acceptance owner should coordinate a Link-specific workflow without editing another lane's active files.

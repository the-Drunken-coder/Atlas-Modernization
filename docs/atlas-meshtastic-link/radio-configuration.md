# Radio configuration ownership

Meshtastic Link manages the configuration of its attached Meshtastic radio. A compatible firmware image may begin with no Atlas-specific settings.

## Startup convergence

Before discovery or joining, the Runtime:

1. Connects to the local radio and reads firmware, hardware, local, module, security, and channel information.
2. Loads the one desired Radio profile for this Atlas mesh.
3. Compares only Atlas-owned fields with the actual radio settings.
4. Applies required changes in the fewest safe configuration writes.
5. Reconnects if Meshtastic reboots after configuration.
6. Reads the settings again and verifies convergence.
7. Proceeds to discovery and joining only after required settings match.

If the radio already matches, startup performs no configuration writes.

If required settings cannot be applied and verified, the Runtime stops before discovery, joining, or Atlas transmission. Status and diagnostics identify the desired value, actual value, attempted change, and Meshtastic response.

## Why Atlas owns the profile

Every radio runs behind the same Meshtastic Link Runtime. Owning the profile allows the system to tune range, airtime, relay behavior, update cadence, and application capacity as one controlled mesh instead of inheriting unrelated defaults or manual app configuration.

Experiments must change a reviewable profile and retain before-and-after configuration evidence. Field results can then be associated with the exact settings that produced them.

## Bandwidth-first development

The first supported development hardware is the Heltec WiFi LoRa 32 V3, commonly called Heltec V3. The normal application and traffic model use `SHORT_FAST`, not the range of `LONG_FAST`. `SHORT_TURBO` is an explicit maximum-capacity experiment rather than a hidden requirement.

The strategy is deliberate:

- Higher-power field hardware can improve link budget later without increasing modem bandwidth.
- A slower preset can trade unused bandwidth for more range after the system's measured traffic is known.
- Starting with a slow preset could hide application traffic that only becomes practical after moving to a faster modem profile.

The application protocol must remain independent of the selected preset. The Radio profile selects the performance envelope, and field evidence determines whether the normal preset moves toward more range or more capacity.

## Initial accepted settings

| Setting | Initial direction |
| --- | --- |
| Region | `US` |
| Modem preset | `SHORT_FAST` normally; `SHORT_TURBO` only when explicitly selected for an experiment |
| Hop limit | `3` |
| Device role | `CLIENT` on every radio |
| Rebroadcast mode | `LOCAL_ONLY` |
| Frequency slot | One explicit profile value; actual slot selected during lab setup |
| Transmit power | `0`, Meshtastic's normal legal hardware capability |
| Power saving | Disabled so the radio receives continuously |
| Remote administration | Disabled and out of scope |

The profile retains the same modem, channel, and application settings when the system moves to higher-power compatible radios.

## Channel layout

The common profile configures a known public Atlas rendezvous channel as primary. A new Asset broadcasts its custom Atlas discovery beacon there. The Gateway responds by direct message and runs authentication.

Successful joining installs membership material for the private shared Atlas channel in a secondary slot. Normal Atlas traffic uses the private channel. The Asset stops its public discovery beacon after joining.

The rendezvous channel remains configured after joining so every Runtime restart can repeat discovery. Asset Runtimes ignore unrelated public traffic after joining. The Gateway listens continuously for new structured Atlas discovery beacons.

Meshtastic-native position, telemetry, MQTT, and other unnecessary periodic application traffic are disabled. Required routing and NodeInfo behavior remain enabled. The structured Atlas discovery beacon is the only intentional public application broadcast.

## One profile for every radio

Every supported radio uses the same desired profile. There are no Gateway, Asset, or per-hardware overlays. Gateway and Asset behavior lives in the companion-computer software and does not change the radio's role or network settings.

A hardware model is supported only when it can satisfy the common profile. Hardware-specific identity, calibration, and GPIO values remain outside the profile rather than becoming overrides.

## Local ownership only

Each Runtime configures only its physically attached radio through the local Meshtastic client interface. The Gateway does not send remote administrative changes over the mesh, and peer Assets never configure each other.

Remote configuration is an explicit non-goal. A management operation that can change the modem, channel, or serial behavior must not depend on the same potentially flaky mesh that it could disconnect.

## Configuration interface

The Meshtastic Link tool exposes the same validated configuration system through:

- A command-line interface suitable for operators, scripts, and AI agents
- The Runtime's loopback-only programmatic API

The CLI is a thin client of the local Runtime. It does not open the serial port or mutate the radio behind the service's back.

The logical operations are:

- Show the desired Radio profile
- Read the actual attached-radio configuration
- Display the desired-to-actual difference
- Change a supported desired setting
- Apply pending desired changes
- Verify convergence
- Import or export a complete profile
- Read the before-and-after evidence from the last apply

Exact command names and API routes remain implementation details. Both surfaces use the same validation, apply, reboot recovery, verification, and evidence path.

Changing a desired setting and applying it are separate operations. A caller may change the desired profile, inspect the resulting diff, and explicitly apply it. Runtime startup automatically applies its selected profile.

The companion computer is the trust boundary. Local CLI and loopback API callers do not use a second authentication system, but every mutation remains validated and every apply produces evidence.

## Profile distribution

The normal Radio profile is version-controlled deployment configuration distributed with the companion-computer software. Updating the fleet means deploying the same new profile to each computer and allowing each Runtime to converge its local radio.

This is software and configuration distribution, not remote radio administration. A Runtime never reaches across the mesh to apply the profile elsewhere.

## Experiments

An experiment selects an explicit alternate profile. It does not edit the normal field profile as a hidden side effect. Evidence records:

- Complete selected profile and content fingerprint
- Desired-to-actual diff
- Before-and-after radio configuration
- Firmware and hardware identity
- Apply and verification results
- Field-run measurements associated with the profile

## Initial ownership categories

Atlas owns:

- Legal radio region selected by deployment configuration
- LoRa preset or explicit modem parameters
- Frequency slot and hop limit
- Device role and rebroadcast behavior
- Atlas rendezvous and shared channel layout
- Meshtastic-native position and telemetry behavior when it competes with Atlas publications
- Serial API availability required by the Runtime
- Modules that create unintended radio traffic

Atlas preserves by default:

- Meshtastic device public and private keys
- Hardware identity and capability information
- Hardware-specific GPIO and calibration values
- Settings outside the declared Radio profile

## Firmware boundary

The current scope begins after compatible Meshtastic firmware is installed. The Runtime reads and validates the firmware version and hardware capabilities but does not yet flash or upgrade firmware.

## Managed Mode

Meshtastic Managed Mode blocks ordinary client applications from writing configuration and requires a remote-admin path. The local Runtime is itself the intended configuration owner, so the initial Radio profile keeps Managed Mode disabled.

## Lab-selected details

- The actual explicit US frequency slot selected during lab setup
- Exact Meshtastic settings used to suppress each unnecessary native module without disrupting routing or NodeInfo

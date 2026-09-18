# Atlas Core operations

- [External ingress](EXTERNAL_INGRESS.md) explains how to put a separately managed reverse proxy or Cloudflare
  Tunnel in front of the packaged Core.
- [Releasing Atlas Core](RELEASING.md) covers requesting, publishing, and recovering releases through GitHub Actions, npm, and GHCR.

## Atlas Core TUI

- [Agreed design](TUI_REDESIGN.md) records the interaction and visual direction.
- [Implementation spec](TUI_REDESIGN_SPEC.md) points to the canonical GitHub specification.
- [Implementation issues](tui-redesign-tickets/README.md) list the canonical work and dependencies.
- [Design decision](../design-decisions/2026-09-12-atlas-core-tui-redesign.md) preserves the architectural and update-policy choices.

These documents describe the shipped TUI architecture and recovery contract. Core updates are backup-optional, while the
deployment runbook remains the recommended backup procedure. Receipt-bearing journals retain paired-restore recovery;
journals without a receipt must retry, move forward, or use the confirmed reset path supported by their evidence.

# Atlas Core operations

- [External ingress](EXTERNAL_INGRESS.md) explains how to put a separately managed reverse proxy or Cloudflare
  Tunnel in front of the packaged Core.
- [Releasing Atlas Core](RELEASING.md) covers the manual npm, GHCR, and GitHub release workflow.

## Planned TUI redesign

- [Agreed design](TUI_REDESIGN.md) records the interaction and visual direction.
- [Implementation spec](TUI_REDESIGN_SPEC.md) points to the canonical GitHub specification.
- [Implementation issues](tui-redesign-tickets/README.md) list the canonical work and dependencies.
- [Design decision](../design-decisions/2026-09-12-atlas-core-tui-redesign.md) preserves the architectural and update-policy choices.

These documents describe planned behavior. The current CLI still requires a validated paired backup for Core updates.

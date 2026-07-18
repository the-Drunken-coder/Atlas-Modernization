# Design Decision

1. **Time & Date:** 2026-07-04 America/New_York
2. **Name:** Core-owned operator authentication, not Cloudflare Access as a required dependency
3. **Context:** Atlas Core is often exposed through Cloudflare Tunnel in the current hosted setup, and Cloudflare Access could protect the operator-facing UI and API edge without Atlas storing operator passwords. That criticism was considered: Cloudflare Access is a competent solution for deployments that already depend on Cloudflare Zero Trust.
4. **Decision:** Atlas Core keeps first-party operator authentication for browser admins instead of requiring Cloudflare Access. Cloudflare Tunnel remains an optional public HTTPS edge, not the required identity provider for Atlas Core. Core must be deployable on a single host, behind another reverse proxy, on a private network, or in local/offline environments without any Cloudflare product in the control path.
5. **Alternatives considered:** Requiring Cloudflare Access in front of the Tunnel was rejected because it makes Cloudflare a hard runtime dependency for human login. It would remove some custom password/session code, but it would also make non-Cloudflare deployments second-class and force Core behavior to depend on Access headers, policies, and account configuration. Keeping only machine API keys was also rejected because the browser admin UI needs a human-authenticated path for API-key management and operational use.
6. **Consequences:**
   - Core owns operator password hashing, browser sessions, login throttling, and managed API-key administration.
   - Operators may still put Cloudflare Access, VPNs, private network ACLs, or another reverse proxy in front of Core as defense in depth.
   - Future agents should not remove Core-owned login/session code merely because the hosted deployment uses Cloudflare Tunnel.
   - Core should avoid adding Cloudflare-specific identity header assumptions to its required auth path.
   - API keys remain Atlas-owned machine credentials; Cloudflare service tokens can be layered outside Core, but they do not replace Atlas API-key metadata, revocation, or admin UI workflows by default.
7. **Location:** `atlas_core/internal/admin/`, `atlas_core/internal/api/handlers/handler_admin_auth.go`, `atlas_core/internal/api/handlers/handler_admin_api_keys.go`, `atlas_core/internal/api/middleware/middleware.go`, `atlas_core/docs/SECURITY.md`, `atlas_core/docs/DEPLOYMENT_RUNBOOK.md`, `atlas_command_interface/src/auth/`
8. **Notes:** This is an independence decision, not a claim that Cloudflare Access is weak or inappropriate. Access is acceptable as an optional outer gate for deployments that choose Cloudflare, but it is not the Atlas Core authentication boundary.

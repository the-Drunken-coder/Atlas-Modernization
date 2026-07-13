# Local Simulations Cannot Authenticate Against Default Development Core

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Default local Core and simulations authentication settings are incompatible
3. **Issue:** The documented local startup paths produce a reachable Core and simulations workbench, but the workbench cannot run a scenario because it has no usable machine credential.
4. **Severity:** S2 (Major)
5. **Location:** `Atlas_Core/docker/docker-compose.yml`, `Atlas_Core/internal/api/middleware/middleware.go`, `Atlas_Core/internal/api/handlers/handler_admin_api_keys.go`, `atlas_simulations/.env.example`, `atlas_simulations/README.md`
6. **Expected:** Following the documented local Core and simulations startup instructions should produce a workbench that can execute its shipped scenarios without an undocumented Core reconfiguration.
7. **Actual:** `python3 Atlas_Core/scripts/atlas.py --dev` starts Core with `ENABLE_API_AUTH=false`. Resource routes still require an admin session, while the simulations server authenticates with an API key. Managed API keys cannot be created while API-key authentication is disabled. The workbench health indicator says `Core reachable`, but starting `Moving assets` fails with `401 UNAUTHORIZED` and creates no resources.
8. **Reproduction:**
   1. Start Core with `python3 Atlas_Core/scripts/atlas.py --dev`
   2. Start the simulations server and UI using the values from `atlas_simulations/.env.example`
   3. Open `http://127.0.0.1:5174`
   4. Confirm the top bar reports `Core reachable`
   5. Start `Moving assets`
   6. Observe `Atlas request failed: 401 UNAUTHORIZED: Unauthorized`
9. **Notes:** Enabling API-key authentication with a strong bootstrap key and restarting the simulations server with that key made all three shipped scenarios pass: `Moving assets` 2/2, `Observations and objects` 3/3, and `Multi-client sync` 8/8. The problem is the default/documented integration path, not scenario behavior.

# Existing Development Volumes Can Prevent One-Command Startup

1. **Time & Date:** 2026-07-12T22:15:00-04:00
2. **Name:** Generated Compose credentials can drift from an existing Postgres volume
3. **Issue:** The normal development launcher can generate or load credentials that do not match the password stored in an existing development Postgres volume.
4. **Severity:** S4 (Minor)
5. **Location:** `Atlas_Core/scripts/atlas.py`, `Atlas_Core/scripts/compose_env.py`, `Atlas_Core/docker/.env`, `Atlas_Core/docker/docker-compose.yml`
6. **Expected:** `python3 Atlas_Core/scripts/atlas.py --dev` should either start the existing development stack or stop quickly with a precise stale-credential recovery instruction.
7. **Actual:** PostgreSQL became healthy, but Core exited with `password authentication failed for user "atlas"`. The launcher continued polling API readiness until interrupted. The documented `--reset-volumes` recovery succeeded, but destroys the local development volumes.
8. **Reproduction:**
   1. Retain a development Postgres volume initialized with an older password
   2. Change or regenerate `POSTGRES_PASSWORD` in `Atlas_Core/docker/.env`
   3. Run `python3 Atlas_Core/scripts/atlas.py --dev`
   4. Observe PostgreSQL report healthy while Core exits on password authentication failure
   5. Observe the launcher continue its generic API readiness retries
9. **Notes:** `python3 Atlas_Core/scripts/atlas.py --dev --reset-volumes` restored the local stack and is already documented in the command-interface README. A clearer fail-fast diagnosis would reduce destructive troubleshooting and startup time.

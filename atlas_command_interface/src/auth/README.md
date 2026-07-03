# Browser Auth UI

This folder only owns the React login gate and auth-specific styles for the command interface.

Atlas Core owns authentication, sessions, throttling, and admin storage under `/admin/*`. The browser uses `AtlasAdminClient` with `credentials: "include"` to call:

- `POST /admin/auth/login`
- `POST /admin/auth/logout`
- `GET /admin/auth/me`
- `/admin/api-keys` key-management routes

Do not reintroduce Worker sessions, `/auth/*`, `/admin/api-keys/*`, `/me/settings`, or `/atlas/*` proxy behavior here. Admin APIs are intentionally separate from the Atlas resource SDK surface so entities, objects, tasks, queries, sync, and feed stay operational-resource-only.

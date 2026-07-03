# Atlas Map Console UI Plan

> Historical note: browser auth and Core access have moved since this plan was written. The Worker now hosts static assets and `GET /api/config` only; browser auth is owned by Atlas Core under `/admin/auth/*`; the browser SDK calls Core directly with `credentials: "include"`; command validation belongs to Core `POST /tasks`, not the Worker or UI.

## Purpose

Build the first Atlas web interface as an operator-facing map console. The first real user is the project owner, but the product role is a hybrid operator and commander overview user. For this system, those jobs are close enough that the UI should serve both without splitting into separate modes.

The first workflow is intentionally narrow:

1. See assets, tracks, and geofeatures on the map.
2. Select one item from the map or sidebar.
3. Inspect status, location, last update, task linkage, and debug data.
4. Send commands to the selected asset.

This should feel like a dark tactical map console: closer to Anduril Lattice / ATAK layout logic and ArduPilot operational density than a generic SaaS admin dashboard. The interface should be polished enough to use directly, but it should also expose enough JSON/debug detail to make future agent and developer debugging easy.

## Routing

- Add the real app surface at `/map`.
- Add `/home` as a redirect to `/map`.
- Treat `/map` as the primary and only application workspace for the first implementation.
- Do not create a marketing landing page or multi-page shell yet.

## Package Placement

The UI work belongs to this interface package. The current package already owns the thin Worker/static host and command model helpers, so the web app should grow from here unless a later split becomes clearly necessary.

Recommended structure:

```text
atlas_command_interface/
  src/
    atlas/
      command-model.ts
      command-targeting.ts
    app/
      routes.tsx
      providers.tsx
    ui/
      tokens.css
      primitives/
      layout/
      map/
    features/
      assets/
      tracks/
      geofeatures/
      commands/
      debug/
  worker/
    index.ts
```

The exact file names can shift during implementation, but keep these boundaries:

- `worker/` remains the Cloudflare Worker/static host and browser config endpoint.
- `src/atlas/` owns reusable Atlas command/catalog/data helpers.
- `src/ui/` owns the local design system and shared UI primitives.
- `src/features/` owns feature-specific screens and panels.

Do not create a separate `atlas_ui/` package yet. Keep the design system app-local until there is a second real consumer.

## Application Architecture

Use:

- React + TypeScript.
- Vite for the browser app.
- MapLibre GL JS for map rendering, with same-origin map styles and tiles served
  by the command-interface Worker.
- The existing Atlas SDK for Atlas Core data access.
- Core direct browser access through the Atlas SDK with `credentials: "include"`.
- Worker route:
  - `/api/config`
  - `/maps/styles/:sourceId.json`
  - `/maps/tiles/:sourceId/:z/:x/:y.:ext`

The Worker should not proxy Atlas Core or own browser authentication. It serves the app, non-secret browser config, and map provider requests that need server-side secret injection.

Initial data load should come from Atlas Core query/list endpoints through the SDK. Live updates should use the Core feed through the SDK where practical, with refresh/recovery through normal Core queries.

## Layout

The layout is left-to-right:

```text
+---------------------------+-----------------------------------+
| collapsible rail/sidebar  | map                               |
|                           |                                   |
| icon rail                 | assets / tracks / geofeatures     |
| list or inspector panel   | right-click command menu          |
| command/task/debug panels | geofeature editing overlays       |
+---------------------------+-----------------------------------+
```

The map is the primary workspace. The sidebar is support UI.

### Sidebar States

The sidebar has two widths:

- Collapsed: icon rail only, always visible.
- Expanded: rail plus list or inspector content.

Collapsed behavior:

- Show icons only.
- Do not expand on hover.
- On icon hover, show a small tooltip such as `Assets`, `Tracks`, `Geo Features`, or `Commands`.

Expanded behavior:

- Clicking an icon opens the relevant list mode.
- List modes: assets, tracks, geofeatures, commands.
- Selecting an item from a list or from the map switches the sidebar to inspector mode for that selected item.
- A back control in inspector mode returns to the previous list mode.

Selection behavior:

- Single selection only, permanently.
- Do not add multi-select affordances.
- The selected item may be an asset, track, or geofeature.
- Only assets can receive commands.

### Inspector Behavior

The inspector should adapt to the selected item type.

Asset inspector:

- Alias/name and ID.
- Status summary.
- Location and movement data when available.
- Last update / heartbeat recency.
- Communications link state.
- Battery/health.
- Current task and queued tasks.
- Supported commands.
- Per-selected-asset task history.
- Collapsible raw JSON/debug drawer.

Track inspector:

- Alias/name and ID.
- Location and movement data when available.
- Last update.
- Classification if available.
- Read-only raw JSON/debug drawer.
- No command submit controls.

Geofeature inspector:

- Alias/name and ID.
- Geometry type.
- Geometry summary.
- Classification/custom metadata if available.
- Edit controls.
- Save/cancel controls while editing.
- Raw JSON/debug drawer.

## Entity Types And Map Display

Use existing Atlas entity types:

- `asset`
- `track`
- `geofeature`

Assets:

- Render from telemetry location when present.
- Prefer geometry point only if telemetry location is absent and geometry is usable.
- Show heading/speed if present.
- Support selection from marker or list.

Tracks:

- Render from telemetry or geometry.
- Selectable but read-only.
- Do not support commands.

Geofeatures:

- Render Point, LineString, and Polygon.
- Selectable.
- Editable.
- Use GeoJSON geometry as the preferred UI editing shape.

## Geofeature Editing

Support Point, LineString, and Polygon in the first implementation.

Required edit behavior:

- Select geofeature.
- Enter edit mode from the geofeature inspector.
- Show draggable vertices.
- Drag vertices to update geometry.
- Add vertices for LineString and Polygon.
- Remove vertices while preserving valid geometry.
- Save writes the updated entity geometry to Atlas Core.
- Cancel restores the last saved geometry.

Geometry validity:

- Point has one coordinate.
- LineString has at least two coordinates.
- Polygon has at least one closed ring with at least four coordinates, including the repeated closing coordinate.
- Coordinates should use GeoJSON order: `[longitude, latitude]`.

Do not make tracks editable in this UI.

## Command Model

Commands come from the Atlas command catalog.

Position-based command rule:

- A command is position-based when its `parameters_schema` includes required numeric `latitude` and `longitude` parameters.

Normalize map-point commands to `latitude` and `longitude`. The current catalog has `move_to_location` using `latitude`/`longitude`, while `goto` uses `lat`/`lon`; implementation should update `goto` to `latitude`/`longitude` rather than supporting both names.

Add command helper behavior in the command model layer rather than duplicating this logic in React components:

- Identify command targeting: `map_point` or `none`.
- Determine whether an entity supports a command through `components.task_catalog.supported_tasks`.
- Produce disabled-command reasons suitable for tooltips.
- Separate valid commands from invalid commands while preserving a stable order.

## Command UI

There are two command entry points.

### Sidebar Commands

Use the sidebar command menu for non-position commands.

Behavior:

- Requires a selected asset.
- Shows non-position commands.
- Valid commands appear first.
- Unsupported or otherwise invalid commands appear at the bottom, greyed out and not selectable.
- Hovering a disabled command shows why it is unavailable.
- If a valid command requires additional parameters, show a compact command form before submit.

### Map Right-Click Commands

Use the map context menu for position-based commands.

Flow:

1. Select an asset.
2. Right-click on the map.
3. Choose a position-based command.

Behavior:

- If no asset is selected, the command menu should not offer asset commands.
- Right-click coordinate fills `latitude` and `longitude`.
- Additional required parameters are requested in a compact form.
- Valid commands appear first.
- Disabled commands appear at the bottom with hover reasons.

### Command Submission

Command submission creates a task directly through Core `POST /tasks`.

The UI should not invent local success state. Once a command is submitted, Atlas Core creates a task. The UI should read task status from Atlas Core and display that status.

Task statuses are:

- `pending`
- `acknowledged`
- `completed`
- `failed`
- `cancelled`

Show command/task history for the selected asset only. Do not add a global recent command log yet.

## Status Model

Use existing Atlas Core/protocol fields.

Task status:

- Use the five Core task statuses listed above.
- Status color and labels can be standardized in the UI immediately.

Asset/entity status:

- `components.status.value` is currently a free-form string, not a fixed enum.
- Do not invent a permanent status taxonomy yet.
- Treat richer asset status semantics as to be determined.

Structured asset indicators to show now:

- `components.communications.link_state`
  - `connected`
  - `disconnected`
  - `degraded`
  - `unknown`
- `components.heartbeat.last_seen`
- `components.health.battery_percent`
- `components.task_queue.current_task_id`
- `components.task_queue.queued_task_ids`
- `components.telemetry`

## Visual Style

The UI is dark-only. Do not implement light mode.

Design principles:

- Tactical, dense, and operational.
- Map-first.
- Docked panels, not floating windows.
- Compact controls.
- Clear selected state.
- Clear stale/offline/degraded indicators.
- Minimal modal use.
- Debug detail available but not visually dominant.

Use semantic design tokens:

- Backgrounds.
- Panel surfaces.
- Borders.
- Text levels.
- Accent color.
- Warning/error/success/info.
- Task status colors.
- Link state colors.
- Map overlay colors.
- Selection and hover states.

Do not scatter raw color literals through feature components.

Standard UI pieces to build early:

- Icon button.
- Tooltip.
- Text field.
- Select.
- Menu/context menu.
- Sidebar rail.
- Sidebar panel.
- Inspector panel.
- Status pill.
- Task row.
- Command row.
- JSON/debug drawer.
- Map marker.
- Geofeature vertex handle.

## Debug And JSON Visibility

Raw protocol data should be available because this system is young and agent/debug workflows matter.

Default behavior:

- Keep JSON/debug collapsed by default.
- Put it inside the selected-item inspector.
- Make it easy to copy selected JSON.
- Show task payloads and command parameters for selected-asset task history.

Do not make raw JSON the main content unless the selected item has no better structured view.

## Implementation Sequence

1. Add Vite/React app scaffolding inside `atlas_command_interface`.
2. Add `/home` redirect and `/map` route.
3. Add design tokens and base layout: icon rail, collapsible sidebar, map region.
4. Add `/api/config` app config consumption.
5. Load initial entities and render assets, tracks, and geofeatures on MapLibre.
6. Implement single-selection state across map and sidebar.
7. Implement list mode and inspector mode.
8. Add status/task/link/heartbeat/battery display.
9. Add command targeting helpers and normalize map-point catalog parameters.
10. Add sidebar non-position command flow.
11. Add map right-click position command flow.
12. Add per-selected-asset task history from Core.
13. Add geofeature editing for Point, LineString, and Polygon.
14. Add JSON/debug drawer.
15. Add component-level tests and browser smoke tests.

## Testing Plan

Command model tests:

- `latitude` + `longitude` required numeric parameters produce `map_point`.
- Commands without both fields produce `none`.
- Entity-supported commands are enabled.
- Unsupported commands are disabled with a tooltip-ready reason.
- `goto` uses normalized `latitude`/`longitude`.

Sidebar/state tests:

- `/home` redirects to `/map`.
- Collapsed rail shows only icons.
- Icon hover shows tooltip text.
- Clicking a rail item opens list mode.
- Selecting an item switches to inspector mode.
- Selection remains single-select.

Map tests:

- Map renders.
- Assets render from telemetry.
- Tracks render read-only.
- Geofeatures render Point, LineString, and Polygon.
- Selecting a marker opens inspector.
- Right-click with selected asset opens position command menu.

Command flow tests:

- Sidebar shows non-position commands.
- Map context menu shows position commands.
- Disabled commands are greyed out and not selectable.
- Disabled command hover explains why.
- Submitting a command posts to Core `POST /tasks`.
- Created task appears as `pending` from Core response/task fetch.

Geofeature editing tests:

- Point vertex drag updates coordinate preview.
- LineString vertex add/remove/drag preserves valid geometry.
- Polygon vertex add/remove/drag preserves closed ring.
- Save sends updated geometry.
- Cancel restores previous geometry.

Existing package checks should continue to pass:

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
```

Add new app-specific build, unit, component, and browser smoke commands as the app scaffolding is introduced.

## Explicit Non-Goals For First Implementation

- No light mode.
- No multi-select.
- No global command history.
- No role/permission gating.
- No simulated-vs-real asset distinction yet.
- No separate commander/operator modes.
- No floating window manager.
- No track editing.
- No compatibility shim for `lat`/`lon` command parameters.

## Open Items To Decide Later

- Exact online tile provider/style URL.
- Exact icon set.
- Exact tactical color palette.
- Asset status taxonomy beyond existing free-form `components.status.value`.
- Whether geofeature metadata editing should include custom fields beyond geometry.

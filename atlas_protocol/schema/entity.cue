package atlasprotocol

import (
	components "github.com/the-drunken-coder/atlas/atlas_protocol/schema/components"
	shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"
)

#KnownEntityComponents: [
	"telemetry",
	"geometry",
	"task_catalog",
	"media_refs",
	"mil_view",
	"health",
	"sensor_refs",
	"communications",
	"task_queue",
	"status",
	"heartbeat",
]

#TelemetryComponent:      components.#TelemetryComponent
#GeometryComponent:       components.#GeometryComponent
#TaskCatalogComponent:    components.#TaskCatalogComponent
#MediaRefsComponent:      components.#MediaRefsComponent
#MilViewComponent:        components.#MilViewComponent
#HealthComponent:         components.#HealthComponent
#SensorRefsComponent:     components.#SensorRefsComponent
#CommunicationsComponent: components.#CommunicationsComponent
#TaskQueueComponent:      components.#TaskQueueComponent
#StatusComponent:         components.#StatusComponent
#HeartbeatComponent:      components.#HeartbeatComponent
#EntityComponents: {
	telemetry?:      components.#TelemetryComponent
	geometry?:       components.#GeometryComponent
	task_catalog?:   components.#TaskCatalogComponent
	media_refs?:     components.#MediaRefsComponent
	mil_view?:       components.#MilViewComponent
	health?:         components.#HealthComponent
	sensor_refs?:    components.#SensorRefsComponent
	communications?: components.#CommunicationsComponent
	task_queue?:     components.#TaskQueueComponent
	status?:         components.#StatusComponent
	heartbeat?:      components.#HeartbeatComponent
	[=~"^custom_"]:  #JSONValue
}

#EntityBlob: {
	components?:   #EntityComponents
	published_at?: shared.#RFC3339Timestamp
	[string]:      #JSONValue
}

#Meta: {
	entityComponentKeys: #KnownEntityComponents
	taskComponentKeys:   #KnownTaskComponents
	geoJSONTypes: ["Point", "LineString", "Polygon"]
	maxGeometryPositions: shared.#PositionLimit
}

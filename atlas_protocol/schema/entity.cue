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
	telemetry?:      #TelemetryComponent
	geometry?:       #GeometryComponent
	task_catalog?:   #TaskCatalogComponent
	media_refs?:     #MediaRefsComponent
	mil_view?:       #MilViewComponent
	health?:         #HealthComponent
	sensor_refs?:    #SensorRefsComponent
	communications?: #CommunicationsComponent
	task_queue?:     #TaskQueueComponent
	status?:         #StatusComponent
	heartbeat?:      #HeartbeatComponent
	[=~"^custom_"]:  shared.#JSONValue
}

#EntityBlob: {
	components?:   #EntityComponents
	published_at?: shared.#RFC3339Timestamp
	[string]:      shared.#JSONValue
}

#Meta: {
	entityComponentKeys: #KnownEntityComponents
	taskComponentKeys:   #KnownTaskComponents
	geoJSONTypes: ["Point", "LineString", "Polygon"]
	maxGeometryPositions: shared.#PositionLimit
}

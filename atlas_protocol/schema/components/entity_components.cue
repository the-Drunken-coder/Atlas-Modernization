package components

import shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"

#MediaRole: "camera_feed" | "thumbnail" | "heatmap_data"

#Classification: "friendly" | "hostile" | "neutral" | "unknown" | "civilian"

#LinkState: "connected" | "disconnected" | "degraded" | "unknown"

#TaskCatalogComponent: close({
	supported_tasks?: [...shared.#NonEmptyString]
})

#MediaRef: close({
	object_id!: shared.#NonEmptyString
	role!:      #MediaRole
})

#MediaRefsComponent: [...#MediaRef]

#MilViewComponent: close({
	classification?: #Classification
	last_seen?:      shared.#RFC3339Timestamp
})

#HealthComponent: close({
	battery_percent?: shared.#FiniteNumber & >=0 & <=100
})

#SensorRef: close({
	sensor_id!:              shared.#NonEmptyString
	type!:                   shared.#NonEmptyString
	horizontal_fov?:         shared.#FiniteNumber
	vertical_fov?:           shared.#FiniteNumber
	horizontal_orientation?: shared.#FiniteNumber
	vertical_orientation?:   shared.#FiniteNumber
})

#SensorRefsComponent: [...#SensorRef]

#CommunicationsComponent: close({
	link_state?: #LinkState
})

#TaskQueueComponent: close({
	current_task_id?: shared.#NonEmptyString | null
	queued_task_ids?: [...shared.#NonEmptyString]
})

#StatusComponent: close({
	value!:        shared.#NonEmptyString
	last_update?: shared.#RFC3339Timestamp
})

#HeartbeatComponent: close({
	last_seen!: shared.#RFC3339Timestamp
})

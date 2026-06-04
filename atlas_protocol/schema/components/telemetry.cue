package components

import shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"

#TelemetryComponent: close({
	latitude?:    shared.#Latitude
	longitude?:   shared.#Longitude
	altitude_m?:  shared.#FiniteNumber
	speed_m_s?:   shared.#FiniteNumber & >=0
	heading_deg?: shared.#FiniteNumber & >=0 & <360
	last_update?: shared.#RFC3339Timestamp
})

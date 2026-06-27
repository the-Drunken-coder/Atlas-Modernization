package components

import (
	"list"

	shared "github.com/the-drunken-coder/atlas/atlas_protocol/schema/shared"
)

#GeoJSONPoint: close({
	type!:        "Point"
	coordinates!: shared.#GeoJSONPosition
})

#GeoJSONLineString: close({
	type!:        "LineString"
	coordinates!: [...shared.#GeoJSONPosition] & list.MinItems(2) & list.MaxItems(shared.#PositionLimit)
})

#GeoJSONPolygon: close({
	type!:          "Polygon"
	coordinates!:   [...([...shared.#GeoJSONPosition] & list.MinItems(4))] & list.MinItems(1)
	_positions:     list.Concat(coordinates) & list.MaxItems(shared.#PositionLimit)
	_closedRings:   [for ring in coordinates {ring[0] == ring[len(ring)-1]}]
	_closedRingsOK: list.MatchN(_closedRings, len(coordinates), true) & true
})

#CircleProperties: close({
	shape!:    "circle"
	radius_m!: shared.#FiniteNumber & >0
})

#GeoJSONCircleFeature: close({
	type!:       "Feature"
	geometry!:   #GeoJSONPoint
	properties!: #CircleProperties
})

#GeometryComponent: #GeoJSONPoint | #GeoJSONLineString | #GeoJSONPolygon | #GeoJSONCircleFeature

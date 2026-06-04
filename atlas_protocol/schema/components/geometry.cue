package components

import (
	"list"
	"struct"

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

#AtlasGeometry: close({
	point_lat?: shared.#Latitude
	point_lng?: shared.#Longitude
	radius_m?:  shared.#FiniteNumber & >0
	line?:      shared.#NonEmptyLine
	polygon?:   shared.#AtlasPolygon

	if point_lat != _|_ {
		point_lng!: shared.#Longitude
	}
	if point_lng != _|_ {
		point_lat!: shared.#Latitude
	}
	if radius_m != _|_ {
		point_lat!: shared.#Latitude
		point_lng!: shared.#Longitude
	}
}) & struct.MinFields(1)

#GeometryComponent: #GeoJSONPoint | #GeoJSONLineString | #GeoJSONPolygon | #AtlasGeometry

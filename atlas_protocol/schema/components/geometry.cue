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
	type!:        "Polygon"
	coordinates!: [...([...shared.#GeoJSONPosition] & list.MinItems(4))] & list.MinItems(1)
})

#AtlasGeometry: close({
	point_lat?: shared.#Latitude
	point_lng?: shared.#Longitude
	radius_m?:  shared.#FiniteNumber & >0
	line?:      shared.#NonEmptyLine
	polygon?:   shared.#AtlasPolygon
}) & ({
	point_lat!: _
} | {
	point_lng!: _
} | {
	radius_m!: _
} | {
	line!: _
} | {
	polygon!: _
})

#GeometryComponent: #GeoJSONPoint | #GeoJSONLineString | #GeoJSONPolygon | #AtlasGeometry

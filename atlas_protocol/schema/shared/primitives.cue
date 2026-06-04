package shared

import "list"

#JSONValue: null | bool | string | number | [...#JSONValue] | {
	[string]: #JSONValue
}

#NonEmptyString: string & =~"\\S"
#RFC3339Timestamp: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"

#FiniteNumber: number

#Latitude:  #FiniteNumber & >=-90 & <=90
#Longitude: #FiniteNumber & >=-180 & <=180

#PositionLimit: 10000

#GeoJSONPosition: [#Longitude, #Latitude, ...#FiniteNumber]
#AtlasPosition:   [#Latitude, #Longitude]

#NonEmptyLine: [...#AtlasPosition] & list.MinItems(2) & list.MaxItems(#PositionLimit)
#AtlasPolygon: [...#AtlasPosition] & list.MinItems(3) & list.MaxItems(#PositionLimit)

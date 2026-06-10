package shared

import (
	"list"
	"time"
)

#JSONValue: null | bool | string | number | [...#JSONValue] | {
	[string]: #JSONValue
}

#NonEmptyString: string & =~"\\S"
#RFC3339Timestamp: string & time.Format(time.RFC3339)

#FiniteNumber: number

#Latitude:  #FiniteNumber & >=-90 & <=90
#Longitude: #FiniteNumber & >=-180 & <=180

#PositionLimit: 10000

#GeoJSONPosition: [#Longitude, #Latitude, ...#FiniteNumber]
#AtlasPosition:   [#Latitude, #Longitude]

#NonEmptyLine: [...#AtlasPosition] & list.MinItems(2) & list.MaxItems(#PositionLimit)
#AtlasPolygon: [...#AtlasPosition] & list.MinItems(3) & list.MaxItems(#PositionLimit)

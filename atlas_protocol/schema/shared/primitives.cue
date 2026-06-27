package shared

import (
	"time"
)

#JSONValue: null | bool | string | number | [...#JSONValue] | {
	[string]: #JSONValue
}

#NonEmptyString: string & =~"\\S"
#RFC3339Timestamp: string & time.Format(time.RFC3339)
#ProtocolRevision: string & =~"^sha256:[A-Fa-f0-9]{64}$"

#FiniteNumber: number

#Latitude:  #FiniteNumber & >=-90 & <=90
#Longitude: #FiniteNumber & >=-180 & <=180

#PositionLimit: 10000

#GeoJSONPosition: [#Longitude, #Latitude, ...#FiniteNumber]
